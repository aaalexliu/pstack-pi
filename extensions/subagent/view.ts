import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { progressLines, type ProgressSnapshot } from './progress.ts';

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function cmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('cmux', args, { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 8192 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
export class WatchFile {
  readonly filename: string;
  readonly #directory: string;
  #pending: ProgressSnapshot | undefined;
  #writing: Promise<void> | undefined;
  #closed = false;
  error: string | undefined;
  private constructor(directory: string) { this.#directory = directory; this.filename = path.join(directory, 'progress.json'); }
  static async open(): Promise<WatchFile> { return new WatchFile(await mkdtemp(path.join(tmpdir(), 'pstack-watch-'))); }
  publish(snapshot: ProgressSnapshot): void {
    if (this.#closed || this.error) return;
    this.#pending = snapshot;
    this.#writing ??= this.#drain().finally(() => { this.#writing = undefined; });
  }
  async #drain(): Promise<void> {
    try {
      while (this.#pending && !this.#closed) {
        const snapshot = this.#pending;
        this.#pending = undefined;
        const text = JSON.stringify({ ...snapshot, parentPid: process.pid, lines: progressLines(snapshot, true) });
        if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Watch snapshot too large');
        await writeFile(this.filename + '.tmp', text, { mode: 0o600 });
        await rename(this.filename + '.tmp', this.filename);
      }
    } catch { this.error = 'Watch updates unavailable. Work continues in Pi.'; }
  }
  async flush(): Promise<void> { await this.#writing; }
  async close(): Promise<void> {
    this.#closed = true;
    this.#pending = undefined;
    await this.#writing;
    await rm(this.#directory, { recursive: true, force: true });
  }
}
export function createProgressView(pi: ExtensionAPI) {
  let latest: ProgressSnapshot | undefined;
  let context: ExtensionContext | undefined;
  let file: WatchFile | undefined;
  let opening: Promise<void> | undefined;
  let closed = false;
  const show = async (ctx: ExtensionContext) => {
    if (!latest) { ctx.ui.notify('No subagent request yet.', 'info'); return; }
    if (file) {
      ctx.ui.notify(`Watch already opened. To reopen in any terminal: ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./watch.mjs', import.meta.url)))} ${quote(file.filename)}`, 'info');
      return;
    }
    file = await WatchFile.open();
    if (closed) { await file.close(); file = undefined; return; }
    file.publish(latest);
    await file.flush();
    if (file.error) throw new Error(file.error);
    const command = [process.execPath, fileURLToPath(new URL('./watch.mjs', import.meta.url)), file.filename].map(quote).join(' ');
    if (process.env.CMUX_WORKSPACE_ID && process.env.CMUX_SURFACE_ID) {
      const created = JSON.parse(await cmux(['--json', '--id-format', 'uuids', 'new-split', 'right', '--workspace', process.env.CMUX_WORKSPACE_ID,
        '--surface', process.env.CMUX_SURFACE_ID, '--focus', 'false']));
      if (typeof created.surface_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(created.surface_id)) throw new Error('No cmux surface returned');
      try {
        await cmux(['send', '--workspace', process.env.CMUX_WORKSPACE_ID, '--surface', created.surface_id, command]);
        await cmux(['send-key', '--workspace', process.env.CMUX_WORKSPACE_ID, '--surface', created.surface_id, 'enter']);
        await cmux(['rename-tab', '--workspace', process.env.CMUX_WORKSPACE_ID, '--surface', created.surface_id, 'Subagent watch']);
      } catch (error) {
        await cmux(['close-surface', '--workspace', process.env.CMUX_WORKSPACE_ID, '--surface', created.surface_id]).catch(() => {});
        throw error;
      }
      ctx.ui.notify('Subagent watch opened to the right. q closes the viewer; Esc in Pi stops work.', 'info');
    } else ctx.ui.notify(`Run in another terminal: ${command}`, 'info');
  };
  pi.registerCommand('subagents', { description: 'Open a read-only subagent watch pane in cmux', handler: async (_args, ctx) => {
    if (opening || closed) return;
    opening = show(ctx).catch(async () => {
      ctx.ui.notify('Could not open watch. Inline progress still works; retry /subagents.', 'warning');
      await file?.close(); file = undefined;
    }).finally(() => { opening = undefined; });
    await opening;
  } });
  return {
    publish(snapshot: ProgressSnapshot, ctx: ExtensionContext) {
      latest = snapshot; context = ctx;
      file?.publish(snapshot);
      if (ctx.hasUI) ctx.ui.setWidget('pstack-subagents', [progressLines(snapshot)[0],
        ...snapshot.tasks.map((row) => `#${row.index + 1} ${row.role} ${row.state} | ${row.model} | ${row.activity}`),
        file?.error ?? '/subagents opens task, checklist, message, event age, and usage details.']);
    },
    async close() {
      closed = true;
      await opening;
      if (context?.hasUI) context.ui.setWidget('pstack-subagents', undefined);
      await file?.close();
    },
  };
}
