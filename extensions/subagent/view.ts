import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { keyText, truncateHead, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text, matchesKey, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clip, inlineTasks, plain, progressCard, progressLines, taskLine, type ProgressSnapshot } from './progress.ts';

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
  readonly #keys = new Set<string>();
  #closing: Promise<void> | undefined;
  #closed = false;
  #failed = false;
  constructor(workspace = process.env.CMUX_WORKSPACE_ID, command = cmuxCommand) { this.#workspace = workspace; this.#command = command; }
  publish(snapshot: ProgressSnapshot): void {
    if (!this.#workspace || this.#closed || this.#failed) return;
    this.#pending = structuredClone(snapshot);
    this.#start();
  }
  #start(): void {
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#pending && !this.#closed && !this.#failed) this.#start();
    });
  }
  async #drain(): Promise<void> {
    try {
      while (this.#pending && !this.#closed) {
        const snapshot = this.#pending;
        this.#pending = undefined;
        const currentKeys = new Set<string>();
        for (const row of inlineTasks(snapshot)) {
          if (this.#closed) break;
          const key = `${this.#key}-${row.index}`;
          currentKeys.add(key);
          this.#keys.add(key);
          const next = row.todos?.find((item) => !item.startsWith('[done] '));
          const status = plain(`${taskLine(row, snapshot.endedAt ?? snapshot.updatedAt)} | ${row.observedModel ?? row.model} | ${row.activity}${next ? ` | next: ${next}` : ''}`, 600);
          await this.#command(['set-status', key, status, '--workspace', this.#workspace!]);
        }
        if (this.#closed) break;
        for (const key of this.#keys) if (!currentKeys.has(key)) {
          await this.#command(['clear-status', key, '--workspace', this.#workspace!]);
          this.#keys.delete(key);
        }
      }
    } catch {
      this.#failed = true;
      this.#pending = undefined;
      await this.#clearKeys();
    }
  }
  close(): Promise<void> {
    this.#closed = true;
    this.#pending = undefined;
    return this.#closing ??= this.#clear();
  }
  async #clear(): Promise<void> {
    await this.#running;
    await this.#clearKeys();
  }
  async #clearKeys(): Promise<void> {
    for (const key of this.#keys) {
      try {
        await this.#command(['clear-status', key, '--workspace', this.#workspace!]);
        this.#keys.delete(key);
      } catch { /* Retry uncleared keys at shutdown if cmux recovers. */ }
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isSnapshot(value: unknown): value is ProgressSnapshot {
  const snapshot = record(value);
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const time = (value: unknown) => value === null || number(value);
  const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit * 2;
  return snapshot.version === 1 && number(snapshot.startedAt) && number(snapshot.updatedAt) && time(snapshot.endedAt)
    && Array.isArray(snapshot.tasks) && snapshot.tasks.every((value, index) => {
      const row = record(value);
      const usage = record(row.usage);
      return row.index === index && ['queued', 'running', 'stopping', 'succeeded', 'failed', 'aborted', 'skipped'].includes(String(row.state))
        && text(row.agent, 80) && text(row.role, 80) && text(row.task, 600) && text(row.model, 201)
        && (row.observedModel === null || text(row.observedModel, 201)) && text(row.activity, 180) && text(row.message, 240)
        && (row.warning === null || text(row.warning, 180)) && time(row.startedAt) && time(row.lastEventAt) && time(row.endedAt)
        && ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'contextTokens', 'turns'].every((key) => number(usage[key]))
        && (row.todos === null || Array.isArray(row.todos) && row.todos.length <= 128 && row.todos.every((item) => text(item, 180)))
        && Array.isArray(row.tools) && row.tools.length <= 16 && row.tools.every((value) => {
          const tool = record(value); return text(tool.id, 256) && text(tool.name, 181);
        }) && Array.isArray(row.events) && row.events.length <= 16 && row.events.every((value) => {
          const event = record(value); return number(event.at) && text(event.type, 60) && text(event.summary, 180);
        });
    });
}

export const renderProgressResult: NonNullable<ToolDefinition['renderResult']> = (result, { expanded, isPartial }, theme) => {
  const snapshot = record(result.details).progress;
  const output = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (!isSnapshot(snapshot)) return new Text(output, 0, 0);
  const live = isPartial && snapshot.endedAt === null;
  return {
    render(width) {
      const lines = progressCard(snapshot, live, expanded).lines.map((line, index) => theme.fg(
        index === 0 ? 'accent' : /QUIET|LONG RUN/.test(line) ? 'warning' : 'toolOutput', line));
      if (live) lines.push(theme.fg('dim', `${keyText('app.interrupt')} in parent: stop batch | /subagents: inspect`));
      else {
        lines.push('', theme.fg('dim', 'Output'), expanded ? output : truncateHead(output, { maxLines: 5, maxBytes: 1024 }).content);
        if (!expanded) lines.push(theme.fg('dim', `${keyText('app.tools.expand')}: full output`));
      }
      // Text wraps metadata on narrow terminals; clip also handles single-cell widths with wide glyphs.
      return new Text(lines.join('\n'), 0, 0).render(Math.max(1, width)).map((line) => clip(line, width));
    },
    invalidate() {},
  };
};

export function createProgressView(pi: ExtensionAPI) {
  const sidebar = new Sidebar();
  let latest: ProgressSnapshot | undefined;
  let latestRequestId: string | undefined;
  let refreshInspector: (() => void) | undefined;
  let closeInspector: (() => void) | undefined;
  let opening = false;
  let closed = false;
  pi.registerCommand('subagents', {
    description: 'Inspect subagent tasks, todos and usage; raw shows public snapshot JSON',
    handler: async (args, ctx) => {
      if (closed) return;
      if (!latest) { if (ctx.hasUI) ctx.ui.notify('No subagent request yet.', 'info'); return; }
      const raw = args.trim() === 'raw';
      const content = () => raw ? JSON.stringify(latest, null, 2).split('\n') : progressLines(latest!, true);
      if (ctx.mode !== 'tui') { if (ctx.hasUI) ctx.ui.notify(content().join('\n'), 'info'); return; }
      if (opening) return;
      opening = true;
      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          let offset = 0;
          let height = 1;
          let lineCount = 0;
          refreshInspector = () => tui.requestRender();
          closeInspector = () => done();
          return {
            render(width) {
              const lines = content().flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
              height = Math.max(1, tui.terminal.rows - 8);
              lineCount = lines.length;
              offset = Math.min(offset, Math.max(0, lineCount - height));
              return [theme.fg('accent', clip(`SUBAGENTS | latest request${raw ? ' | public snapshot JSON' : ''} | j/k scroll | q/Esc close`, width)),
                ...lines.slice(offset, offset + height).map((line) => clip(line, width)),
                theme.fg('dim', clip(`${offset + 1}-${Math.min(offset + height, lineCount)} / ${lineCount} lines | Closing this view does not stop work.`, width))];
            },
            handleInput(data) {
              if (data === 'q' || keys.matches(data, 'tui.select.cancel')) { done(); return; }
              if (data === 'j' || keys.matches(data, 'tui.select.down')) offset++;
              if (data === 'k' || keys.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1);
              if (keys.matches(data, 'tui.select.pageDown')) offset += height;
              if (keys.matches(data, 'tui.select.pageUp')) offset = Math.max(0, offset - height);
              if (matchesKey(data, 'home')) offset = 0;
              if (matchesKey(data, 'end')) offset = Math.max(0, lineCount - height);
              tui.requestRender();
            },
            invalidate() {},
          };
        });
      } finally { opening = false; refreshInspector = undefined; closeInspector = undefined; }
    },
  });
  return {
    begin(requestId: string) { latestRequestId = requestId; latest = undefined; },
    publish(snapshot: ProgressSnapshot, ctx: ExtensionContext, requestId: string) {
      if (closed || requestId !== latestRequestId) return;
      latest = structuredClone(snapshot);
      try { refreshInspector?.(); } catch { /* A closed inspector must not affect work or the sidebar. */ }
      if (ctx.hasUI) sidebar.publish(snapshot);
    },
    async close() {
      closed = true;
      try { closeInspector?.(); } catch { /* The host may already have closed the inspector. */ }
      await sidebar.close();
    },
  };
}
