import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from '@earendil-works/pi-coding-agent';

interface PstackSettings {
  version: 1;
  cmuxTabs: boolean;
  [key: string]: unknown;
}

export function settingsPath(agentDir: string): string {
  return path.join(agentDir, 'pstack-pi', 'settings.json');
}

export async function loadSettings(agentDir: string): Promise<PstackSettings> {
  const file = settingsPath(agentDir);
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, cmuxTabs: false };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || ('cmuxTabs' in value && typeof value.cmuxTabs !== 'boolean')) {
    throw new Error(`Invalid ${file}: expected {"version":1,"cmuxTabs":true|false}`);
  }
  return { ...value, version: 1, cmuxTabs: 'cmuxTabs' in value ? value.cmuxTabs as boolean : false };
}

export async function saveCmuxTabs(agentDir: string, enabled: boolean): Promise<void> {
  const file = settingsPath(agentDir);
  await withFileMutationQueue(file, async () => {
    const settings = await loadSettings(agentDir);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ ...settings, cmuxTabs: enabled }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  });
}

export function registerCmuxSettings(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  pi.registerCommand('pstack-cmux', {
    description: 'Turn shared-pane subagent tabs on or off, or show their status',
    getArgumentCompletions: (prefix) => ['on', 'off', 'status'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      const action = args.trim() || 'status';
      if (!['on', 'off', 'status'].includes(action)) {
        ctx.ui.notify('Usage: /pstack-cmux on|off|status', 'warning');
        return;
      }
      try {
        const dir = getAgentDir();
        if (action !== 'status') await saveCmuxTabs(dir, action === 'on');
        const { cmuxTabs } = await loadSettings(dir);
        const note = cmuxTabs
          ? env.CMUX_WORKSPACE_ID ? 'New subagents open as tabs in one pane.' : 'Open Pi inside cmux to use it.'
          : 'New subagents will not open tabs. Existing tabs and agents keep running.';
        ctx.ui.notify(`Subagent tabs: ${cmuxTabs ? 'on' : 'off'}. ${note}\nSetting: ${settingsPath(dir)}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
