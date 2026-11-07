import { type ExtensionAPI, getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadSettings, saveSettings, settingsPath } from '../shared/settings.ts';

export function registerCmuxSettings(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  pi.registerCommand('pstack-cmux', {
    description: 'Turn parent-pane subagent tabs on or off, or show their status',
    getArgumentCompletions: (prefix) => ['on', 'off', 'status'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      const action = args.trim() || 'status';
      if (!['on', 'off', 'status'].includes(action)) {
        ctx.ui.notify('Usage: /pstack-cmux on|off|status', 'warning');
        return;
      }
      try {
        const dir = getAgentDir();
        if (action !== 'status') await saveSettings(dir, { cmuxTabs: action === 'on' });
        const { cmuxTabs } = await loadSettings(dir);
        const note = cmuxTabs
          ? env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID ? 'New subagents open as tabs in the parent Pi pane.' : 'Open Pi inside cmux to use it.'
          : 'New subagents will not open tabs. Existing tabs and agents keep running.';
        ctx.ui.notify(`Subagent tabs: ${cmuxTabs ? 'on' : 'off'}. ${note}\nSetting: ${settingsPath(dir)}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
