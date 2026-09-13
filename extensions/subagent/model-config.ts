import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
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
  maxLength: 321,
  pattern: '^(?:inherit-parent|[a-z0-9][a-z0-9.-]{0,63}/[A-Za-z0-9@][A-Za-z0-9._:@/+\\-]{0,255})$(?![\\s\\S])',
});
export type ModelChoice = { kind: 'inheritParent' } | { kind: 'pinned'; provider: string; id: string };
export type RoleAssignment = { kind: 'single'; choice: ModelChoice } | { kind: 'pool'; choices: readonly [ModelChoice, ...ModelChoice[]] };
export type RoleConfig = ReadonlyMap<Role, RoleAssignment>;

export function parseModelChoice(value: unknown): ModelChoice {
  if (!Check(modelChoiceSchema, value)) throw new Error('Invalid exact model choice');
  if (value === 'inherit-parent') return { kind: 'inheritParent' };
  const slash = value.indexOf('/');
  return { kind: 'pinned', provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function parseRole(value: unknown): Role {
  if (!Check(roleSchema, value)) throw new Error('Unknown model role');
  return value;
}

export function parseStrictJson(bytes: Uint8Array, maxBytes = 64 * 1024): unknown {
  if (bytes.length > maxBytes) throw new Error('JSON exceeds byte limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const stack: (Set<string> | null)[] = [];
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu)];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i][0];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
      if (stack.length > 32) throw new Error('JSON nesting exceeds 32');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1]?.[0] === ':') {
      const keys = stack[stack.length - 1];
      const key: unknown = JSON.parse(token);
      if (!keys || typeof key !== 'string' || keys.has(key)) throw new Error('Duplicate JSON key');
      keys.add(key);
    }
  }
  return value;
}

const configSchema = Type.Object({
  version: Type.Literal(1),
  roles: Type.Partial(Type.Record(roleSchema, Type.Union([
    modelChoiceSchema, Type.Array(modelChoiceSchema, { minItems: 1, maxItems: 64 }),
  ]), { additionalProperties: false })),
}, { additionalProperties: false });

export function parseModelConfig(bytes: Uint8Array): RoleConfig {
  const value = parseStrictJson(bytes);
  if (!Check(configSchema, value)) throw new Error('Invalid version-1 model config');
  const result = new Map<Role, RoleAssignment>();
  for (const [key, raw] of Object.entries(value.roles)) {
    const role = parseRole(key);
    if (typeof raw === 'string') result.set(role, { kind: 'single', choice: parseModelChoice(raw) });
    else {
      const [first, ...rest] = raw;
      result.set(role, { kind: 'pool', choices: [parseModelChoice(first), ...rest.map(parseModelChoice)] });
    }
  }
  return result;
}

function safeStat(stat: Stats, directory: boolean): void {
  if (process.getuid === undefined || stat.uid !== process.getuid() || (stat.mode & 0o7022) !== 0
    || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe model config ownership, mode, or file type');
}

export async function readConfigFile(filename: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('Cannot open model config safely');
  }
  try {
    const before = await handle.stat();
    safeStat(before, false);
    if (before.size > maxBytes) throw new Error('Model config exceeds byte limit');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    safeStat(after, false);
    if (length > maxBytes || length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Model config changed or exceeds byte limit');
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function loadModelConfig(agentDir: string): Promise<RoleConfig> {
  const directory = path.join(agentDir, 'pstack-pi');
  let handle;
  try { handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    throw new Error('Unsafe pstack-pi directory');
  }
  try {
    const before = await handle.stat();
    safeStat(before, true);
    const bytes = await readConfigFile(path.join(directory, 'models.json'), 64 * 1024);
    const after = await lstat(directory);
    safeStat(after, true);
    if (before.ino !== after.ino || before.dev !== after.dev || before.ctimeMs !== after.ctimeMs) throw new Error('pstack-pi directory changed');
    return bytes === undefined ? new Map() : parseModelConfig(bytes);
  } finally { await handle.close(); }
}

export type ModelSelection = { source: 'explicit' | 'role' | 'agent' | 'parent'; choice: ModelChoice };
export type RoutingTicket = { selection: ModelSelection; commit: () => void };

export class ModelRouter {
  #roles = new Map<Role, { assignment: string; next: number }>();
  prepare({ config, role, model, agentModel }: { config: RoleConfig; role?: string; model?: string; agentModel?: string }): RoutingTicket {
    const requestedRole = role === undefined ? undefined : parseRole(role);
    const explicit = model === undefined ? undefined : parseModelChoice(model);
    const fallback = agentModel === undefined ? undefined : parseModelChoice(agentModel);
    for (const known of roles) {
      const assignment = config.get(known);
      const normalized = JSON.stringify(assignment);
      if (!assignment) this.#roles.delete(known);
      else if (this.#roles.get(known)?.assignment !== normalized) this.#roles.set(known, { assignment: normalized, next: 0 });
    }
    let selection: ModelSelection;
    let advance = () => {};
    const assignment = requestedRole === undefined ? undefined : config.get(requestedRole);
    if (explicit) selection = { source: 'explicit', choice: explicit };
    else if (assignment) {
      if (assignment.kind === 'single') selection = { source: 'role', choice: assignment.choice };
      else {
        const state = requestedRole === undefined ? undefined : this.#roles.get(requestedRole);
        if (!state) throw new Error('Missing role counter');
        const index = state.next;
        const choice = assignment.choices[index] ?? assignment.choices[0];
        selection = { source: 'role', choice };
        advance = () => {
          if (state.next !== index) throw new Error('Stale routing ticket');
          state.next = (index + 1) % assignment.choices.length;
        };
      }
    } else selection = fallback ? { source: 'agent', choice: fallback } : { source: 'parent', choice: { kind: 'inheritParent' } };
    let committed = false;
    return { selection, commit() { if (committed) throw new Error('Routing ticket already committed'); advance(); committed = true; } };
  }
}
