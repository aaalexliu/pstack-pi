import { executionLimits, requireRoot, RunLease, type CancellationReason, type DelegationDepth, type ExecutionLimits, type TaskResult } from './domain.ts';
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
type RequestState = 'reserved' | 'admitted' | 'running' | 'stopping' | 'finished' | 'quarantined';

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
  #started = performance.now();
  #deadline = this.#started + executionLimits.timeoutMs;
  #timer: ReturnType<typeof setTimeout>;
  #active = new Set<RunLease>();
  #batch: readonly ResolvedTask[] | undefined;
  #resolve!: () => void;
  readonly done = new Promise<void>((resolve) => { this.#resolve = resolve; });
  get state(): RequestState { return this.#state; }
  get signal(): AbortSignal { return this.#controller.signal; }
  get cancellation(): CancellationReason | undefined { return this.signal.aborted ? this.signal.reason : undefined; }
  constructor() { this.#timer = setTimeout(() => this.cancel('deadline'), executionLimits.timeoutMs); }
  lowerDeadline(timeoutMs: number): void {
    this.#deadline = Math.min(this.#deadline, this.#started + timeoutMs);
    clearTimeout(this.#timer);
    const remaining = this.#deadline - performance.now();
    if (remaining <= 0) this.cancel('deadline');
    else this.#timer = setTimeout(() => this.cancel('deadline'), remaining);
  }
  check(): void {
    if (performance.now() >= this.#deadline) this.cancel('deadline');
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
  #quarantine = (): void => {
    this.cancel('unsafeCleanup');
    this.#state = 'quarantined';
  };
  cancel(reason: CancellationReason): void {
    if (this.#state === 'finished' || this.#state === 'quarantined') return;
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
        if (performance.now() >= this.#deadline) this.cancel('deadline');
        if (this.signal.aborted) return;
        const index = next++;
        const task = batch[index];
        const lease = new RunLease();
        lease.cleanupUncertainty.addEventListener('abort', this.#quarantine, { once: true });
        this.#active.add(lease);
        try {
          results[index] = await run({ ...task, lease, signal: undefined });
        } catch {
          results[index] = { ...skipped(task, 'Child runner failed'), kind: 'failed', reason: 'Child runner failed', usage: usageReport({ reasons: ['runner-failure'] }) };
        } finally {
          if (lease.state.kind !== 'finished' || lease.cleanupUncertainty.aborted || !results[index].cleanup.verified) {
            this.#quarantine();
            if (lease.state.kind !== 'finished' && lease.state.kind !== 'quarantined') { lease.verify(); lease.finish(false); }
            results[index] = { ...results[index], kind: 'failed', reason: 'Delegation cleanup unverified; session quarantined',
              output: boundedOutput(''), cleanup: { ...results[index].cleanup, verified: false } };
          }
          lease.cleanupUncertainty.removeEventListener('abort', this.#quarantine);
          this.#active.delete(lease);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(batch.length, executionLimits.maxConcurrent) }, worker));
    for (let index = next; index < batch.length; index++) {
      results[index] = skipped(batch[index], `Delegation cancelled (${this.cancellation ?? 'unsafeCleanup'})`);
    }
    return results;
  }
  finish(): void {
    if (this.#active.size) throw new Error('Request still owns child cleanup');
    if (this.#state !== 'quarantined') this.#state = 'finished';
    this.#batch = undefined;
    clearTimeout(this.#timer);
    this.#resolve();
  }
}

export class DelegationScheduler {
  #active: RequestLease | undefined;
  #closed = false;
  reserve(depth: DelegationDepth): RequestLease {
    requireRoot(depth);
    if (this.#closed) throw new Error('Delegation session is shutting down');
    if (this.#active?.state === 'quarantined') throw new Error('Delegation cleanup unverified; session quarantined');
    if (this.#active && this.#active.state !== 'finished') throw new Error('A delegation is already running or stopping');
    this.#active = new RequestLease();
    return this.#active;
  }
  shutdown(): Promise<void> {
    this.#closed = true;
    this.#active?.cancel('parentShutdown');
    return this.#active?.done ?? Promise.resolve();
  }
}
