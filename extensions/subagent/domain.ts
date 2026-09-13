import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { modelChoiceSchema, roleSchema } from './model-config.ts';
import type { ModelIdentity } from './model-runtime.ts';
import type { UsageReport } from './usage.ts';

export const agentNameSchema = Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 });
export const builtinTools = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'] as const;

export const agentDefinitionSchema = Type.Object({
  name: agentNameSchema,
  description: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
  tools: Type.Array(Type.Enum(builtinTools), { uniqueItems: true }),
  model: Type.Optional(modelChoiceSchema),
}, { additionalProperties: false });

export type AgentDefinition = Static<typeof agentDefinitionSchema> & { systemPrompt: string };
export type AgentProvenance = { kind: 'bundled' | 'user'; path: string; sha256: string };
export type Agent = AgentDefinition & { provenance: AgentProvenance };
export type CatalogDiagnostic = { path: string; message: string };
export type AgentCatalog = {
  selected: ReadonlyMap<string, Agent>;
  shadowed: readonly { agent: Agent; replacedBy: AgentProvenance }[];
  diagnostics: readonly CatalogDiagnostic[];
};

export const reductionSchema = Type.Object({
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  outputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false });

const taskFields = {
  agent: agentNameSchema,
  task: Type.String({ minLength: 1, maxLength: 32 * 1024, pattern: '\\S' }),
  model: Type.Optional(modelChoiceSchema),
  role: Type.Optional(roleSchema),
};
const requestFields = {
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000]+$' })),
  limits: Type.Optional(reductionSchema),
};
export const delegationTaskSchema = Type.Object(taskFields, { additionalProperties: false });
const singleParameters = Type.Object({ ...taskFields, ...requestFields }, { additionalProperties: false });
const parallelParameters = Type.Object({
  tasks: Type.Array(delegationTaskSchema, { minItems: 1, maxItems: 8 }), ...requestFields,
}, { additionalProperties: false });
export const subagentParameters = Type.Union([singleParameters, parallelParameters]);
export type DelegationTask = Static<typeof delegationTaskSchema>;
export type DelegationRequest =
  | { kind: 'single'; task: Static<typeof singleParameters> }
  | { kind: 'parallel'; request: Static<typeof parallelParameters> };
export const inputLimits = Object.freeze({ taskBytes: 32 * 1024, aggregateTaskBytes: 128 * 1024, requestBytes: 160 * 1024 });

export function parseRequest(value: unknown): DelegationRequest {
  if (!Check(subagentParameters, value)) throw new Error('Invalid single or parallel delegation request');
  const tasks = 'tasks' in value ? value.tasks : [value];
  const sizes = tasks.map((task) => Buffer.byteLength(task.task));
  if (sizes.some((bytes) => bytes > inputLimits.taskBytes)
    || sizes.reduce((sum, bytes) => sum + bytes, 0) > inputLimits.aggregateTaskBytes
    || Buffer.byteLength(JSON.stringify(value)) > inputLimits.requestBytes) throw new Error('Delegation input exceeds byte limit');
  return 'tasks' in value ? { kind: 'parallel', request: value } : { kind: 'single', task: value };
}

export type CanonicalCwd = string & { readonly __brand: 'CanonicalCwd' };
export type TaskIdentity = { id: string; agent: { name: string; provenance: AgentProvenance }; cwd: CanonicalCwd };
export type BoundedOutput = { text: string; bytes: number; truncated: boolean };
export type TaskResult = TaskIdentity & {
  output: BoundedOutput; diagnostics: readonly string[]; usage: UsageReport;
  observedModel: ModelIdentity | null;
  cleanup: { verified: boolean; durationMs: number; forced: boolean; observedProcesses: number };
} & (
  | { kind: 'succeeded' }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'skipped'; reason: string }
);
export type ExecutionLimits = Readonly<{
  maxTasks: 8; maxConcurrent: 4; maxDepth: 1; timeoutMs: number; outputBytes: number;
}>;
export const executionLimits: ExecutionLimits = Object.freeze({
  maxTasks: 8, maxConcurrent: 4, maxDepth: 1, timeoutMs: 120_000, outputBytes: 32_768,
});

export const protocolLimits = Object.freeze({
  lineBytes: 256 * 1024,
  events: 4096,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  diagnosticBytes: 4096,
});
export type ProtocolLimits = typeof protocolLimits;

export function reduceLimits(value: unknown = {}): { limits: ExecutionLimits; diagnostics: string[] } {
  if (!Check(reductionSchema, value)) throw new Error('Invalid execution limit reduction');
  const diagnostics: string[] = [];
  const reduce = (key: 'timeoutMs' | 'outputBytes') => {
    const requested = value[key] ?? executionLimits[key];
    if (requested > executionLimits[key]) diagnostics.push(`${key} clamped to ${executionLimits[key]}`);
    return Math.min(requested, executionLimits[key]);
  };
  return { limits: Object.freeze({ ...executionLimits, timeoutMs: reduce('timeoutMs'), outputBytes: reduce('outputBytes') }), diagnostics };
}

export type DelegationDepth = number & { readonly __brand: 'DelegationDepth' };
export function parseDepth(value: string | undefined): DelegationDepth {
  if (value === undefined) return 0 as DelegationDepth;
  if (value.length > 6 || !/^(0|[1-9][0-9]*)$/u.test(value) || Number(value) > 999_999) {
    throw new Error('Invalid inherited delegation depth');
  }
  return Number(value) as DelegationDepth;
}
export function requireRoot(depth: DelegationDepth): void {
  if (depth >= executionLimits.maxDepth) throw new Error('Delegation depth limit reached');
}

export type CancellationReason = 'user' | 'deadline' | 'parentShutdown' | 'unsafeCleanup';
export type StopCause = { kind: 'cancelled'; reason: CancellationReason } | { kind: 'failed'; reason: string };
export type RunState =
  | { kind: 'admitted' | 'preparing' | 'running' }
  | { kind: 'cooperativeStop' | 'forcedStop'; cause: StopCause }
  | { kind: 'verifying' | 'finished' | 'quarantined'; cause: StopCause | null };

export class RunLease {
  #state: RunState = { kind: 'admitted' };
  #controller = new AbortController();
  #cleanupUncertainty = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #resolve!: () => void;
  readonly done = new Promise<void>((resolve) => { this.#resolve = resolve; });
  get state(): RunState { return this.#state; }
  get signal(): AbortSignal { return this.#controller.signal; }
  get cleanupUncertainty(): AbortSignal { return this.#cleanupUncertainty.signal; }
  distrustCleanup(): void { this.#cleanupUncertainty.abort(); }
  get cancellation(): CancellationReason | undefined {
    return this.#controller.signal.aborted ? this.#controller.signal.reason : undefined;
  }
  constructor(timeoutMs?: number) {
    if (timeoutMs !== undefined) this.#timer = setTimeout(() => this.cancel('deadline'), timeoutMs);
  }
  cancel(reason: CancellationReason): void {
    if (this.#state.kind === 'finished' || this.#state.kind === 'quarantined') return;
    if (!this.signal.aborted) this.#controller.abort(reason);
  }
  prepare(): void {
    if (this.#state.kind !== 'admitted') throw new Error('Run is not admitted');
    this.#state = { kind: 'preparing' };
  }
  run(): void {
    if (this.#state.kind !== 'preparing') throw new Error('Run is not prepared');
    this.#state = { kind: 'running' };
  }
  stop(cause: StopCause): void {
    if (['admitted', 'preparing', 'running'].includes(this.#state.kind)) this.#state = { kind: 'cooperativeStop', cause };
  }
  force(): void {
    if (this.#state.kind === 'cooperativeStop') this.#state = { kind: 'forcedStop', cause: this.#state.cause };
  }
  verify(): void {
    if (this.#state.kind === 'finished' || this.#state.kind === 'quarantined') return;
    const cause = 'cause' in this.#state ? this.#state.cause : null;
    this.#state = { kind: 'verifying', cause };
  }
  finish(verified: boolean): void {
    if (this.#state.kind !== 'verifying') throw new Error('Run cleanup has not been verified');
    if (!verified) this.distrustCleanup();
    this.#state = { kind: verified && !this.cleanupUncertainty.aborted ? 'finished' : 'quarantined', cause: this.#state.cause };
    clearTimeout(this.#timer);
    this.#resolve();
  }
}

export class RunRegistry {
  #active: RunLease | undefined;
  #closed = false;
  admit(depth: DelegationDepth, timeoutMs: number): RunLease {
    requireRoot(depth);
    if (this.#closed) throw new Error('Delegation session is shutting down');
    if (this.#active?.state.kind === 'quarantined') throw new Error('Delegation cleanup unverified; session quarantined');
    if (this.#active && this.#active.state.kind !== 'finished') throw new Error('A delegation is already running or stopping');
    this.#active = new RunLease(Math.min(timeoutMs, executionLimits.timeoutMs));
    return this.#active;
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (!active) return;
    active.cancel('parentShutdown');
    await active.done;
  }
}
