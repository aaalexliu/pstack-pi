import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const agentNameSchema = Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 });
export const builtinTools = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'] as const;

export const agentDefinitionSchema = Type.Object({
  name: agentNameSchema,
  description: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
  tools: Type.Array(Type.Enum(builtinTools), { uniqueItems: true }),
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

export const subagentParameters = Type.Object({
  agent: agentNameSchema,
  task: Type.String({ minLength: 1, maxLength: 32 * 1024, pattern: '\\S' }),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000]+$' })),
}, { additionalProperties: false });

export type DelegationRequest = { kind: 'single'; task: Static<typeof subagentParameters> };

export function parseRequest(value: unknown): DelegationRequest {
  if (!Check(subagentParameters, value)) throw new Error('Invalid single delegation request');
  return { kind: 'single', task: value };
}

export type CanonicalCwd = string & { readonly __brand: 'CanonicalCwd' };
export type TaskIdentity = { id: string; agent: { name: string; provenance: AgentProvenance }; cwd: CanonicalCwd };
export type BoundedOutput = { text: string; bytes: number; truncated: boolean };
export type TaskResult = TaskIdentity & { output: BoundedOutput; diagnostics: readonly string[]; usage: null } & (
  | { kind: 'succeeded' }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled'; reason: string }
);
export type RunState = { kind: 'running' } | { kind: 'stopping'; reason: string } | { kind: 'finished'; result: TaskResult };

export const executionLimits = Object.freeze({
  lineBytes: 256 * 1024,
  events: 4096,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  outputBytes: 32 * 1024,
  diagnosticBytes: 4096,
});
export type ExecutionLimits = typeof executionLimits;
