import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { keyText, truncateHead, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { clip, progressLines, taskLine, type ProgressSnapshot } from './progress.ts';

export function cmuxCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('cmux', args, { timeout: 750, killSignal: 'SIGKILL', maxBuffer: 8192 }, (error) => error ? reject(error) : resolve());
  });
}
export class Sidebar {
  readonly #workspace: string | undefined;
  readonly #key = `pstack-${randomUUID()}`;
  readonly #command: typeof cmuxCommand;
  #pending: ProgressSnapshot | undefined;
  #running: Promise<void> | undefined;
  #keys = new Set<string>();
  #closed = false;
  #failed = false;
  constructor(workspace = process.env.CMUX_WORKSPACE_ID, command = cmuxCommand) { this.#workspace = workspace; this.#command = command; }
  publish(snapshot: ProgressSnapshot): void {
    if (!this.#workspace || this.#closed || this.#failed) return;
    this.#pending = snapshot;
    this.#running ??= this.#drain().finally(() => { this.#running = undefined; });
  }
  async #drain(): Promise<void> {
    try {
      while (this.#pending && !this.#closed) {
        const snapshot = this.#pending;
        this.#pending = undefined;
        for (const row of snapshot.tasks) {
          if (this.#closed) break;
          const key = `${this.#key}-${row.index}`;
          this.#keys.add(key);
          const next = row.todos?.find((item) => !item.startsWith('[done] '));
          await this.#command(['set-status', key, `${taskLine(row, snapshot.updatedAt)} | ${row.model} | ${row.activity}${next ? ` | next: ${next}` : ''}`, '--workspace', this.#workspace!]);
        }
        for (const key of this.#keys) if (Number(key.split('-').at(-1)) >= snapshot.tasks.length) {
          await this.#command(['clear-status', key, '--workspace', this.#workspace!]);
          this.#keys.delete(key);
        }
      }
    } catch { this.#failed = true; }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#pending = undefined;
    await this.#running;
    for (const key of this.#keys) {
      try { await this.#command(['clear-status', key, '--workspace', this.#workspace!]); } catch { /* cmux may already be closed. */ }
    }
    this.#keys.clear();
  }
}
export const renderProgressResult: NonNullable<ToolDefinition['renderResult']> = (result, { expanded, isPartial }, theme) => {
  const details = result.details;
  const card = details && typeof details === 'object' && 'progressCard' in details ? details.progressCard : undefined;
  const output = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (!card || typeof card !== 'object' || !('version' in card) || card.version !== 1 || !('lines' in card)
    || !Array.isArray(card.lines) || card.lines.length > 33 || !card.lines.every((line) => typeof line === 'string' && Buffer.byteLength(line) <= 512)) {
    return new Text(output, 0, 0);
  }
  const lines = card.lines.map((line: string, index: number) => theme.fg(
    index === 0 ? 'accent' : /QUIET|LONG RUN|UNEXPECTED|UNVERIFIED/.test(line) ? 'warning' : 'toolOutput',
    stripVTControlCharacters(line).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')));
  if (isPartial) lines.push(theme.fg('dim', `${keyText('app.interrupt')}: stop batch | /subagents: full checklists`));
  else {
    const preview = expanded ? output : truncateHead(output, { maxLines: 5, maxBytes: 1024 }).content;
    lines.push('', theme.fg('dim', 'Output'), preview);
    if (!expanded) lines.push(theme.fg('dim', `${keyText('app.tools.expand')}: full output`));
  }
  return new Text(lines.join('\n'), 0, 0);
};

export function createProgressView(pi: ExtensionAPI) {
  const sidebar = new Sidebar();
  let latest: ProgressSnapshot | undefined;
  let refreshInspector: (() => void) | undefined;
  let closeInspector: (() => void) | undefined;
  let closed = false;
  pi.registerCommand('subagents', { description: 'Inspect live subagent tasks, checklists, messages, and usage', handler: async (_args, ctx) => {
    if (!latest) { ctx.ui.notify('No subagent request yet.', 'info'); return; }
    if (ctx.mode !== 'tui') { ctx.ui.notify(progressLines(latest, true).join('\n'), 'info'); return; }
    if (closeInspector) return;
    await ctx.ui.custom((_tui, theme, _keys, done) => {
      let offset = 0;
      refreshInspector = () => _tui.requestRender();
      closeInspector = () => done(undefined);
      return {
        render(width) {
          const lines = progressLines(latest!, true);
          const height = Math.max(1, (process.stdout.rows ?? 24) - 8);
          offset = Math.min(offset, Math.max(0, lines.length - height));
          return [theme.fg('accent', clip('SUBAGENTS | j/k scroll | q/Esc close; Esc again in parent stops work', width)),
            ...lines.slice(offset, offset + height).map((line) => clip(line, width)),
            theme.fg('dim', clip(`${offset + 1}-${Math.min(offset + height, lines.length)} / ${lines.length} lines`, width))];
        },
        handleInput(data) {
          if (data === 'q' || data === '\u001b' || data === '\u0003') done(undefined);
          if (data === 'j' || data === '\u001b[B') offset++;
          if (data === 'k' || data === '\u001b[A') offset = Math.max(0, offset - 1);
          _tui.requestRender();
        },
        invalidate() {},
      };
    });
    refreshInspector = undefined;
    closeInspector = undefined;
  } });
  return {
    publish(snapshot: ProgressSnapshot, ctx: ExtensionContext) {
      if (closed) return;
      latest = snapshot;
      refreshInspector?.();
      if (ctx.hasUI) sidebar.publish(snapshot);
    },
    async close() { closed = true; closeInspector?.(); await sidebar.close(); },
  };
}
