import path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from './agents.ts';
import { parseRequest, subagentParameters } from './domain.ts';
import { resolveCwd, runChild } from './runner.ts';

export default function subagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: 'Run one bundled or user agent in the current working directory. The bundled general-purpose agent reads files without changing them. Project agents and different working directories are not supported. Output is capped at 32 KiB. Children cannot delegate.',
    parameters: subagentParameters,
    async execute(id, params, signal, _onUpdate, ctx) {
      const request = parseRequest(params);
      const cwd = await resolveCwd({ current: ctx.cwd, supplied: request.task.cwd });
      const catalog = await discoverAgents({ userDir: path.join(getAgentDir(), 'agents') });
      if (catalog.diagnostics.length) {
        throw new Error(`Invalid agent catalog: ${JSON.stringify(catalog.diagnostics).slice(0, 4096)}`);
      }
      const agent = catalog.selected.get(request.task.agent);
      if (!agent) throw new Error(`Unknown agent: ${request.task.agent}. Project agents are disabled.`);
      if (!ctx.model) throw new Error('Delegation requires an active parent model');
      const result = await runChild({
        identity: { id, agent: { name: agent.name, provenance: agent.provenance }, cwd },
        agent, task: request.task.task,
        model: { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: ctx.thinkingLevel }, signal,
      });
      switch (result.kind) {
        case 'succeeded':
          return { content: [{ type: 'text', text: result.output.text + (result.output.truncated ? '\n[Output truncated at 32 KiB.]' : '') }], details: result };
        case 'failed':
        case 'cancelled':
          throw new Error(JSON.stringify(result));
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    },
  });
}
