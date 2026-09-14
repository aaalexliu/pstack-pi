import { ExecutionDeadline, executionLimits, monotonicTimer, requireRoot, RunLease, type CancellationReason, type DelegationDepth, type ExecutionLimits, type MonotonicTimer, type TaskResult } from './domain.ts';
import { boundedOutput, type runChild } from './runner.ts';
import type { ModelSelection } from './model-config.ts';
import type { PiInvocation } from './process.ts';
import { usageReport } from './usage.ts';

export type ResolvedTask = Readonly<Pick<Parameters<typeof runChild>[0], 'identity' | 'agent' | 'task' | 'model'> & {
  depth: DelegationDepth; limits: ExecutionLimits; invocation: PiInvocation;
  requested: { model: string | null; role: string | null }; selection: ModelSelection;
}>;
export function outputQuota(bytes: number, count: number, index: number): number {
  return Math.floor(bytes / count) + (index < bytes % count ? 1 : 0);
}
function skipped(task: ResolvedTask, reason: string): TaskResult {
  return { ...task.identity, kind: 'skipped', reason, output: boundedOutput(''), diagnostics: [], usage: usageReport(), observedModel: null,
    cleanup: { verified: true, durationMs: 0, forced: false, observedProcesses: 0 } };
}
type RequestState = 'reserved' | 'admitted' | 'running' | 'stopping' | 'finished';

export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export class RequestLease {
  #state: RequestState = 'reserved';
  #controller = new AbortController();
  readonly #deadline: ExecutionDeadline;
  #active = new Set<RunLease>();
  #batch: readonly ResolvedTask[] | undefined;
  #resolve!: () => void;
  readonly done = new Promise<void>((resolve) => { this.#resolve = resolve; });
  get state(): RequestState { return this.#state; }
  get signal(): AbortSignal { return this.#controller.signal; }
  get cancellation(): CancellationReason | undefined { return this.signal.aborted ? this.signal.reason : undefined; }
  constructor(timer: MonotonicTimer = monotonicTimer) {
    this.#deadline = new ExecutionDeadline(() => this.cancel('deadline'), timer, null);
  }
  lowerDeadline(timeoutMs: number | null): void { this.#deadline.shorten(timeoutMs); }
  check(): void {
    this.#deadline.check();
    this.signal.throwIfAborted();
  }
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let rejectAbort: (reason?: unknown) => void = () => {};
    const abort = () => rejectAbort(this.cancellation);
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    this.signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([Promise.resolve().then(() => { this.check(); return operation(); }), cancelled]); }
    finally { this.signal.removeEventListener('abort', abort); }
  }
  cancel(reason: CancellationReason): void {
    if (this.#state === 'finished') return;
    this.#state = 'stopping';
    if (!this.signal.aborted) this.#controller.abort(reason);
    for (const lease of this.#active) lease.cancel(this.cancellation ?? reason);
  }
  admit(batch: readonly ResolvedTask[], commit: () => void): void {
    this.check();
    if (this.#state !== 'reserved') throw new Error('Request is not reserved');
    if (!batch.length || batch.length > executionLimits.maxTasks) throw new Error('Invalid batch size');
    const frozen = immutable(batch);
    this.check();
    commit();
    this.#batch = frozen;
    this.#state = 'admitted';
  }
  async run(run: typeof runChild): Promise<TaskResult[]> {
    const batch = this.#batch;
    if (!batch || this.#state !== 'admitted' && this.#state !== 'stopping') throw new Error('Request is not admitted');
    this.#batch = undefined;
    if (this.#state === 'admitted') this.#state = 'running';
    const results = batch.map((task) => skipped(task, 'Not dispatched'));
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        this.#deadline.check();
        if (this.signal.aborted) return;
        const index = next++;
        const task = batch[index];
        const lease = new RunLease();
        this.#active.add(lease);
        try {
          results[index] = await run({ ...task, lease, signal: undefined });
        } catch {
          results[index] = { ...skipped(task, 'Child runner failed'), kind: 'failed', reason: 'Child runner failed', usage: usageReport({ reasons: ['runner-failure'] }) };
        } finally {
          if (lease.state.kind !== 'finished') { lease.verify(); lease.finish(); }
          this.#active.delete(lease);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(batch.length, executionLimits.maxConcurrent) }, worker));
    if (next < batch.length && !this.cancellation) throw new Error('Undispatched tasks without cancellation');
    for (let index = next; index < batch.length; index++) {
      results[index] = skipped(batch[index], `Delegation cancelled (${this.cancellation})`);
    }
    return results;
  }
  finish(): void {
    if (this.#active.size) throw new Error('Request still owns child cleanup');
    this.#state = 'finished';
    this.#batch = undefined;
    this.#deadline.clear();
    this.#resolve();
  }
}

export class DelegationScheduler {
  #active: RequestLease | undefined;
  #closed = false;
  readonly #timer: MonotonicTimer;
  constructor(timer: MonotonicTimer = monotonicTimer) { this.#timer = timer; }
  reserve(depth: DelegationDepth): RequestLease {
    requireRoot(depth);
    if (this.#closed) throw new Error('Delegation session is shutting down');
    if (this.#active && this.#active.state !== 'finished') throw new Error('A delegation is already running or stopping');
    this.#active = new RequestLease(this.#timer);
    return this.#active;
  }
  shutdown(): Promise<void> {
    this.#closed = true;
    this.#active?.cancel('parentShutdown');
    return this.#active?.done ?? Promise.resolve();
  }
}
