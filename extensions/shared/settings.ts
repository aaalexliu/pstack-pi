import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';

export interface PstackSettings {
  version: 1;
  cmuxTabs: boolean;
  idleCompaction: boolean;
  [key: string]: unknown;
}

export type SettingsPatch = Partial<Pick<PstackSettings, 'cmuxTabs' | 'idleCompaction'>>;

const defaults = { version: 1, cmuxTabs: false, idleCompaction: true } as const;
const switches = ['cmuxTabs', 'idleCompaction'] as const;

export function settingsPath(agentDir: string): string {
  return path.join(agentDir, 'pstack-pi', 'settings.json');
}

export async function loadSettings(agentDir: string): Promise<PstackSettings> {
  const file = settingsPath(agentDir);
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...defaults };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || switches.some((key) => key in value && typeof (value as Record<string, unknown>)[key] !== 'boolean')) {
    throw new Error(`Invalid ${file}: expected {"version":1,"cmuxTabs":true|false,"idleCompaction":true|false}`);
  }
  return { ...defaults, ...value } as PstackSettings;
}

export async function saveSettings(agentDir: string, patch: SettingsPatch): Promise<void> {
  const file = settingsPath(agentDir);
  await withFileMutationQueue(file, async () => {
    const settings = await loadSettings(agentDir);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ ...settings, ...patch }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  });
}
