/**
 * Subagent tool: delegate tasks to specialized agents running in separate `pi` processes.
 *
 * Built on Pi's bundled example (examples/extensions/subagent) with these additions:
 *   - bundled agents shipped with this package, overridable by user and project agents
 *   - `model` and `role` per task, routed through <agent dir>/pstack-pi/models.json
 *   - a depth guard so children cannot delegate again
 *   - each child owns a detached process group; abort or timeout kills the whole group
 *   - the task travels over stdin and the system prompt over a 0600 file, not argv
 *
 * Modes:
 *   - Single: { agent, task }
 *   - Parallel: { tasks: [{ agent, task }, ...] }
 *   - Chain: { chain: [{ agent, task: "... {previous} ..." }, ...] }
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message } from '@earendil-works/pi-ai';
import {
  type AgentToolResult,
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { RunProgress, type ProgressSnapshot } from './progress.ts';
import { createProgressView, renderProgressResult } from './view.ts';
import { type AgentConfig, type AgentScope, type AgentSource, bundledAgents, discoverAgents } from './agents.ts';
import { formatModelChoice, loadModelConfig, ModelRouter, modelChoiceSchema, modelConfigPath, roleSchema, roles } from './model-config.ts';

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const STDERR_CAP = 16 * 1024;
export const TERM_GRACE_MS = 3000;
export const SHUTDOWN_GRACE_MS = 1000;
export const DEPTH_VARIABLE = 'PSTACK_SUBAGENT_DEPTH';

// ---------------------------------------------------------------------------
// Depth guard
// ---------------------------------------------------------------------------

export function parentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEPTH_VARIABLE];
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
}

export function childEnvironment(depth: number, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...inherited, [DEPTH_VARIABLE]: String(depth + 1) };
}

// ---------------------------------------------------------------------------
// Formatting helpers (from the Pi example)
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number }, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(' ');
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  const pathArg = () => shortenPath((args.file_path || args.path || '...') as string);
  switch (toolName) {
    case 'bash': {
      const command = (args.command as string) || '...';
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview);
    }
    case 'read': {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg('accent', pathArg());
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : '';
        text += themeFg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`);
      }
      return themeFg('muted', 'read ') + text;
    }
    case 'write': {
      const lines = ((args.content || '') as string).split('\n').length;
      let text = themeFg('muted', 'write ') + themeFg('accent', pathArg());
      if (lines > 1) text += themeFg('dim', ` (${lines} lines)`);
      return text;
    }
    case 'edit': return themeFg('muted', 'edit ') + themeFg('accent', pathArg());
    case 'ls': return themeFg('muted', 'ls ') + themeFg('accent', shortenPath((args.path || '.') as string));
    case 'find': return themeFg('muted', 'find ') + themeFg('accent', (args.pattern || '*') as string) + themeFg('dim', ` in ${shortenPath((args.path || '.') as string)}`);
    case 'grep': return themeFg('muted', 'grep ') + themeFg('accent', `/${(args.pattern || '') as string}/`) + themeFg('dim', ` in ${shortenPath((args.path || '.') as string)}`);
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | 'unknown';
  task: string;
  /** -1 while running */
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  modelSource?: 'explicit' | 'role' | 'agent' | 'parent';
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  progress?: ProgressSnapshot;
}

function zeroUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const part of msg.content) if (part.type === 'text') return part.text;
    }
  }
  return '';
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) return result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)';
  return getFinalOutput(result.messages) || '(no output)';
}

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, 'utf8') > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: 'text'; text: string } | { type: 'toolCall'; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'text') items.push({ type: 'text', text: part.text });
      else if (part.type === 'toolCall') items.push({ type: 'toolCall', name: part.name, args: part.arguments });
    }
  }
  return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
  return { dir: tmpDir, filePath };
}

// Run the same Pi that is running us, never whatever `pi` is first in PATH.
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: 'pi', args };
}

// The child is a detached session leader, so -pid reaches everything it spawned.
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

export interface ChildSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnChild = (invocation: { command: string; args: string[] }, options: ChildSpawnOptions) => ChildProcess;

// Live children, so session shutdown can take them down with the parent.
export class ChildRegistry {
  readonly #live = new Map<number, ChildProcess>();
  #closing = false;
  get size(): number { return this.#live.size; }
  /** Once the parent is shutting down, child results have nowhere to go and must not restart the agent loop. */
  get closing(): boolean { return this.#closing; }
  track(proc: ChildProcess): void {
    if (proc.pid === undefined) return;
    this.#live.set(proc.pid, proc);
    proc.once('close', () => { this.#live.delete(proc.pid!); });
  }
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    this.#closing = true;
    for (const pid of this.#live.keys()) killProcessGroup(pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (this.#live.size && Date.now() < deadline) await delay(25);
    for (const pid of this.#live.keys()) killProcessGroup(pid, 'SIGKILL');
  }
}

export const spawnDetachedChild: SpawnChild = (invocation, { cwd, env }) =>
  spawn(invocation.command, invocation.args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

export interface DispatchDefaults {
  model?: string;
  thinkingLevel?: ExtensionContext['thinkingLevel'];
}

export interface ResolvedTask {
  agent: AgentConfig;
  task: string;
  cwd: string;
  model: string | undefined;
  modelSource: SingleResult['modelSource'];
  inheritsThinking: boolean;
  role?: string;
  step?: number;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export async function runSingleAgent({ resolved, defaults, depth, signal, timeoutMs, onUpdate, onEvent, makeDetails, spawnChild = spawnDetachedChild, registry }: {
  resolved: ResolvedTask;
  defaults: DispatchDefaults;
  depth: number;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  onUpdate: OnUpdateCallback | undefined;
  onEvent?: (event: unknown, result: SingleResult) => void;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  spawnChild?: SpawnChild;
  registry?: ChildRegistry;
}): Promise<SingleResult> {
  const { agent, task, cwd, step } = resolved;
  const args: string[] = ['--mode', 'json', '-p', '--no-session'];
  if (resolved.model) args.push('--model', resolved.model);
  if (resolved.inheritsThinking && defaults.thinkingLevel) args.push('--thinking', defaults.thinkingLevel);
  if (agent.tools && agent.tools.length > 0) args.push('--tools', [...new Set([...agent.tools, 'pstack_todo'])].join(','));

  const result: SingleResult = {
    agent: agent.name, agentSource: agent.source, task, exitCode: -1, messages: [], stderr: '',
    usage: zeroUsage(), model: resolved.model, modelSource: resolved.modelSource, step,
  };
  const observe = (event: unknown) => {
    try { onEvent?.(event, result); } catch { /* Display failures must not stop the child. */ }
  };
  const emitUpdate = () => {
    try { onUpdate?.({ content: [{ type: 'text', text: getFinalOutput(result.messages) || '(running...)' }], details: makeDetails([result]) }); }
    catch { /* The tool can finish even if its view closes. */ }
  };

  let tmpPromptDir: string | undefined;
  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      args.push('--append-system-prompt', tmp.filePath);
    }

    let stopCause: 'user' | 'timeout' | undefined;
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawnChild(getPiInvocation(args), { cwd, env: childEnvironment(depth) });
      registry?.track(proc);
      observe({ type: 'child_started' });
      emitUpdate();
      let buffer = '';
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.type !== 'message_end' || !event.message) { observe(event); return; }
        const msg = event.message as Message;
        result.messages.push(msg);
        if (msg.role === 'assistant') {
          result.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            result.usage.input += usage.input || 0;
            result.usage.output += usage.output || 0;
            result.usage.cacheRead += usage.cacheRead || 0;
            result.usage.cacheWrite += usage.cacheWrite || 0;
            result.usage.cost += usage.cost?.total || 0;
            result.usage.contextTokens = usage.totalTokens || 0;
          }
          if (msg.model) result.model = `${msg.provider}/${msg.model}`;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
        observe(event);
        emitUpdate();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        if (!registry?.closing) resolve(code);
      };
      const stop = (cause: 'user' | 'timeout') => {
        if (stopCause || settled) return;
        stopCause = cause;
        observe({ type: 'child_stopping' });
        if (proc.pid === undefined) return;
        killProcessGroup(proc.pid, 'SIGTERM');
        killTimer = setTimeout(() => { if (!settled && proc.pid !== undefined) killProcessGroup(proc.pid, 'SIGKILL'); }, TERM_GRACE_MS);
      };
      const onAbort = () => stop('user');

      proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        result.stderr = (result.stderr + data.toString()).slice(-STDERR_CAP);
      });
      proc.on('close', (code, exitSignal) => {
        if (buffer.trim()) processLine(buffer);
        if (exitSignal && !stopCause) result.errorMessage ??= `Child exited on ${exitSignal}`;
        finish(code ?? 1);
      });
      proc.on('error', (error) => {
        result.errorMessage = error.message;
        finish(1);
      });
      proc.stdin?.on('error', () => { /* child exited before reading the task */ });
      proc.stdin?.end(task);

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      if (timeoutMs !== undefined) deadline = setTimeout(() => stop('timeout'), timeoutMs);
    });

    result.exitCode = exitCode;
    if (stopCause === 'user') {
      result.stopReason = 'aborted';
      result.errorMessage = 'Subagent was aborted';
      throw new Error(result.errorMessage);
    }
    if (stopCause === 'timeout') {
      result.exitCode = result.exitCode || 1;
      result.stopReason = 'aborted';
      result.errorMessage = `Timed out after ${timeoutMs} ms`;
    }
    return result;
  } catch (error) {
    result.exitCode = result.exitCode === -1 ? 1 : result.exitCode;
    result.errorMessage ??= error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    observe({ type: 'child_finished' });
    if (tmpPromptDir) await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const taskFields = {
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  model: Type.Optional(modelChoiceSchema),
  role: Type.Optional(roleSchema),
};
const TaskItem = Type.Object(taskFields);
const ChainItem = Type.Object({ ...taskFields, task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }) });

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: 'Name of the agent to invoke (single mode)' })),
  task: Type.Optional(Type.String({ description: 'Task to delegate (single mode)' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: `Array of {agent, task} for parallel execution, at most ${MAX_PARALLEL_TASKS}` })),
  chain: Type.Optional(Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' })),
  model: Type.Optional(modelChoiceSchema),
  role: Type.Optional(roleSchema),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process (single mode)' })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: 'Kill any child still running after this many milliseconds' })),
  agentScope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('both')], {
    description: 'Which agent directories to use. Default "user" (bundled plus user agents). "both" adds project-local agents.',
  })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: 'Prompt before running project-local agents. Default true.' })),
});

export function toolDescription(bundled: string[]): string {
  return [
    'Delegate tasks to specialized subagents with isolated context.',
    'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
    `Bundled agents: ${bundled.join(', ') || 'none'}. User agents live in ${path.join(getAgentDir(), 'agents')} and override bundled ones by name.`,
    `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both".`,
    `model accepts inherit-parent or provider/model-id. role selects a configured model from ${modelConfigPath(getAgentDir())}; roles: ${roles.join(', ')}.`,
    'Explicit model overrides role, then the agent default, then the parent model. Children cannot delegate.',
  ].join(' ');
}

export default function subagentExtension(pi: ExtensionAPI, { spawnChild = spawnDetachedChild, env = process.env }: { spawnChild?: SpawnChild; env?: NodeJS.ProcessEnv } = {}) {
  const depth = parentDepth(env);
  if (depth >= 1) return;

  const router = new ModelRouter();
  const registry = new ChildRegistry();
  const view = createProgressView(pi);
  const pendingDetails = new Map<string, SubagentDetails>();
  const activeProgress = new Set<RunProgress>();

  pi.on('session_shutdown', async () => {
    for (const progress of activeProgress) progress.finish('Session closed');
    activeProgress.clear();
    await Promise.all([registry.shutdown(), view.close()]);
    pendingDetails.clear();
  });

  pi.on('tool_result', (event) => {
    if (event.toolName !== 'subagent') return;
    const saved = pendingDetails.get(event.toolCallId);
    pendingDetails.delete(event.toolCallId);
    if (event.isError) return saved ? { details: saved } : undefined;
    const details = event.details as SubagentDetails | undefined;
    if (!details || details.results.length === 0) return;
    const failed = details.mode === 'parallel'
      ? details.results.every(isFailedResult)
      : details.results.some(isFailedResult);
    return failed ? { isError: true } : undefined;
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: toolDescription(bundledAgents().map((a) => a.name)),
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, update, ctx) {
      let progress: RunProgress | undefined;
      let snapshot: ProgressSnapshot | undefined;
      let partial: AgentToolResult<SubagentDetails> | undefined;
      const publish = () => {
        if (!partial) return;
        const details = { ...partial.details!, progress: snapshot };
        pendingDetails.set(toolCallId, details);
        try { update?.({ ...partial, details }); } catch { /* Keep observer failures out of execution. */ }
      };
      const onUpdate: OnUpdateCallback = (value) => { partial = value; publish(); };
      const request = async (): Promise<AgentToolResult<SubagentDetails>> => {
        const agentScope: AgentScope = params.agentScope ?? 'user';
        const defaults: DispatchDefaults = {
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinkingLevel: ctx.thinkingLevel,
        };
        const discovery = discoverAgents(ctx.cwd, agentScope);
        const agents = discovery.agents;
        const makeDetails = (mode: SubagentDetails['mode']) => (results: SingleResult[]): SubagentDetails => ({
          mode, agentScope, projectAgentsDir: discovery.projectAgentsDir, results,
        });
        const listAgents = () => agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';

        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const mode: SubagentDetails['mode'] = hasChain ? 'chain' : hasTasks ? 'parallel' : 'single';
        if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
          return { content: [{ type: 'text', text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${listAgents()}` }], details: makeDetails('single')([]) };
        }
        if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
          return { content: [{ type: 'text', text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }], details: makeDetails('parallel')([]) };
        }

        const requested = params.chain ?? params.tasks ?? [{ agent: params.agent!, task: params.task!, cwd: params.cwd, model: params.model, role: params.role }];
        const config = await loadModelConfig(getAgentDir());
        const resolvedTasks: ResolvedTask[] = [];
        for (const [index, item] of requested.entries()) {
          const agent = agents.find((a) => a.name === item.agent);
          if (!agent) {
            return { content: [{ type: 'text', text: `Unknown agent "${item.agent}". Available agents: ${listAgents()}` }], details: makeDetails(mode)([]) };
          }
          const selection = router.select({ config, role: item.role ?? params.role, model: item.model ?? params.model, agentModel: agent.model });
          const inherits = selection.choice.kind === 'inheritParent';
          resolvedTasks.push({
            agent, task: item.task, cwd: item.cwd ?? params.cwd ?? ctx.cwd,
            model: inherits ? defaults.model : formatModelChoice(selection.choice),
            modelSource: selection.source, inheritsThinking: inherits, role: item.role ?? params.role,
            step: hasChain ? index + 1 : undefined,
          });
        }

        if ((agentScope === 'project' || agentScope === 'both') && (params.confirmProjectAgents ?? true) && ctx.hasUI && !ctx.isProjectTrusted()) {
          const projectAgents = [...new Set(resolvedTasks.map((t) => t.agent).filter((a) => a.source === 'project'))];
          if (projectAgents.length > 0) {
            const ok = await ctx.ui.confirm('Run project-local agents?',
              `Agents: ${projectAgents.map((a) => a.name).join(', ')}\nSource: ${discovery.projectAgentsDir ?? '(unknown)'}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`);
            if (!ok) return { content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }], details: makeDetails(mode)([]) };
          }
        }

        partial = { content: [{ type: 'text', text: '(starting...)' }], details: makeDetails(mode)([]) };
        view.begin(toolCallId);
        progress = new RunProgress(resolvedTasks.map((task) => ({ agent: task.agent.name, task: task.task, role: task.role, model: task.model })), (value) => {
          snapshot = value;
          view.publish(value, ctx, toolCallId);
          publish();
        });
        activeProgress.add(progress);
        const run = (resolved: ResolvedTask, update: OnUpdateCallback | undefined, index: number) => {
          if (signal?.aborted) throw new Error('Subagent was aborted');
          return runSingleAgent({ resolved, defaults, depth, signal, timeoutMs: params.timeoutMs, onUpdate: update, makeDetails: makeDetails(mode), spawnChild, registry,
            onEvent: (event, result) => {
              const type = (event as { type?: string } | null)?.type;
              if (type === 'child_started') progress!.started(index);
              else if (type === 'child_stopping') progress!.stopping(index);
              else if (type === 'child_finished') progress!.result(index, result);
              else progress!.event(index, event, result.usage);
            },
          });
        };

        if (mode === 'chain') {
          const results: SingleResult[] = [];
          let previousOutput = '';
          for (const [index, resolved] of resolvedTasks.entries()) {
            const withContext = { ...resolved, task: resolved.task.replace(/\{previous\}/g, previousOutput) };
            const chainUpdate: OnUpdateCallback | undefined = onUpdate
              ? (partial) => {
                const current = partial.details?.results[0];
                if (current) onUpdate({ content: partial.content, details: makeDetails('chain')([...results, current]) });
              }
              : undefined;
            const result = await run(withContext, chainUpdate, index);
            results.push(result);
            if (isFailedResult(result)) {
              return { content: [{ type: 'text', text: `Chain stopped at step ${resolved.step} (${resolved.agent.name}): ${getResultOutput(result)}` }], details: makeDetails('chain')(results) };
            }
            previousOutput = getFinalOutput(result.messages);
          }
          return { content: [{ type: 'text', text: getFinalOutput(results[results.length - 1].messages) || '(no output)' }], details: makeDetails('chain')(results) };
        }

        if (mode === 'parallel') {
          const allResults: SingleResult[] = resolvedTasks.map((t) => ({
            agent: t.agent.name, agentSource: t.agent.source, task: t.task, exitCode: -1, messages: [], stderr: '', usage: zeroUsage(), model: t.model, modelSource: t.modelSource,
          }));
          const emitParallelUpdate = () => {
            if (!onUpdate) return;
            const running = allResults.filter((r) => r.exitCode === -1).length;
            onUpdate({
              content: [{ type: 'text', text: `Parallel: ${allResults.length - running}/${allResults.length} done, ${running} running...` }],
              details: makeDetails('parallel')([...allResults]),
            });
          };
          const results = await mapWithConcurrencyLimit(resolvedTasks, MAX_CONCURRENCY, async (resolved, index) => {
            const result = await run(resolved, (partial) => {
              if (partial.details?.results[0]) { allResults[index] = partial.details.results[0]; emitParallelUpdate(); }
            }, index);
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          });
          const successCount = results.filter((r) => !isFailedResult(r)).length;
          const summaries = results.map((r) => {
            const status = isFailedResult(r) ? `failed${r.stopReason && r.stopReason !== 'stop' ? ` (${r.stopReason})` : ''}` : 'completed';
            return `### [${r.agent}] ${status}\n\n${truncateParallelOutput(getResultOutput(r))}`;
          });
          return {
            content: [{ type: 'text', text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}` }],
            details: makeDetails('parallel')(results),
          };
        }

        const result = await run(resolvedTasks[0], onUpdate, 0);
        if (isFailedResult(result)) {
          return { content: [{ type: 'text', text: `Agent ${result.stopReason || 'failed'}: ${getResultOutput(result)}` }], details: makeDetails('single')([result]) };
        }
        return { content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }], details: makeDetails('single')([result]) };
      };
      try {
        const result = await request();
        progress?.finish();
        const details = { ...result.details, ...(snapshot ? { progress: snapshot } : {}) };
        pendingDetails.delete(toolCallId);
        return { ...result, details };
      } catch (error) {
        progress?.finish(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (progress) activeProgress.delete(progress);
      }
    },

    renderCall(args, theme) {
      const scope: AgentScope = args.agentScope ?? 'user';
      const title = theme.fg('toolTitle', theme.bold('subagent '));
      const tag = (item: { model?: string; role?: string }) => {
        const bits = [item.role && `role:${item.role}`, item.model && item.model].filter(Boolean);
        return bits.length ? theme.fg('muted', ` (${bits.join(', ')})`) : '';
      };
      if (args.chain && args.chain.length > 0) {
        let text = title + theme.fg('accent', `chain (${args.chain.length} steps)`) + theme.fg('muted', ` [${scope}]`);
        for (const [i, step] of args.chain.slice(0, 3).entries()) {
          const cleanTask = step.task.replace(/\{previous\}/g, '').trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text += `\n  ${theme.fg('muted', `${i + 1}.`)} ${theme.fg('accent', step.agent)}${tag(step)}${theme.fg('dim', ` ${preview}`)}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg('muted', `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text = title + theme.fg('accent', `parallel (${args.tasks.length} tasks)`) + theme.fg('muted', ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg('accent', t.agent)}${tag(t)}${theme.fg('dim', ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : '...';
      return new Text(`${title}${theme.fg('accent', args.agent || '...')}${tag(args)}${theme.fg('muted', ` [${scope}]`)}\n  ${theme.fg('dim', preview)}`, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const details = result.details as SubagentDetails | undefined;
      if (details?.progress) return renderProgressResult(result, options, theme, context);
      const { expanded } = options;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
      }
      const mdTheme = getMarkdownTheme();
      const fg = theme.fg.bind(theme);
      const toolLine = (item: DisplayItem & { type: 'toolCall' }) => new Text(theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, fg), 0, 0);

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = '';
        if (skipped > 0) text += theme.fg('muted', `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === 'text') text += `${theme.fg('toolOutput', expanded ? item.text : item.text.split('\n').slice(0, 3).join('\n'))}\n`;
          else text += `${theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, fg)}\n`;
        }
        return text.trimEnd();
      };

      const expandedTask = (container: Container, r: SingleResult, header: string) => {
        container.addChild(new Text(header, 0, 0));
        container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0));
        for (const item of getDisplayItems(r.messages)) if (item.type === 'toolCall') container.addChild(toolLine(item));
        const finalOutput = getFinalOutput(r.messages);
        if (finalOutput) { container.addChild(new Spacer(1)); container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme)); }
        if (isFailedResult(r) && r.errorMessage) container.addChild(new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0));
        const usage = formatUsageStats(r.usage, r.model);
        if (usage) container.addChild(new Text(theme.fg('dim', usage), 0, 0));
      };

      const aggregateUsage = (results: SingleResult[]) => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        for (const r of results) {
          total.input += r.usage.input; total.output += r.usage.output; total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite; total.cost += r.usage.cost; total.turns += r.usage.turns;
        }
        return total;
      };

      if (details.mode === 'single' && details.results.length === 1) {
        const r = details.results[0];
        const isError = isFailedResult(r);
        const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓');
        let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) header += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
        if (expanded) {
          const container = new Container();
          expandedTask(container, r, header);
          return container;
        }
        const displayItems = getDisplayItems(r.messages);
        let text = header;
        if (isError && r.errorMessage) text += `\n${theme.fg('error', `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
        }
        const usage = formatUsageStats(r.usage, r.model);
        if (usage) text += `\n${theme.fg('dim', usage)}`;
        return new Text(text, 0, 0);
      }

      const running = details.results.filter((r) => r.exitCode === -1).length;
      const done = details.results.filter((r) => r.exitCode !== -1);
      const successCount = done.filter((r) => !isFailedResult(r)).length;
      const label = details.mode === 'chain' ? 'chain ' : 'parallel ';
      const icon = running > 0 ? theme.fg('warning', '⏳') : successCount === details.results.length ? theme.fg('success', '✓') : theme.fg(details.mode === 'chain' ? 'error' : 'warning', details.mode === 'chain' ? '✗' : '◐');
      const status = running > 0 ? `${done.length}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} ${details.mode === 'chain' ? 'steps' : 'tasks'}`;
      const stepHeader = (r: SingleResult) => {
        const rIcon = r.exitCode === -1 ? theme.fg('warning', '⏳') : isFailedResult(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
        return `${theme.fg('muted', details.mode === 'chain' ? `─── Step ${r.step}: ` : '─── ')}${theme.fg('accent', r.agent)} ${rIcon}`;
      };

      if (expanded && running === 0) {
        const container = new Container();
        container.addChild(new Text(`${icon} ${theme.fg('toolTitle', theme.bold(label))}${theme.fg('accent', status)}`, 0, 0));
        for (const r of details.results) { container.addChild(new Spacer(1)); expandedTask(container, r, stepHeader(r)); }
        const usage = formatUsageStats(aggregateUsage(details.results));
        if (usage) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg('dim', `Total: ${usage}`), 0, 0)); }
        return container;
      }

      let text = `${icon} ${theme.fg('toolTitle', theme.bold(label))}${theme.fg('accent', status)}`;
      for (const r of details.results) {
        const displayItems = getDisplayItems(r.messages);
        text += `\n\n${stepHeader(r)}`;
        if (displayItems.length === 0) text += `\n${theme.fg('muted', r.exitCode === -1 ? '(running...)' : '(no output)')}`;
        else text += `\n${renderDisplayItems(displayItems, 5)}`;
      }
      if (running === 0) {
        const usage = formatUsageStats(aggregateUsage(details.results));
        if (usage) text += `\n\n${theme.fg('dim', `Total: ${usage}`)}`;
      }
      if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
      return new Text(text, 0, 0);
    },
  });
}
