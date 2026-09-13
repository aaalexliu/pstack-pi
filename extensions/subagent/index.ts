import path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from './agents.ts';
import { parseDepth, requireRoot, parseRequest, reduceLimits, subagentParameters, type TaskResult } from './domain.ts';
import { boundedOutput, resolveCwd, runChild } from './runner.ts';
import { loadModelConfig, ModelRouter } from './model-config.ts';
import { captureParent, qualifyModel } from './model-runtime.ts';
import { PiInvocation } from './process.ts';
import { DelegationScheduler, outputQuota, type ResolvedTask } from './scheduler.ts';

class BatchExecutionError extends Error {}

function taskMetadata(task: ResolvedTask, result: TaskResult) {
  return {
    kind: result.kind, id: result.id,
    agent: { name: task.agent.name, provenance: { ...task.agent.provenance, path: boundedOutput(task.agent.provenance.path, 1024).text } },
    cwd: boundedOutput(task.identity.cwd, 1024).text, usage: null, limits: task.limits,
    model: { requested: task.requested, selection: task.selection, resolved: task.model, observed: result.observedModel },
    output: { bytes: result.output.bytes, truncated: result.output.truncated }, cleanup: result.cleanup,
  };
}
function resultText(result: TaskResult, index: number): string {
  const text = result.kind === 'succeeded' ? result.output.text : boundedOutput(result.reason, 256).text;
  return `[${index + 1}] ${result.agent.name} ${result.kind}\n${text}${result.output.truncated ? '\n[Output truncated.]' : ''}`;
}

export default function subagentExtension(pi: ExtensionAPI, { run = runChild, pin = () => PiInvocation.resolve() }: {
  run?: typeof runChild; pin?: () => Promise<PiInvocation>;
} = {}) {
  let depth;
  try { depth = parseDepth(process.env.PSTACK_SUBAGENT_DEPTH); requireRoot(depth); }
  catch { return; }
  const rootDepth = depth;
  const scheduler = new DelegationScheduler();
  const router = new ModelRouter();
  pi.on('session_shutdown', () => scheduler.shutdown());
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: 'Run one leaf agent or an atomic tasks batch of 1-8 bundled or user agents. At most four children run at once, in FIFO order. Only one request may prepare, run, or stop at a time. Children cannot delegate. A 120-second request deadline includes queue time. The 32768-byte retained-output budget is split by input index. limits may lower timeoutMs and outputBytes; larger values clamp. Each task is at most 32768 UTF-8 bytes, all task text at most 131072 bytes, and the JSON request at most 163840 bytes. Project agents, other working directories, and chains are disabled. model accepts inherit-parent or an exact provider/model-id; role selects a known configured role. Explicit model overrides role, then agent default, then parent. Results retain input order. Any non-success throws an ordered summary.',
    parameters: subagentParameters,
    async execute(id, params, signal, _onUpdate, ctx) {
      const lease = scheduler.reserve(rootDepth);
      const abort = () => lease.cancel('user');
      signal?.addEventListener('abort', abort, { once: true });
      let diagnostics: string[] = [];
      try {
        if (signal?.aborted) abort();
        lease.check();
        const parent = captureParent(ctx);
        const request = parseRequest(params);
        const input = request.kind === 'single' ? { tasks: [request.task], cwd: request.task.cwd, limits: request.task.limits } : request.request;
        const reduced = reduceLimits(input.limits);
        const limits = reduced.limits;
        diagnostics = reduced.diagnostics;
        lease.lowerDeadline(limits.timeoutMs);
        const agentDir = getAgentDir();
        const cwd = await resolveCwd({ current: ctx.cwd, supplied: input.cwd });
        const catalog = await discoverAgents({ userDir: path.join(agentDir, 'agents') });
        if (catalog.diagnostics.length) throw new Error('Invalid agent catalog');
        const agents = input.tasks.map((task) => {
          const agent = catalog.selected.get(task.agent);
          if (!agent) throw new Error(`Unknown agent: ${task.agent}. Project agents are disabled.`);
          return agent;
        });
        const config = await loadModelConfig(agentDir);
        const ticket = router.prepareBatch(config, input.tasks.map((task, index) => ({ model: task.model, role: task.role, agentModel: agents[index].model })));
        const models: Awaited<ReturnType<typeof qualifyModel>>[] = [];
        for (const selection of ticket.selections) {
          models.push(await qualifyModel({ selection, parent, agentDir, signal: lease.signal }));
        }
        const invocation = await pin();
        const batch: ResolvedTask[] = input.tasks.map((task, index) => ({
          identity: { id: request.kind === 'single' ? boundedOutput(id, 128).text : `${boundedOutput(id, 120).text}/${index + 1}`, agent: { name: agents[index].name, provenance: agents[index].provenance }, cwd },
          agent: agents[index], task: task.task, depth: rootDepth, invocation,
          limits: { ...limits, outputBytes: outputQuota(limits.outputBytes, input.tasks.length, index) }, model: models[index],
          requested: { model: task.model ?? null, role: task.role ?? null }, selection: ticket.selections[index],
        }));
        lease.admit(batch, ticket.commit);
        const results = await lease.run(run);
        if (results.some((result) => result.kind !== 'succeeded')) {
          throw new BatchExecutionError([...results.map(resultText), ...diagnostics].join('\n\n'));
        }
        const metadata = results.map((result, index) => taskMetadata(batch[index], result));
        if (request.kind === 'single') {
          const [result] = results;
          const notices = [...diagnostics, ...(result.output.truncated ? [`Output truncated at ${limits.outputBytes} bytes.`] : [])];
          return {
            content: [{ type: 'text', text: result.output.text + (notices.length ? `\n[${notices.join('; ')}]` : '') }],
            details: { ...metadata[0], diagnostics },
          };
        }
        return {
          content: [{ type: 'text', text: [...results.map(resultText), ...diagnostics].join('\n\n') }],
          details: { kind: 'parallel', usage: null, limits, diagnostics, tasks: metadata },
        };
      } catch (error) {
        if (error instanceof BatchExecutionError) throw error;
        const reason = lease.state === 'quarantined' ? 'Delegation cleanup unverified; session quarantined'
          : lease.cancellation ? `Delegation cancelled (${lease.cancellation})`
          : error instanceof Error ? error.message : 'Delegation failed';
        throw new Error([boundedOutput(reason, 256).text, ...diagnostics].join('; '));
      } finally {
        signal?.removeEventListener('abort', abort);
        lease.finish();
      }
    },
  });
}
