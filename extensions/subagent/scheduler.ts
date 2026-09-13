import { executionLimits, requireRoot, RunLease, type CancellationReason, type DelegationDepth, type TaskResult } from './domain.ts';
import type { runChild } from './runner.ts';

type PreparedChild = Omit<Parameters<typeof runChild>[0], 'lease' | 'signal' | 'onStart' | 'backend'>;
type RequestState = 'reserved' | 'admitted' | 'stopping' | 'finished' | 'quarantined';

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
  cancel(reason: CancellationReason): void {
    if (this.#state === 'finished' || this.#state === 'quarantined') return;
    this.#state = 'stopping';
    if (!this.signal.aborted) this.#controller.abort(reason);
    for (const lease of this.#active) lease.cancel(this.cancellation ?? reason);
  }
  admit(commit: () => void): void {
    this.check();
    if (this.#state !== 'reserved') throw new Error('Request is not reserved');
    commit();
    this.#state = 'admitted';
  }
  async run(task: PreparedChild, run: typeof runChild): Promise<TaskResult> {
    this.check();
    if (this.#state !== 'admitted') throw new Error('Request is not admitted');
    const lease = new RunLease();
    this.#active.add(lease);
    try {
      const result = await run({ ...task, lease, signal: undefined });
      return result;
    } finally {
      if (lease.state.kind !== 'finished') {
        this.#state = 'quarantined';
        if (lease.state.kind !== 'quarantined') { lease.verify(); lease.finish(false); }
      }
      this.#active.delete(lease);
    }
  }
  finish(): void {
    if (this.#active.size) throw new Error('Request still owns child cleanup');
    if (this.#state !== 'quarantined') this.#state = 'finished';
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
