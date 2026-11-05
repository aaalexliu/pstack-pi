import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const profileVariable = 'PI_AUTH_PROFILE';
export const defaultProfileName = 'default';
export const profileStatusKey = 'auth-profile';

export interface Profile {
  name: string;
  dirs: string[];
  providers: string[];
}

export interface ProfileConfig {
  profiles: Profile[];
  error?: string;
}

export type ProfileSource = 'inherited' | 'directory' | 'none';

export interface ProfileSelection {
  profile: Profile | undefined;
  source: ProfileSource;
  warning?: string;
}

const profileName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function profileConfigPath(agentDir: string): string {
  return join(agentDir, 'pstack-pi', 'profiles.json');
}

export function profileAuthPath(agentDir: string, name: string): string {
  return join(agentDir, 'pstack-pi', 'profiles', name, 'auth.json');
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

export function parseProfileConfig(text: string, home = homedir()): ProfileConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { profiles: [], error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const entries = (parsed as { profiles?: unknown } | null)?.profiles;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    return { profiles: [], error: 'expected { "profiles": { "<name>": { "dirs": [...], "providers": [...] } } }' };
  }
  const profiles: Profile[] = [];
  for (const [name, value] of Object.entries(entries)) {
    const { dirs, providers } = (value ?? {}) as { dirs?: unknown; providers?: unknown };
    if (!profileName.test(name) || name === defaultProfileName) {
      return { profiles: [], error: `profile "${name}" must be a lowercase slug other than "${defaultProfileName}"` };
    }
    if (!strings(dirs) || !strings(providers) || providers.length === 0) {
      return { profiles: [], error: `profile "${name}" needs string arrays "dirs" and a non-empty "providers"` };
    }
    const expanded = dirs.map((dir) => expandHome(dir, home));
    const relative = expanded.find((dir) => !isAbsolute(dir));
    if (relative !== undefined) return { profiles: [], error: `profile "${name}" dir "${relative}" must be absolute or start with ~/` };
    profiles.push({ name, dirs: expanded.map(canonical), providers: [...new Set(providers)] });
  }
  return { profiles };
}

export function loadProfileConfig(agentDir: string, home = homedir()): ProfileConfig {
  let text: string;
  try {
    text = readFileSync(profileConfigPath(agentDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [] };
    return { profiles: [], error: error instanceof Error ? error.message : String(error) };
  }
  return parseProfileConfig(text, home);
}

function contains(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

export function selectProfile(config: ProfileConfig, cwd: string, inherited: string | undefined): ProfileSelection {
  if (inherited !== undefined) {
    if (inherited === defaultProfileName) return { profile: undefined, source: 'inherited' };
    const profile = config.profiles.find((candidate) => candidate.name === inherited);
    if (profile) return { profile, source: 'inherited' };
    return { profile: undefined, source: 'inherited', warning: `${profileVariable}=${inherited} names no configured profile; using the default logins` };
  }
  const path = canonical(cwd);
  let best: { profile: Profile; length: number } | undefined;
  for (const profile of config.profiles) {
    for (const dir of profile.dirs) {
      if (contains(dir, path) && dir.length > (best?.length ?? -1)) best = { profile, length: dir.length };
    }
  }
  return best ? { profile: best.profile, source: 'directory' } : { profile: undefined, source: 'none' };
}

const launchKey = Symbol.for('pstack-pi.profiles.launch');

/**
 * The profile a parent Pi passed down, read once per process. Later sessions in this
 * process re-select by folder, so the value must be captured before the first
 * session_start exports this process's own choice for its children.
 */
export function launchProfile(env: NodeJS.ProcessEnv = process.env, holder: object = globalThis): string | undefined {
  const slot = holder as { [launchKey]?: { value: string | undefined } };
  slot[launchKey] ??= { value: env[profileVariable]?.trim() || undefined };
  return slot[launchKey].value;
}

export function exportProfile(selection: ProfileSelection, env: NodeJS.ProcessEnv = process.env): void {
  env[profileVariable] = selection.profile?.name ?? defaultProfileName;
}

export function aliasProviderId(base: string, profile: string): string {
  return `${base}-${profile}`;
}
