import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const roles = [
  'feature', 'refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment', 'prose', 'hardest',
  'how-explorer', 'how-explainer', 'how-critics', 'why-investigator', 'why-synthesizer',
  'reflect-tooling', 'reflect-judgment', 'reflect-divergent', 'reflect-synthesizer',
  'arena-runner', 'arena-cross-judge', 'swarm-worker', 'architect-runner', 'interrogate-reviewer',
  'no-comments', 'review', 'test', 'verify',
] as const;
export const roleSchema = Type.Enum(roles);
export type Role = Static<typeof roleSchema>;

export const modelChoiceSchema = Type.String({
  description: 'inherit-parent or an exact provider/model-id',
  pattern: '^(?:inherit-parent|[^/\\s]+/\\S+)$',
});
export type ModelChoice = { kind: 'inheritParent' } | { kind: 'pinned'; provider: string; id: string };
export type RoleAssignment = { kind: 'single'; choice: ModelChoice } | { kind: 'pool'; choices: readonly [ModelChoice, ...ModelChoice[]] };
export type RoleConfig = ReadonlyMap<Role, RoleAssignment>;

export function parseModelChoice(value: unknown): ModelChoice {
  if (!Check(modelChoiceSchema, value)) throw new Error(`Invalid model choice: ${String(value)}. Use inherit-parent or provider/model-id.`);
  if (value === 'inherit-parent') return { kind: 'inheritParent' };
  const slash = value.indexOf('/');
  return { kind: 'pinned', provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function formatModelChoice(choice: ModelChoice): string {
  return choice.kind === 'inheritParent' ? 'inherit-parent' : `${choice.provider}/${choice.id}`;
}

const configSchema = Type.Object({
  version: Type.Literal(1),
  roles: Type.Partial(Type.Record(roleSchema, Type.Union([modelChoiceSchema, Type.Array(modelChoiceSchema, { minItems: 1 })])), { additionalProperties: false }),
}, { additionalProperties: false });

export function parseModelConfig(text: string): RoleConfig {
  const value: unknown = JSON.parse(text);
  if (!Check(configSchema, value)) throw new Error('Invalid pstack-pi/models.json: expected {"version":1,"roles":{...}} with known role names');
  const result = new Map<Role, RoleAssignment>();
  for (const [key, raw] of Object.entries(value.roles)) {
    const role = key as Role;
    if (typeof raw === 'string') result.set(role, { kind: 'single', choice: parseModelChoice(raw) });
    else {
      const [first, ...rest] = raw;
      result.set(role, { kind: 'pool', choices: [parseModelChoice(first), ...rest.map(parseModelChoice)] });
    }
  }
  return result;
}

export function modelConfigPath(agentDir: string): string {
  return path.join(agentDir, 'pstack-pi', 'models.json');
}

// A missing file means no configured roles. A malformed file is an error the user can act on.
export async function loadModelConfig(agentDir: string): Promise<RoleConfig> {
  let text: string;
  try { text = await readFile(modelConfigPath(agentDir), 'utf-8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    throw error;
  }
  return parseModelConfig(text);
}

export type ModelSelection = { source: 'explicit' | 'role' | 'agent' | 'parent'; choice: ModelChoice };

// Precedence: explicit model, then role, then the agent's own default, then the parent.
// Pools rotate per role for the life of the extension instance.
export class ModelRouter {
  #cursors = new Map<Role, number>();
  select({ config, role, model, agentModel }: { config: RoleConfig; role?: Role; model?: string; agentModel?: string }): ModelSelection {
    if (model !== undefined) return { source: 'explicit', choice: parseModelChoice(model) };
    const assignment = role === undefined ? undefined : config.get(role);
    if (assignment?.kind === 'single') return { source: 'role', choice: assignment.choice };
    if (assignment?.kind === 'pool' && role !== undefined) {
      const index = this.#cursors.get(role) ?? 0;
      this.#cursors.set(role, (index + 1) % assignment.choices.length);
      return { source: 'role', choice: assignment.choices[index % assignment.choices.length] };
    }
    if (agentModel !== undefined) return { source: 'agent', choice: parseModelChoice(agentModel) };
    return { source: 'parent', choice: { kind: 'inheritParent' } };
  }
}
