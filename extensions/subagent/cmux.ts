import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CMUX_TIMEOUT_MS = 1000;
export type CmuxExec = (args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<string>;
const execCmux: CmuxExec = (args, env, signal) => new Promise((resolve, reject) => {
  execFile('cmux', args, { env, signal, timeout: CMUX_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const readable = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

// Reads bytes once, drains on completion/unlink, and stops if the parent dies.
// It owns no child process and accepts only a transcript path and parent PID.
const follower = `const fs = require('node:fs');
if (process.stdout.isTTY) process.stdout.write('\\x1b[2J\\x1b[H');
const [file, parent] = process.argv.slice(2);
let fd;
try { fd = fs.openSync(file, 'r'); } catch { console.log('[Transcript unavailable: session ended]'); process.exit(0); }
const buffer = Buffer.alloc(65536);
let offset = 0;
function poll() {
  let done = fs.existsSync(file + '.done') || fs.fstatSync(fd).nlink === 0;
  try { process.kill(Number(parent), 0); } catch { done = true; }
  let count;
  while ((count = fs.readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
    fs.writeSync(1, buffer.subarray(0, count)); offset += count;
  }
  if (done) { fs.closeSync(fd); return; }
  setTimeout(poll, 100);
}
poll();`;

export interface TranscriptPane {
  readonly file: string;
  readonly ready: Promise<void>;
  event(event: unknown): void;
  write(text: string): void;
  finish(status: string): void;
  cleanup(): void;
}

/** Display-only resources. The extension owns this set, not the child runner. */
export class CmuxTranscripts {
  readonly #panes = new Set<TranscriptPane>();
  #closing = false;

  create({ env = process.env, exec = execCmux, label }: { env?: NodeJS.ProcessEnv; exec?: CmuxExec; label: string }): TranscriptPane | undefined {
    if (this.#closing || !env.CMUX_WORKSPACE_ID) return;
    let dir: string | undefined;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cmux-'));
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, 'transcript.txt');
      fs.writeFileSync(file, '', { mode: 0o600 });
      const script = path.join(dir, 'follow.cjs');
      fs.writeFileSync(script, follower, { mode: 0o600 });
      let finished = false;
      let removed = false;
      const controller = new AbortController();
      const write = (text: string) => {
        if (finished || removed) return;
        try { fs.appendFileSync(file, readable(text)); } catch { /* display is optional */ }
      };
      const finish = (status: string) => {
        if (finished || removed) return;
        write(`\n[${status}]\n`);
        finished = true;
        try { fs.writeFileSync(file + '.done', '', { mode: 0o600 }); } catch { /* display is optional */ }
      };
      const cleanup = () => {
        if (removed) return;
        finish('Aborted: session shutdown');
        removed = true;
        controller.abort();
        try { fs.rmSync(dir!, { recursive: true, force: true }); } catch { /* best effort */ }
        this.#panes.delete(pane);
      };
      const command = async (args: string[]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            exec(['--json', ...args], env, controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error('cmux timed out')); }, CMUX_TIMEOUT_MS);
            }),
          ]);
        } finally { clearTimeout(timer); }
      };
      const pane: TranscriptPane = {
        file,
        ready: Promise.resolve(),
        write,
        finish,
        cleanup,
        event(event) {
          if (!event || typeof event !== 'object') return;
          const { type, message } = event as { type?: string; message?: any };
          if (type !== 'message_end' || !message || !Array.isArray(message.content)) return;
          if (message.role === 'assistant') {
            for (const part of message.content) {
              if (part.type === 'text') write(`\n${part.text}\n`);
              else if (part.type === 'toolCall') write(`\nTool: ${part.name}\n${JSON.stringify(part.arguments, null, 2)}\n`);
            }
          } else if (message.role === 'toolResult') {
            write(`\nResult: ${message.toolName}${message.isError ? ' (error)' : ''}\n`);
            for (const part of message.content) {
              if (part.type === 'text') write(`${part.text}\n`);
              else write(`[${part.type} omitted]\n`);
            }
          }
        },
      };
      this.#panes.add(pane);
      write(`Subagent: ${label}\n`);
      const ready = (async () => {
        const workspace = env.CMUX_WORKSPACE_ID!;
        let surface: string | undefined;
        try {
          const args = ['new-split', 'right', '--focus', 'false', '--workspace', workspace];
          if (env.CMUX_SURFACE_ID) args.push('--surface', env.CMUX_SURFACE_ID);
          const created = JSON.parse(await command(args));
          const target = created.surface_id ?? created.surface_ref;
          if (typeof target !== 'string' || !target) throw new Error('No created surface');
          surface = target;
          if (removed) throw new Error('Session ended');
          const runtime = /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'node';
          const shellCommand = `${quote(runtime)} ${quote(script)} ${quote(file)} ${quote(String(process.pid))}\n`;
          await command(['send', '--workspace', workspace, '--surface', surface, shellCommand]);
          await command(['rename-tab', '--workspace', workspace, '--surface', surface, `Subagent: ${readable(label)}`]).catch(() => {});
        } catch {
          cleanup();
          if (surface) {
            void exec(['--json', 'close-surface', '--workspace', workspace, '--surface', surface], env, AbortSignal.timeout(CMUX_TIMEOUT_MS)).catch(() => {});
          }
        }
      })();
      Object.assign(pane, { ready });
      return pane;
    } catch {
      if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      return;
    }
  }

  shutdown(): void {
    this.#closing = true;
    for (const pane of this.#panes) pane.cleanup();
  }
}
