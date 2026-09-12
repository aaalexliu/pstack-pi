import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { executionLimits, type Agent, type BoundedOutput, type CanonicalCwd, type TaskIdentity, type TaskResult } from './domain.ts';

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

export function childOutputParser() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  let count = 0;
  let final: Static<typeof assistantSchema> | undefined;
  let settled = false;
  return {
    write(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > executionLimits.stdoutBytes) throw new Error('Child stdout limit exceeded');
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > executionLimits.lineBytes) throw new Error('Child JSONL line limit exceeded');
        if (++count > executionLimits.events) throw new Error('Child event limit exceeded');
        const event: unknown = JSON.parse(line);
        if (!Check(eventSchema, event) || !eventTypes.has(event.type)) throw new Error('Invalid child event');
        if (settled) throw new Error('Child event after settled');
        if (event.type === 'agent_settled') settled = true;
        if (event.type === 'message_end') {
          if (!Check(messageEventSchema, event)) throw new Error('Invalid child message event');
          if (event.message.role === 'assistant') {
            if (!Check(assistantSchema, event.message)) throw new Error('Invalid child assistant message');
            final = event.message;
          }
        }
      }
      if (Buffer.byteLength(pending) > executionLimits.lineBytes) throw new Error('Child JSONL line limit exceeded');
    },
    end() {
      pending += decoder.decode();
      if (pending !== '') throw new Error('Child JSONL ended without LF');
      if (!settled || !final) throw new Error('Child has no settled final assistant message');
      return final;
    },
  };
}

export type ChildModel = { provider: string; id: string; thinkingLevel: string | undefined };

export function childArguments({ agent, model, promptFile }: { agent: Agent; model: ChildModel; promptFile: string }): string[] {
  if (!model.provider || !model.id || /[\s\0]/u.test(model.provider + model.id)) throw new Error('Missing or invalid parent model');
  const args = ['--mode', 'json', '--print', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline', '--model', `${model.provider}/${model.id}`];
  if (model.thinkingLevel !== undefined) {
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinkingLevel)) throw new Error('Invalid parent thinking level');
    args.push('--thinking', model.thinkingLevel);
  }
  args.push(...(agent.tools.length ? ['--tools', agent.tools.join(',')] : ['--no-tools']));
  args.push('--system-prompt', promptFile);
  return args;
}

export async function runChild({ identity, agent, task, model, signal, command = 'pi', prefixArgs = [] }: {
  identity: TaskIdentity; agent: Agent; task: string; model: ChildModel; signal: AbortSignal | undefined;
  command?: string; prefixArgs?: string[];
}): Promise<TaskResult> {
  signal?.throwIfAborted();
  const temporary = await mkdtemp(path.join(tmpdir(), 'pstack-subagent-'));
  try {
    const promptFile = path.join(temporary, 'system.md');
    await writeFile(promptFile, agent.systemPrompt, { mode: 0o600, flag: 'wx' });
    const args = childArguments({ agent, model, promptFile });
    signal?.throwIfAborted();
    const child = spawn(command, [...prefixArgs, ...args], { cwd: identity.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const parser = childOutputParser();
    let failure: string | undefined;
    let cancelled = false;
    let stderr = '';
    let stderrBytes = 0;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const stop = (reason: string) => {
      failure ??= boundedOutput(reason, executionLimits.diagnosticBytes).text;
      child.kill('SIGTERM');
    };
    const abort = () => { cancelled = true; stop('Delegation cancelled'); };
    const stdout = (chunk: Buffer) => {
      if (failure) return;
      try { parser.write(chunk); } catch (error) { stop(String(error)); }
    };
    const stderrData = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = boundedOutput(stderr + chunk.toString('utf8'), executionLimits.diagnosticBytes).text;
      if (stderrBytes > executionLimits.stderrBytes) stop('Child stderr limit exceeded');
    };
    const processError = (error: Error) => stop(error.message);
    try {
      const closed = new Promise<void>((resolve) => {
        child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
      });
      child.on('error', processError);
      child.stdin.on('error', processError);
      child.stdout.on('data', stdout);
      child.stderr.on('data', stderrData);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(task);
      await closed;
    } finally {
      signal?.removeEventListener('abort', abort);
      child.removeListener('error', processError);
      child.stdin.removeListener('error', processError);
      child.stdout.removeListener('data', stdout);
      child.stderr.removeListener('data', stderrData);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    let output = boundedOutput('');
    try {
      const final = parser.end();
      output = boundedOutput(final.content.filter((block) => block.type === 'text').map((block) => block.text).join(''));
      if (final.provider !== model.provider || final.model !== model.id) failure ??= 'Child model differs from parent model';
      if (final.stopReason !== 'stop') failure ??= boundedOutput(final.errorMessage || `Child stopped with ${final.stopReason}`, executionLimits.diagnosticBytes).text;
    } catch (error) { failure ??= boundedOutput(String(error), executionLimits.diagnosticBytes).text; }
    if (exitCode !== 0 || exitSignal !== null) failure ??= `Child exited with code ${exitCode}, signal ${exitSignal}`;
    const base = { ...identity, output, diagnostics: stderr ? [stderr] : [], usage: null } satisfies Omit<TaskResult, 'kind'>;
    if (cancelled) return { ...base, kind: 'cancelled', reason: 'Delegation cancelled' };
    if (failure) return { ...base, kind: 'failed', reason: failure };
    return { ...base, kind: 'succeeded' };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
