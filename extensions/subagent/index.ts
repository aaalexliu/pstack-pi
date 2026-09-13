import path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from './agents.ts';
import { parseDepth, requireRoot, parseRequest, reduceLimits, RunRegistry, subagentParameters } from './domain.ts';
import { boundedOutput, resolveCwd, runChild } from './runner.ts';
import { loadModelConfig, ModelRouter } from './model-config.ts';
import { captureParent, qualifyModel } from './model-runtime.ts';

export default function subagentExtension(pi: ExtensionAPI, { run = runChild }: { run?: typeof runChild } = {}) {
  let depth;
  try { depth = parseDepth(process.env.PSTACK_SUBAGENT_DEPTH); requireRoot(depth); }
  catch { return; }
  const rootDepth = depth;
  const registry = new RunRegistry();
  const router = new ModelRouter();
  pi.on('session_shutdown', async () => { await registry.shutdown(); });
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: 'Run one bundled or user leaf agent in the current directory. Only one delegation may run or stop at a time. Children cannot delegate. The host caps execution at 120 seconds and output at 32768 bytes. limits may lower timeoutMs and outputBytes; larger values clamp. Project agents and other working directories are disabled. model accepts inherit-parent or an exact provider/model-id; role selects a known configured role. Explicit model overrides role, then agent default, then parent.',
    parameters: subagentParameters,
    async execute(id, params, signal, _onUpdate, ctx) {
      const request = parseRequest(params);
      const { limits, diagnostics } = reduceLimits(request.task.limits);
      if (signal?.aborted) throw new Error('Delegation cancelled (user)');
      const lease = registry.admit(rootDepth, limits.timeoutMs);
      const abort = () => lease.cancel('user');
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) abort();
        const parent = captureParent(ctx);
        const agentDir = getAgentDir();
        const cwd = await resolveCwd({ current: ctx.cwd, supplied: request.task.cwd });
        const catalog = await discoverAgents({ userDir: path.join(agentDir, 'agents') });
        if (catalog.diagnostics.length) throw new Error('Invalid agent catalog');
        const agent = catalog.selected.get(request.task.agent);
        if (!agent) throw new Error(`Unknown agent: ${request.task.agent}. Project agents are disabled.`);
        const config = await loadModelConfig(agentDir);
        const ticket = router.prepare({ config, model: request.task.model, role: request.task.role, agentModel: agent.model });
        const model = await qualifyModel({ selection: ticket.selection, parent, agentDir, signal: lease.signal });
        lease.signal.throwIfAborted();
        const result = await run({
          identity: { id: boundedOutput(id, 128).text, agent: { name: agent.name, provenance: agent.provenance }, cwd },
          agent, task: request.task.task, depth: rootDepth, limits, lease,
          model, onStart: ticket.commit, signal: undefined,
        });
        switch (result.kind) {
          case 'succeeded': {
            const notices = [...diagnostics, ...(result.output.truncated ? [`Output truncated at ${limits.outputBytes} bytes.`] : [])];
            return {
              content: [{ type: 'text', text: result.output.text + (notices.length ? `\n[${notices.join('; ')}]` : '') }],
              details: {
                kind: result.kind, id: result.id, agent: { name: agent.name, provenance: { ...agent.provenance, path: boundedOutput(agent.provenance.path, 1024).text } },
                cwd: boundedOutput(cwd, 1024).text, usage: null, limits, diagnostics,
                model: { requested: { model: request.task.model ?? null, role: request.task.role ?? null }, selection: ticket.selection, resolved: model, observed: result.observedModel },
                output: { bytes: result.output.bytes, truncated: result.output.truncated }, cleanup: result.cleanup,
              },
            };
          }
          case 'failed':
          case 'cancelled':
            throw new Error(result.reason);
          default: {
            const exhaustive: never = result;
            return exhaustive;
          }
        }
      } catch (error) {
        const reason = lease.state.kind === 'quarantined' ? 'Delegation cleanup unverified; session quarantined'
          : lease.cancellation ? `Delegation cancelled (${lease.cancellation})`
          : error instanceof Error ? error.message : 'Delegation failed';
        throw new Error([boundedOutput(reason, 256).text, ...diagnostics].join('; '));
      } finally {
        signal?.removeEventListener('abort', abort);
        if (lease.state.kind !== 'finished' && lease.state.kind !== 'quarantined') {
          const verified = lease.state.kind === 'admitted';
          lease.verify(); lease.finish(verified);
        }
      }
    },
  });
}
