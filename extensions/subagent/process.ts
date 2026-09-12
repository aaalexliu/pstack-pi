import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { requireRoot, type DelegationDepth, type RunLease, type StopCause } from './domain.ts';

const piPackageSchema = Type.Object({
  name: Type.Literal('@earendil-works/pi-coding-agent'),
  version: Type.Literal('0.85.1'),
  bin: Type.Object({ pi: Type.Enum(['dist/cli.js', 'dist/bundle/cli.js']) }),
});

export class PiInvocation {
  readonly node: string;
  readonly cli: string;
  private constructor(node: string, cli: string) { this.node = node; this.cli = cli; Object.freeze(this); }
  static async resolve({ execPath = process.execPath, entrypoint = process.argv[1] }: {
    execPath?: string; entrypoint?: string;
  } = {}): Promise<PiInvocation> {
    try {
      if (!entrypoint || !path.isAbsolute(execPath) || !path.isAbsolute(entrypoint)) throw new Error();
      const node = await realpath(execPath);
      const cli = await realpath(entrypoint);
      if (!(await lstat(node)).isFile() || !(await lstat(cli)).isFile()) throw new Error();
      await access(node, constants.X_OK);
      const root = path.basename(path.dirname(cli)) === 'bundle' ? path.dirname(path.dirname(path.dirname(cli))) : path.dirname(path.dirname(cli));
      const manifestPath = path.join(root, 'package.json');
      if ((await lstat(manifestPath)).size > 64 * 1024) throw new Error();
      const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!Check(piPackageSchema, manifest)) throw new Error();
      const bin = await realpath(path.join(root, manifest.bin.pi));
      if (bin !== path.join(root, manifest.bin.pi) || !(await lstat(bin)).isFile()) throw new Error();
      if (cli !== bin && cli !== path.join(root, 'dist/cli.js')) throw new Error();
      return new PiInvocation(node, cli);
    } catch {
      throw new Error('Cannot validate the running Pi 0.85.1 invocation; delegation disabled');
    }
  }
}

export function childEnvironment(depth: DelegationDepth, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  requireRoot(depth);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.startsWith('PSTACK_')) env[key] = value;
  }
  env.PSTACK_SUBAGENT_DEPTH = String(depth + 1);
  return env;
}

export type ProcessIdentity = Readonly<{ pid: number; ppid: number; pgid: number; start: string }>;
export const cleanupLimits = Object.freeze({ pollMs: 40, psTimeoutMs: 250, graceMs: 1000, verifyMs: 2000, maxIdentities: 128 });

export function parseProcessTable(text: string): ProcessIdentity[] {
  if (!text.endsWith('\n') || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Incomplete process table');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > 16_384) throw new Error('Process table limit exceeded');
  const seen = new Set<number>();
  return lines.map((line) => {
    const match = /^\s*([1-9][0-9]*)\s+(0|[1-9][0-9]*)\s+(0|[1-9][0-9]*)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s*$/u.exec(line);
    if (!match) throw new Error('Malformed process table');
    const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || seen.has(pid)) throw new Error('Invalid process identity');
    seen.add(pid);
    const start = match[4].replace(/\s+/gu, ' ');
    if (!Number.isFinite(Date.parse(`${start} UTC`))) throw new Error('Invalid process start time');
    return { pid, ppid, pgid, start };
  });
}

export function processTable(): ProcessIdentity[] {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Delegation requires macOS or Linux');
  return parseProcessTable(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: cleanupLimits.psTimeoutMs,
    maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

export type ProcessBackend = {
  table(): ProcessIdentity[];
  signal(pid: number, signal: NodeJS.Signals | 0): void;
  spawn(invocation: PiInvocation, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
};
export const processBackend: ProcessBackend = {
  table: processTable,
  signal: (pid, signal) => { process.kill(pid, signal); },
  spawn: (invocation, args, options) => spawn(invocation.node, [invocation.cli, ...args], options),
};

export type CleanupReport = { verified: boolean; durationMs: number; identities: readonly ProcessIdentity[]; forced: boolean };
export class ProcessOwnershipError extends Error {}

export class OwnedProcessTree {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #backend: ProcessBackend;
  readonly #lease: RunLease;
  readonly #hostGroup: number;
  readonly #known = new Map<number, ProcessIdentity>();
  readonly #groups = new Set<number>();
  readonly #mismatched = new Set<number>();
  #unverified = false;
  #exited = false;
  #closed = false;
  #stopAt: number | undefined;
  #failure: string | undefined;
  #cleanup: Promise<CleanupReport> | undefined;
  #timer: ReturnType<typeof setInterval>;
  #wake!: () => void;
  readonly ready = new Promise<void>((resolve) => { this.#wake = resolve; });
  get failure(): string | undefined { return this.#failure; }
  get exitCode(): number | null { return this.child.exitCode; }
  get exitSignal(): NodeJS.Signals | null { return this.child.signalCode; }

  constructor({ invocation, args, cwd, env, lease, backend = processBackend }: {
    invocation: PiInvocation; args: string[]; cwd: string; env: NodeJS.ProcessEnv; lease: RunLease; backend?: ProcessBackend;
  }) {
    this.#backend = backend;
    this.#lease = lease;
    try {
      const host = backend.table().find((row) => row.pid === process.pid);
      if (!host) throw new Error();
      this.#hostGroup = host.pgid;
    } catch { throw new ProcessOwnershipError('Cannot identify host process group'); }
    this.child = backend.spawn(invocation, args, { cwd, env, shell: false, detached: true, stdio: 'pipe' });
    this.child.once('exit', this.#exit);
    this.child.once('close', this.#close);
    this.child.on('error', this.#error);
    this.child.stdin.on('error', this.#error);
    if (this.child.pid !== undefined) this.#groups.add(this.child.pid);
    this.#timer = setInterval(() => this.#observe(), cleanupLimits.pollMs);
    this.#observe();
  }

  #exit = () => { this.#exited = true; this.#wake(); };
  #close = () => { this.#closed = true; this.#wake(); };
  #error = (error: Error) => {
    if ('syscall' in error && error.syscall === 'kill') this.#unverified = true;
    this.requestStop({ kind: 'failed', reason: 'Child process or pipe failed' });
  };

  #snapshot(): ProcessIdentity[] {
    const table = this.#backend.table();
    const root = this.child.pid;
    const owned = new Set<number>();
    if (root !== undefined && this.#liveChild()) owned.add(root);
    for (const group of this.#groups) {
      const anchored = group === root && this.#liveChild() || table.some((row) => {
        const previous = this.#known.get(row.pid);
        return row.pgid === group && previous?.pgid === group && previous.start === row.start;
      });
      if (!anchored) this.#groups.delete(group);
    }
    for (const row of table) {
      const previous = this.#known.get(row.pid);
      if (previous && previous.start !== row.start) {
        this.#mismatched.add(row.pid);
        throw new Error('Process identity changed');
      } else if (previous) owned.add(row.pid);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const row of table) {
        if ((owned.has(row.ppid) || this.#groups.has(row.pgid)) && !owned.has(row.pid)) {
          owned.add(row.pid); changed = true;
        }
      }
    }
    const rows = table.filter((row) => owned.has(row.pid));
    for (const row of rows) {
      if (row.pid === process.pid || row.pgid === this.#hostGroup || row.pgid <= 1) throw new Error('Unsafe process ownership');
      if (!this.#known.has(row.pid) && this.#known.size >= cleanupLimits.maxIdentities) throw new Error('Owned process limit exceeded');
      this.#known.set(row.pid, row);
      if (row.pid === row.pgid && !this.#mismatched.has(row.pid)) this.#groups.add(row.pgid);
    }
    return rows;
  }

  #observe(): ProcessIdentity[] | undefined {
    try { return this.#snapshot(); }
    catch {
      this.#unverified = true;
      this.requestStop({ kind: 'failed', reason: 'Process observation failed' }, false);
      return undefined;
    }
  }

  #signal(pid: number, signal: NodeJS.Signals | 0): boolean {
    if (pid === process.pid || pid === -this.#hostGroup || Math.abs(pid) <= 1) { this.#unverified = true; return true; }
    try { this.#backend.signal(pid, signal); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
      this.#unverified = true;
      return true;
    }
  }

  #liveChild(): boolean {
    return this.child.pid !== undefined && !this.#exited && this.child.exitCode === null && this.child.signalCode === null;
  }

  #signalChild(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.#liveChild()) return;
    try { if (!this.child.kill(signal)) this.#unverified = true; }
    catch { this.#unverified = true; }
  }

  #forceChild(): void {
    const root = this.child.pid;
    // The live detached session leader pins its initial group without a ps row.
    if (root !== undefined && this.#liveChild()) this.#signal(-root, 'SIGKILL');
    this.#signalChild('SIGKILL');
  }

  requestStop(cause: StopCause, observe = true): void {
    if (this.#stopAt !== undefined) return;
    this.#stopAt = performance.now();
    if (cause.kind === 'failed') this.#failure = cause.reason;
    this.#lease.stop(cause);
    this.#signalChild('SIGTERM');
    if (observe) this.#observe();
    this.#wake();
  }

  cleanup(): Promise<CleanupReport> {
    this.#cleanup ??= this.#clean();
    return this.#cleanup;
  }

  async #clean(): Promise<CleanupReport> {
    const started = performance.now();
    const deadline = started + cleanupLimits.graceMs + cleanupLimits.verifyMs;
    let forced = false;
    let rows: ProcessIdentity[] | undefined;
    clearInterval(this.#timer);
    try {
      rows = this.#observe();
      if (this.#stopAt === undefined && (rows?.length || this.#liveChild())) this.requestStop({ kind: 'failed', reason: 'Child left surviving work' });
      if (this.#stopAt !== undefined) {
        const graceDeadline = Math.min(deadline, this.#stopAt + cleanupLimits.graceMs);
        while (performance.now() < graceDeadline && (rows === undefined || rows.length > 0 || !this.#closed)) {
          await delay(Math.min(cleanupLimits.pollMs, Math.max(0, graceDeadline - performance.now())));
          rows = this.#observe();
        }
        if (rows === undefined || rows.length > 0 || !this.#closed) {
          forced = true;
          this.#lease.force();
          rows = this.#observe();
          const root = this.#liveChild() ? this.child.pid : undefined;
          this.#forceChild();
          if (rows) {
            for (const group of this.#groups) {
              if (group === root) continue;
              const members = rows.filter((row) => row.pgid === group);
              if (members.length && !members.some((row) => this.#mismatched.has(row.pid)) && !this.#mismatched.has(group)) this.#signal(-group, 'SIGKILL');
            }
            rows = this.#observe();
            for (const row of rows ?? []) if (row.pid !== root && !this.#mismatched.has(row.pid)) this.#signal(row.pid, 'SIGKILL');
          }
        }
      }
    } catch {
      this.#unverified = true;
    }
    this.#lease.verify();
    try {
      while (performance.now() < deadline) {
        rows = this.#observe();
        if (rows?.length === 0 && this.#closed && (this.#exited || this.child.pid === undefined)) break;
        await delay(Math.min(cleanupLimits.pollMs, Math.max(0, deadline - performance.now())));
        if (performance.now() < deadline && this.#liveChild()) {
          forced = true;
          this.#forceChild();
        }
      }
      if (!rows || rows.length || !this.#closed || (!this.#exited && this.child.pid !== undefined) || this.#liveChild()) this.#unverified = true;
    } finally {
      this.child.removeListener('exit', this.#exit);
      this.child.removeListener('close', this.#close);
      this.child.removeListener('error', this.#error);
      this.child.stdin.removeListener('error', this.#error);
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
    return { verified: !this.#unverified, durationMs: Math.round(performance.now() - started), identities: [...this.#known.values()], forced };
  }
}
