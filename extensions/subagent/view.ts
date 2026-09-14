import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
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
export function createProgressView(pi: ExtensionAPI) {
  const sidebar = new Sidebar();
  let latest: ProgressSnapshot | undefined;
  let context: ExtensionContext | undefined;
  let refreshInspector: (() => void) | undefined;
  let closeInspector: (() => void) | undefined;
  let closed = false;
  const render = () => {
    if (closed || !context?.hasUI || !latest) return;
    if (refreshInspector) { refreshInspector(); return; }
    const snapshot = latest;
    const rows = [...snapshot.tasks].sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null)).slice(0, 3);
    const lines = [progressLines(snapshot)[0], ...rows.flatMap((row) => [taskLine(row, snapshot.updatedAt),
      `  ${row.model} | ${row.activity} | ${row.usage.direct.usage.input + row.usage.direct.usage.output} in+out tok | ${row.todos === null ? 'no todos yet' : `${row.todos.filter((item) => item.startsWith('[done] ')).length}/${row.todos.length} todos`}`]),
      `${snapshot.tasks.length > 3 ? `Showing 3/${snapshot.tasks.length}. ` : ''}/subagents: tasks, messages, checklists, full usage | Esc: stop batch`];
    context.ui.setWidget('pstack-subagents', (_tui, theme) => ({
      render: (width) => lines.map((line, index) => theme.fg(index === 0 ? 'accent' : /QUIET|LONG RUN|UNEXPECTED|UNVERIFIED/.test(line) ? 'warning' : 'muted', clip(line, width))),
      invalidate() {},
    }));
  };
  pi.registerCommand('subagents', { description: 'Inspect live subagent tasks, checklists, messages, and usage', handler: async (_args, ctx) => {
    if (!latest) { ctx.ui.notify('No subagent request yet.', 'info'); return; }
    if (ctx.mode !== 'tui') { ctx.ui.notify(progressLines(latest, true).join('\n'), 'info'); return; }
    if (closeInspector) return;
    ctx.ui.setWidget('pstack-subagents', undefined);
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
    render();
  } });
  return {
    publish(snapshot: ProgressSnapshot, ctx: ExtensionContext) { latest = snapshot; context = ctx; render(); if (ctx.hasUI) sidebar.publish(snapshot); },
    async close() { closed = true; closeInspector?.(); if (context?.hasUI) context.ui.setWidget('pstack-subagents', undefined); await sidebar.close(); },
  };
}
