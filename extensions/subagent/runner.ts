import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executionLimits, protocolLimits, parseDepth, requireRoot, RunRegistry, type RunLease, type DelegationDepth, type ExecutionLimits, type Agent, type CanonicalCwd, type TaskIdentity, type TaskResult } from './domain.ts';
import { childEnvironment, cleanupLimits, OwnedProcessTree, PiInvocation, ProcessOwnershipError, type CleanupReport, type ProcessBackend } from './process.ts';
import { parseModelChoice } from './model-config.ts';
import type { ChildModel, ModelIdentity } from './model-runtime.ts';
import { boundedOutput, childOutputParser } from './protocol.ts';
import { usageReport } from './usage.ts';
export { boundedOutput } from './protocol.ts';

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

const promptBackend = { mkdtemp, writeFile, rm };
export type PromptBackend = typeof promptBackend;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

class PrivatePrompt {
  readonly ready: Promise<string>;
  readonly #files: PromptBackend;
  #directory: string | undefined;
  constructor(text: string, signal: AbortSignal, files: PromptBackend) {
    this.#files = files;
    this.ready = (async () => {
      this.#directory = await files.mkdtemp(path.join(tmpdir(), 'pstack-subagent-'));
      signal.throwIfAborted();
      const filename = path.join(this.#directory, 'system.md');
      await files.writeFile(filename, text, { mode: 0o600, flag: 'wx', signal });
      return filename;
    })();
  }
  async remove(): Promise<void> {
    const removal = (async () => {
      try { await this.ready; } catch {}
      if (this.#directory) await this.#files.rm(this.#directory, { recursive: true, force: true });
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([removal, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Prompt cleanup deadline exceeded')), cleanupLimits.verifyMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}

export async function runChild({ identity, agent, task, model, signal, depth = parseDepth(undefined), limits = executionLimits, lease = new RunRegistry().admit(depth, limits.timeoutMs), invocation, backend, onStart, promptFiles = promptBackend }: {
  identity: TaskIdentity; agent: Agent; task: string; model: ChildModel; signal: AbortSignal | undefined;
  depth?: DelegationDepth; limits?: ExecutionLimits; lease?: RunLease; invocation?: PiInvocation; backend?: ProcessBackend; onStart?: () => void; promptFiles?: PromptBackend;
}): Promise<TaskResult> {
  let prompt: PrivatePrompt | undefined;
  let owner: OwnedProcessTree | undefined;
  let cleanup: CleanupReport = { verified: true, durationMs: 0, identities: [], forced: false };
  let failure: string | undefined;
  const diagnostics: string[] = [];
  let output = boundedOutput('');
  let observedModel: ModelIdentity | null = null;
  const parser = childOutputParser(model, limits.outputBytes);
  let possibleWork = false;
  const abort = () => lease.cancel('user');
  const stop = () => { if (lease.cancellation) owner?.requestStop({ kind: 'cancelled', reason: lease.cancellation }); };
  signal?.addEventListener('abort', abort, { once: true });
  lease.signal.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) abort();
  try {
    requireRoot(depth);
    lease.signal.throwIfAborted();
    lease.prepare();
    const pinned = invocation ?? await abortable(PiInvocation.resolve(), lease.signal);
    lease.signal.throwIfAborted();
    prompt = new PrivatePrompt(agent.systemPrompt, lease.signal, promptFiles);
    const promptFile = await abortable(prompt.ready, lease.signal);
    const args = childArguments({ agent, model, promptFile });
    lease.signal.throwIfAborted();
    lease.run();
    possibleWork = true;
    owner = new OwnedProcessTree({ invocation: pinned, args, cwd: identity.cwd, env: childEnvironment(depth), lease, backend });
    possibleWork = owner.child.pid !== undefined;
    if (owner.child.pid !== undefined && !owner.failure && !lease.signal.aborted) onStart?.();
    const child = owner.child;
    const fail = (reason: string) => { failure ??= reason; owner?.requestStop({ kind: 'failed', reason }); };
    const stdout = (chunk: Buffer) => {
      if (failure) return;
      try { parser.write(chunk); } catch { fail('Invalid or excessive child protocol output'); }
    };
    let stderrBytes = 0;
    const stderr = (chunk: Buffer) => {
      const noted = stderrBytes > protocolLimits.stderrBytes;
      stderrBytes += chunk.length;
      if (!noted && stderrBytes > protocolLimits.stderrBytes) diagnostics.push('Child stderr exceeded the diagnostic limit');
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
        else output = final.output;
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
    if (prompt) {
      try { await prompt.remove(); }
      catch { diagnostics.push('Prompt file removal did not finish in time'); }
    }
    signal?.removeEventListener('abort', abort);
    lease.signal.removeEventListener('abort', stop);
    lease.verify();
    lease.finish();
  }
  if (!cleanup.verified) diagnostics.push('Child process cleanup could not be verified');
  const usage = possibleWork ? parser.report(lease.cancellation ? 'cancelled' : failure ? 'process-failure' : undefined) : usageReport();
  const base = { ...identity, output, diagnostics, usage, observedModel,
    cleanup: { verified: cleanup.verified, durationMs: cleanup.durationMs, forced: cleanup.forced, observedProcesses: cleanup.identities.length },
  } satisfies Omit<TaskResult, 'kind'>;
  if (lease.cancellation) return { ...base, output: boundedOutput(''), kind: 'cancelled', reason: `Delegation cancelled (${lease.cancellation})` };
  if (failure) return { ...base, output: boundedOutput(''), kind: 'failed', reason: failure };
  return { ...base, kind: 'succeeded' };
}
