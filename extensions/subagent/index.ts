import path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from './agents.ts';
import { executionLimits, parseDepth, requireRoot, parseRequest, reduceLimits, subagentParameters, type TaskResult } from './domain.ts';
import { boundedOutput, resolveCwd, runChild } from './runner.ts';
import { loadModelConfig, ModelRouter } from './model-config.ts';
import { captureParent, qualifyModel } from './model-runtime.ts';
import { PiInvocation } from './process.ts';
import { DelegationScheduler, immutable, outputQuota, type ResolvedTask } from './scheduler.ts';
import { aggregateUsage, type Usage } from './usage.ts';

const failureLimits = Object.freeze({ records: 32, envelopeBytes: 64 * 1024, retentionMs: 30_000 });
type Envelope = { content: [{ type: 'text'; text: string }]; details: unknown; usage: Usage };
type OwnedFailure = { input: object; toolCallId: string } & (
  | { kind: 'running' }
  | { kind: 'failed'; envelope: Envelope; expiresAt: number }
);
class BatchExecutionError extends Error {}

function jsonText(parts: Iterable<string>, bytes: number, jsonBytes: number): string {
  let text = '';
  for (const part of parts) {
    for (const char of part) {
      const raw = Buffer.byteLength(char);
      const encoded = Buffer.byteLength(JSON.stringify(char)) - 2;
      if (raw > bytes || encoded > jsonBytes) return text;
      text += char;
      bytes -= raw;
      jsonBytes -= encoded;
    }
  }
  return text;
}
function envelope(parts: string[], details: unknown, usage: Usage): Envelope {
  const result: Envelope = { content: [{ type: 'text', text: '' }], details, usage };
  const available = failureLimits.envelopeBytes - Buffer.byteLength(JSON.stringify({ ...result, isError: true }));
  if (available < 0) throw new Error('Delegation result metadata exceeds byte limit');
  result.content[0].text = jsonText(parts, executionLimits.outputBytes, available);
  return result;
}
function taskMetadata(task: ResolvedTask, result: TaskResult) {
  return {
    kind: result.kind, id: result.id,
    agent: { name: task.agent.name, provenance: { ...task.agent.provenance, path: jsonText([task.agent.provenance.path], 512, 512) } },
    cwd: jsonText([task.identity.cwd], 512, 512), usage: result.usage, limits: task.limits,
    model: { requested: task.requested, selection: task.selection, resolved: task.model, observed: result.observedModel },
    output: { bytes: result.output.bytes, truncated: result.output.truncated }, cleanup: result.cleanup,
    ...(result.kind !== 'succeeded' ? { reason: boundedOutput(result.reason, 256).text } : {}),
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
  const inputs = new WeakMap<object, symbol>();
  const owned = new Map<symbol, OwnedFailure>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const erase = (key: symbol | undefined) => {
    if (key === undefined) return;
    const record = owned.get(key);
    if (record) inputs.delete(record.input);
    owned.delete(key);
    if (![...owned.values()].some((record) => record.kind === 'failed')) { clearTimeout(timer); timer = undefined; }
  };
  const expire = () => {
    timer = undefined;
    const now = performance.now();
    for (const [key, record] of owned) if (record.kind === 'failed' && record.expiresAt <= now) erase(key);
    armExpiry();
  };
  const armExpiry = () => {
    if (closed || timer) return;
    const times = [...owned.values()].flatMap((record) => record.kind === 'failed' ? [record.expiresAt] : []);
    if (times.length) timer = setTimeout(expire, Math.max(0, Math.min(...times) - performance.now())).unref();
  };
  pi.on('session_shutdown', () => {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    for (const key of owned.keys()) erase(key);
    return scheduler.shutdown();
  });
  pi.on('tool_result', (event): (Envelope & { isError: true }) | undefined => {
    if (event.toolName !== 'subagent') return;
    const key = inputs.get(event.input);
    const record = key === undefined ? undefined : owned.get(key);
    if (closed || record?.kind !== 'failed') return;
    erase(key);
    if (record.expiresAt <= performance.now() || record.toolCallId !== event.toolCallId || event.isError !== true
      || event.usage !== undefined || event.details === null || typeof event.details !== 'object' || Array.isArray(event.details)
      || Object.keys(event.details).length !== 0 || event.content.length !== 1) return;
    const [content] = event.content;
    if (content.type !== 'text' || content.text !== record.envelope.content[0].text
      || Object.keys(content).length !== 2) return;
    return { ...record.envelope, isError: true };
  });
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: 'Run one leaf agent or an atomic tasks batch of 1-8 bundled or user agents. At most four children run at once, in FIFO order. Only one request may prepare, run, or stop at a time. Children cannot delegate. A 120-second request deadline includes queue time. The 32768-byte retained-output budget is split by input index. limits may lower timeoutMs and outputBytes; larger values clamp. Each task is at most 32768 UTF-8 bytes, all task text at most 131072 bytes, and the JSON request at most 163840 bytes. Project agents, other working directories, and chains are disabled. model accepts inherit-parent or an exact provider/model-id; role selects a known configured role. Explicit model overrides role, then agent default, then parent. Results retain input order. Any non-success is an error with ordered details and known Pi-reported usage.',
    parameters: subagentParameters,
    async execute(id, params, signal, _onUpdate, ctx) {
      const lease = scheduler.reserve(rootDepth);
      const abort = () => lease.cancel('user');
      signal?.addEventListener('abort', abort, { once: true });
      let diagnostics: string[] = [];
      let key: symbol | undefined;
      let failedEnvelope: Envelope | undefined;
      try {
        if (signal?.aborted) abort();
        lease.check();
        const request = immutable(structuredClone(parseRequest(params)));
        if (closed || owned.size >= failureLimits.records || inputs.has(params)) throw new Error('Delegation result capacity unavailable');
        key = Symbol();
        inputs.set(params, key);
        owned.set(key, { input: params, toolCallId: id, kind: 'running' });
        const parent = captureParent(ctx);
        const input = request.kind === 'single' ? { tasks: [request.task], cwd: request.task.cwd, limits: request.task.limits } : request.request;
        const reduced = reduceLimits(input.limits);
        const limits = reduced.limits;
        diagnostics = reduced.diagnostics;
        lease.lowerDeadline(limits.timeoutMs);
        const agentDir = getAgentDir();
        const cwd = await lease.wait(() => resolveCwd({ current: ctx.cwd, supplied: input.cwd }));
        const catalog = await lease.wait(() => discoverAgents({ userDir: path.join(agentDir, 'agents') }));
        if (catalog.diagnostics.length) throw new Error('Invalid agent catalog');
        const agents = input.tasks.map((task) => {
          const agent = catalog.selected.get(task.agent);
          if (!agent) throw new Error(`Unknown agent: ${task.agent}. Project agents are disabled.`);
          return agent;
        });
        const config = await lease.wait(() => loadModelConfig(agentDir));
        const ticket = router.prepareBatch(config, input.tasks.map((task, index) => ({ model: task.model, role: task.role, agentModel: agents[index].model })));
        const models: Awaited<ReturnType<typeof qualifyModel>>[] = [];
        for (const selection of ticket.selections) {
          models.push(await lease.wait(() => qualifyModel({ selection, parent, agentDir, signal: lease.signal })));
        }
        const invocation = await lease.wait(pin);
        const batch: ResolvedTask[] = input.tasks.map((task, index) => ({
          identity: { id: request.kind === 'single' ? boundedOutput(id, 128).text : `${boundedOutput(id, 120).text}/${index + 1}`, agent: { name: agents[index].name, provenance: agents[index].provenance }, cwd },
          agent: agents[index], task: task.task, depth: rootDepth, invocation,
          limits: { ...limits, outputBytes: outputQuota(limits.outputBytes, input.tasks.length, index) }, model: models[index],
          requested: { model: task.model ?? null, role: task.role ?? null }, selection: ticket.selections[index],
        }));
        lease.admit(batch, ticket.commit);
        const results = await lease.run(run);
        const aggregate = aggregateUsage(results.map((result) => result.usage));
        if (aggregate.overflow) diagnostics.push('Usage overflow; aggregate contains only representable known charges');
        const metadata = results.map((result, index) => taskMetadata(batch[index], result));
        const failed = aggregate.overflow || results.some((result) => result.kind !== 'succeeded');
        const details = request.kind === 'single' ? { ...metadata[0], diagnostics }
          : { kind: 'parallel', limits, diagnostics, tasks: metadata };
        if (failed) {
          failedEnvelope = envelope([...results.map(resultText), ...diagnostics].flatMap((text, index) => index ? ['\n\n', text] : [text]), details, aggregate.usage);
          throw new BatchExecutionError(failedEnvelope.content[0].text);
        }
        if (request.kind === 'single') {
          const [result] = results;
          const notices = [...diagnostics, ...(result.output.truncated ? [`Output truncated at ${limits.outputBytes} bytes.`] : [])];
          return envelope([result.output.text, ...(notices.length ? [`\n[${notices.join('; ')}]`] : [])], details, aggregate.usage);
        }
        return envelope([...results.map(resultText), ...diagnostics].flatMap((text, index) => index ? ['\n\n', text] : [text]), details, aggregate.usage);
      } catch (error) {
        if (error instanceof BatchExecutionError) throw error;
        failedEnvelope = undefined;
        const reason = lease.state === 'quarantined' ? 'Delegation cleanup unverified; session quarantined'
          : lease.cancellation ? `Delegation cancelled (${lease.cancellation})`
          : error instanceof Error ? error.message : 'Delegation failed';
        throw new Error([boundedOutput(reason, 256).text, ...diagnostics].join('; '));
      } finally {
        signal?.removeEventListener('abort', abort);
        try { lease.finish(); }
        catch (error) { erase(key); throw error; }
        if (!closed && key !== undefined && owned.has(key) && failedEnvelope) {
          owned.set(key, { input: params, toolCallId: id, kind: 'failed', envelope: immutable(failedEnvelope), expiresAt: performance.now() + failureLimits.retentionMs });
          armExpiry();
        } else erase(key);
      }
    },
  });
}
