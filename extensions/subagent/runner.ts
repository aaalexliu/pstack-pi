import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { executionLimits, protocolLimits, parseDepth, requireRoot, RunRegistry, type RunLease, type DelegationDepth, type ExecutionLimits, type Agent, type BoundedOutput, type CanonicalCwd, type TaskIdentity, type TaskResult } from './domain.ts';
import { childEnvironment, OwnedProcessTree, PiInvocation, ProcessOwnershipError, type CleanupReport, type ProcessBackend } from './process.ts';
import { parseModelChoice } from './model-config.ts';
import type { ChildModel, ModelIdentity } from './model-runtime.ts';

export async function resolveCwd({ current, supplied }: { current: string; supplied?: string }): Promise<CanonicalCwd> {
  const canonical = await realpath(current);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Current cwd is not a directory');
  if (supplied !== undefined) {
    if (!supplied || supplied.includes('\0')) throw new Error('Invalid cwd');
    const absolute = path.isAbsolute(supplied) ? supplied : `${canonical}${path.sep}${supplied}`;
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep)) {
      if (!part || part === '.') continue;
      cursor = part === '..' ? path.dirname(cursor) : path.join(cursor, part);
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Supplied cwd must not contain symlinks or non-directories');
    }
    if (await realpath(cursor) !== canonical) throw new Error('Supplied cwd differs from current cwd');
  }
  return canonical as CanonicalCwd;
}

const assistantSchema = Type.Object({
  role: Type.Literal('assistant'),
  stopReason: Type.Enum(['stop', 'length', 'toolUse', 'error', 'aborted']),
  content: Type.Array(Type.Union([
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
    Type.Object({ type: Type.Literal('thinking'), thinking: Type.String() }),
    Type.Object({ type: Type.Literal('toolCall'), id: Type.String(), name: Type.String(), arguments: Type.Unknown() }),
  ])),
  errorMessage: Type.Optional(Type.String()),
  provider: Type.String(),
  model: Type.String(),
});
const eventSchema = Type.Object({ type: Type.String() });
const messageEventSchema = Type.Object({ type: Type.Literal('message_end'), message: Type.Object({ role: Type.Enum(['user', 'assistant', 'toolResult']) }) });
const eventTypes = new Set(['session', 'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'auto_compaction_start', 'auto_compaction_end', 'auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end', 'queue_update']);

export function boundedOutput(text: string, limit = executionLimits.outputBytes): BoundedOutput {
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  const buffer = Buffer.from(text);
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), bytes, truncated: true };
}

export function childOutputParser(expected?: ModelIdentity) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  let count = 0;
  let final: Static<typeof assistantSchema> | undefined;
  let settled = false;
  return {
    write(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > protocolLimits.stdoutBytes) throw new Error('Child stdout limit exceeded');
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > protocolLimits.lineBytes) throw new Error('Child JSONL line limit exceeded');
        if (++count > protocolLimits.events) throw new Error('Child event limit exceeded');
        const event: unknown = JSON.parse(line);
        if (!Check(eventSchema, event) || !eventTypes.has(event.type)) throw new Error('Invalid child event');
        if (settled) throw new Error('Child event after settled');
        if (event.type === 'agent_settled') settled = true;
        if (event.type === 'message_end') {
          if (!Check(messageEventSchema, event)) throw new Error('Invalid child message event');
          if (event.message.role === 'assistant') {
            if (!Check(assistantSchema, event.message)) throw new Error('Invalid child assistant message');
            if (expected && (event.message.provider !== expected.provider || event.message.model !== expected.id)) throw new Error('Child model differs from resolved model');
            final = event.message;
          }
        }
      }
      if (Buffer.byteLength(pending) > protocolLimits.lineBytes) throw new Error('Child JSONL line limit exceeded');
    },
    end() {
      pending += decoder.decode();
      if (pending !== '') throw new Error('Child JSONL ended without LF');
      if (!settled || !final) throw new Error('Child has no settled final assistant message');
      return final;
    },
  };
}

export function childArguments({ agent, model, promptFile }: { agent: Agent; model: ChildModel; promptFile: string }): string[] {
  const parsed = parseModelChoice(`${model.provider}/${model.id}`);
  if (parsed.kind !== 'pinned' || parsed.provider !== model.provider || parsed.id !== model.id) throw new Error('Invalid exact model identity');
  const args = ['--mode', 'json', '--print', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline', '--provider', model.provider, '--model', model.id];
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinkingLevel)) throw new Error('Invalid child thinking level');
  args.push('--thinking', model.thinkingLevel);
  args.push(...(agent.tools.length ? ['--tools', agent.tools.join(',')] : ['--no-tools']));
  args.push('--system-prompt', promptFile, '--append-system-prompt', '');
  return args;
}

export async function runChild({ identity, agent, task, model, signal, depth = parseDepth(undefined), limits = executionLimits, lease = new RunRegistry().admit(depth, limits.timeoutMs), invocation, backend, onStart }: {
  identity: TaskIdentity; agent: Agent; task: string; model: ChildModel; signal: AbortSignal | undefined;
  depth?: DelegationDepth; limits?: ExecutionLimits; lease?: RunLease; invocation?: PiInvocation; backend?: ProcessBackend; onStart?: () => void;
}): Promise<TaskResult> {
  let temporary: string | undefined;
  let owner: OwnedProcessTree | undefined;
  let cleanup: CleanupReport = { verified: true, durationMs: 0, identities: [], forced: false };
  let failure: string | undefined;
  let output = boundedOutput('');
  let observedModel: ModelIdentity | null = null;
  const abort = () => lease.cancel('user');
  const stop = () => { if (lease.cancellation) owner?.requestStop({ kind: 'cancelled', reason: lease.cancellation }); };
  signal?.addEventListener('abort', abort, { once: true });
  lease.signal.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) abort();
  try {
    requireRoot(depth);
    lease.signal.throwIfAborted();
    lease.prepare();
    const pinned = invocation ?? await PiInvocation.resolve();
    lease.signal.throwIfAborted();
    temporary = await mkdtemp(path.join(tmpdir(), 'pstack-subagent-'));
    const promptFile = path.join(temporary, 'system.md');
    await writeFile(promptFile, agent.systemPrompt, { mode: 0o600, flag: 'wx' });
    const args = childArguments({ agent, model, promptFile });
    lease.signal.throwIfAborted();
    lease.run();
    owner = new OwnedProcessTree({ invocation: pinned, args, cwd: identity.cwd, env: childEnvironment(depth), lease, backend });
    if (owner.child.pid !== undefined && !owner.failure && !lease.signal.aborted) onStart?.();
    const child = owner.child;
    const parser = childOutputParser(model);
    const fail = (reason: string) => { failure ??= reason; owner?.requestStop({ kind: 'failed', reason }); };
    const stdout = (chunk: Buffer) => {
      if (failure) return;
      try { parser.write(chunk); } catch { fail('Invalid or excessive child protocol output'); }
    };
    let stderrBytes = 0;
    const stderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > protocolLimits.stderrBytes) fail('Child stderr limit exceeded');
    };
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    try {
      stop();
      child.stdin.end(task);
      await owner.ready;
      cleanup = await owner.cleanup();
    } finally {
      child.stdout.removeListener('data', stdout);
      child.stderr.removeListener('data', stderr);
    }
    failure ??= owner.failure;
    if (!failure && !lease.cancellation) {
      try {
        const final = parser.end();
        observedModel = { provider: final.provider, id: final.model };
        if (final.stopReason !== 'stop') failure = `Child stopped with ${final.stopReason}`;
        else output = boundedOutput(final.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), limits.outputBytes);
      } catch { failure = 'Child has no valid settled final response'; }
      if (owner.exitCode !== 0 || owner.exitSignal !== null) failure ??= 'Child exited unsuccessfully';
    }
  } catch (error) {
    if (error instanceof ProcessOwnershipError) cleanup = { ...cleanup, verified: false };
    failure ??= 'Delegation preparation or execution failed';
    if (owner) {
      owner.requestStop({ kind: 'failed', reason: failure });
      cleanup = await owner.cleanup();
    }
  } finally {
    if (temporary) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch { cleanup = { ...cleanup, verified: false }; }
    }
    signal?.removeEventListener('abort', abort);
    lease.signal.removeEventListener('abort', stop);
    lease.verify();
    lease.finish(cleanup.verified);
  }
  const base = { ...identity, output, diagnostics: [], usage: null, observedModel,
    cleanup: { verified: cleanup.verified, durationMs: cleanup.durationMs, forced: cleanup.forced, observedProcesses: cleanup.identities.length },
  } satisfies Omit<TaskResult, 'kind'>;
  if (!cleanup.verified) return { ...base, output: boundedOutput(''), kind: 'failed', reason: 'Delegation cleanup unverified; session quarantined' };
  if (lease.cancellation) return { ...base, output: boundedOutput(''), kind: 'cancelled', reason: `Delegation cancelled (${lease.cancellation})` };
  if (failure) return { ...base, output: boundedOutput(''), kind: 'failed', reason: failure };
  return { ...base, kind: 'succeeded' };
}
