/**
 * blocking_subagent tool: delegate tasks to specialized agents running in separate `pi` processes
 * and wait for their results.
 *
 * Built on Pi's bundled example (examples/extensions/subagent) with these additions:
 *   - inside cmux or tmux, each child runs as a real Pi in the interactive subagents' layout
 *   - bundled agents shipped with this package, overridable by user and project agents
 *   - `model` and `role` per task, routed through <agent dir>/pstack-pi/models.json
 *   - children are leaves: they get PI_DENY_TOOLS with every spawning tool, which both extensions honor
 *   - each child owns a detached process group; abort or timeout kills the whole group
 *   - the task travels over stdin and the system prompt over a 0600 file, not argv
 *
 * One call runs one child: { agent, task }. Several calls in one message run side by side.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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

/** Headless children running at once across all calls. Pane children use the interactive extension's slots. */
export const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const STDERR_CAP = 16 * 1024;
export const TERM_GRACE_MS = 3000;
export const SHUTDOWN_GRACE_MS = 1000;
export const TOOL_NAME = 'blocking_subagent';

// ---------------------------------------------------------------------------
// Spawning rule
// ---------------------------------------------------------------------------

/** Tools that start another agent. The interactive extension builds its `SPAWNING_TOOLS` from this list. */
export const SPAWNING_TOOLS = [TOOL_NAME, 'subagent', 'subagent_interrupt', 'subagents_list', 'subagent_resume'];

/** Tool names in PI_DENY_TOOLS, the one rule both delegation extensions honor. */
export function deniedTools(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.PI_DENY_TOOLS ?? '').split(',').map((name) => name.trim()).filter(Boolean));
}

// A child is a leaf: it inherits the parent's denied tools plus every spawning tool.
// A child's transcript belongs to the parent's turn. Without PI_MEMORY_EXIT_SUMMARY=0,
// pi-memory spends a model call on every child exit and writes the summary into the
// daily log that each new session loads.
export function childEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const denied = new Set([...deniedTools(inherited), ...SPAWNING_TOOLS]);
  return { ...inherited, PI_MEMORY_EXIT_SUMMARY: '0', PI_DENY_TOOLS: [...denied].join(',') };
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
  /** Set only from an assistant response. Never the requested selector. */
  observedModel?: string;
  modelSource?: 'explicit' | 'role' | 'agent' | 'parent';
  thinking?: ExtensionContext['thinkingLevel'];
  stopReason?: string;
  errorMessage?: string;
  sessionId?: string;
  sessionPath?: string;
}

export interface SubagentDetails {
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

// details are not sent to the model. This line is the only resolved identity a parent can check.
export function observedModelId(provider: unknown, model: unknown): string | undefined {
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  const left = provider.trim();
  const right = model.trim();
  if (!left || !right || /[\r\n]/.test(left) || /[\r\n]/.test(right)) return undefined;
  return `${left}/${right}`;
}

export function modelFacingText(observed: string | undefined, body: string, session: Pick<SingleResult, 'sessionId' | 'sessionPath'>): string {
  const sessionLines = session.sessionId && session.sessionPath ? `session-id: ${session.sessionId}\nsession-path: ${session.sessionPath}\n`
    : 'session: none saved, the child exited before writing its session file\n';
  return `resolved-model: ${observed ?? 'unknown'}\n${sessionLines}\n${body}`;
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

import { getPiInvocation, killProcessGroup } from '../interactive-subagents/pi-extension/subagents/headless.ts';
export { getPiInvocation, killProcessGroup };

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
  thinking?: ExtensionContext['thinkingLevel'];
  role?: string;
}

// Pass the child an explicit folder so the parent knows where to look: PI_CODING_AGENT_SESSION_DIR, else Pi's default per-cwd folder.
export function childSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  // The child's process.cwd() is the real path, so Pi keys its default folder by that, not by a symlinked cwd.
  const real = fs.realpathSync(cwd);
  const custom = env.PI_CODING_AGENT_SESSION_DIR;
  if (custom) return path.resolve(real, custom === '~' || custom.startsWith('~/') ? path.join(os.homedir(), custom.slice(1)) : custom);
  return path.join(getAgentDir(), 'sessions', `--${real.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

function recordMessage(result: SingleResult, msg: Message): void {
  result.messages.push(msg);
  if (msg.role !== 'assistant') return;
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
  const observed = observedModelId(msg.provider, msg.model);
  if (observed) {
    result.observedModel = observed;
    result.model = observed;
  }
  if (msg.stopReason) result.stopReason = msg.stopReason;
  if (msg.errorMessage) result.errorMessage = msg.errorMessage;
}

/** The interactive subagents' `runSubagentInPane`: the part of its launch params and result this tool uses. */
export type PaneRunner = (
  params: { name: string; task: string; cwd?: string; systemPrompt?: string; model?: string; tools?: string },
  ctx: ExtensionContext,
  signal: AbortSignal,
  thinking?: string,
) => Promise<{ summary: string; sessionFile?: string; exitCode: number; error?: string; errorMessage?: string; paneClosed?: boolean; ping?: { message: string } }>;

// The interactive extension publishes its live runner under this key (`PANE_RUNNER_KEY` there). Importing
// its file instead would load a second copy with its own slots and widget, because Pi loads each extension apart.
function publishedPaneRunner(): PaneRunner | null {
  const published = (globalThis as Record<symbol, { isMuxAvailable(): boolean; runSubagentInPane: PaneRunner } | undefined>)[Symbol.for('pstack-pi/interactive-subagents/pane-runner')];
  return published?.isMuxAvailable() ? published.runSubagentInPane : null;
}

/**
 * Runs the child as a real Pi in the interactive subagents' cmux or tmux layout, where the user can watch
 * and steer it, and waits for it to exit. The child always keeps a session file, so the reply names it.
 */
export async function runPaneAgent({ resolved, runPane, ctx, signal, timeoutMs }: {
  resolved: ResolvedTask;
  runPane: PaneRunner;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
}): Promise<SingleResult> {
  const { agent, task, cwd } = resolved;
  const result: SingleResult = {
    agent: agent.name, agentSource: agent.source, task, exitCode: -1, messages: [], stderr: '',
    usage: zeroUsage(), model: resolved.model, modelSource: resolved.modelSource, thinking: resolved.thinking,
  };
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) stop.abort();
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => stop.abort(), timeoutMs);
  try {
    const child = await runPane({
      name: agent.name,
      task,
      cwd,
      systemPrompt: agent.systemPrompt.trim() || undefined,
      model: resolved.model,
      tools: agent.tools?.length ? [...new Set([...agent.tools, 'pstack_todo'])].join(',') : undefined,
    }, ctx, stop.signal, resolved.thinking);
    if (signal?.aborted) {
      result.exitCode = 1;
      result.stopReason = 'aborted';
      result.errorMessage = 'Subagent was aborted';
      throw new Error(result.errorMessage);
    }
    if (child.sessionFile && fs.existsSync(child.sessionFile)) {
      const entries = fs.readFileSync(child.sessionFile, 'utf8').split('\n').flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      result.sessionId = entries.find((entry) => entry?.type === 'session')?.id;
      result.sessionPath = child.sessionFile;
      for (const entry of entries) if (entry?.type === 'message' && entry.message?.role !== 'system') recordMessage(result, entry.message);
    }
    result.exitCode = child.exitCode;
    if (stop.signal.aborted) {
      result.exitCode ||= 1;
      result.stopReason = 'aborted';
      result.errorMessage = `Timed out after ${timeoutMs} ms`;
    } else if (child.ping) {
      result.exitCode ||= 1;
      result.errorMessage = `The child asked for help: ${child.ping.message}`;
      result.stopReason = 'error';
    } else if (child.paneClosed || child.error || child.exitCode !== 0) {
      result.exitCode ||= 1;
      result.errorMessage = child.errorMessage ?? child.summary;
      result.stopReason = 'error';
    }
    return result;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
  }
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export async function runSingleAgent({ resolved, signal, timeoutMs, onUpdate, onEvent, makeDetails, spawnChild = spawnDetachedChild, registry, termGraceMs = TERM_GRACE_MS }: {
  resolved: ResolvedTask;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  onUpdate: OnUpdateCallback | undefined;
  onEvent?: (event: unknown, result: SingleResult) => void;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  spawnChild?: SpawnChild;
  registry?: ChildRegistry;
  termGraceMs?: number;
}): Promise<SingleResult> {
  const { agent, task, cwd } = resolved;
  const sessionId = randomUUID();
  const sessionDir = childSessionDir(cwd);
  const args: string[] = ['--mode', 'json', '-p', '--session-dir', sessionDir, '--session-id', sessionId];
  if (resolved.model) args.push('--model', resolved.model);
  if (resolved.thinking) args.push('--thinking', resolved.thinking);
  if (agent.tools && agent.tools.length > 0) args.push('--tools', [...new Set([...agent.tools, 'pstack_todo'])].join(','));

  const result: SingleResult = {
    agent: agent.name, agentSource: agent.source, task, exitCode: -1, messages: [], stderr: '',
    usage: zeroUsage(), model: resolved.model, modelSource: resolved.modelSource, thinking: resolved.thinking, sessionId,
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
      const proc = spawnChild(getPiInvocation(args), { cwd, env: childEnvironment() });
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
        // The child's system message repeats its whole prompt; keeping it bloats every progress update.
        if (event.message.role === 'system') return;
        recordMessage(result, event.message as Message);
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
        killTimer = setTimeout(() => { if (!settled && proc.pid !== undefined) killProcessGroup(proc.pid, 'SIGKILL'); }, termGraceMs);
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
    const name = (await fs.promises.readdir(sessionDir).catch(() => [])).find((file) => file.endsWith(`_${sessionId}.jsonl`));
    if (name) result.sessionPath = path.join(sessionDir, name);
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

const thinkingSchema = Type.Union([
  Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'),
  Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
], { description: 'Child reasoning level. Set for the job; overrides the inherited parent level.' });

const SubagentParams = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  model: Type.Optional(modelChoiceSchema),
  role: Type.Optional(roleSchema),
  thinking: Type.Optional(thinkingSchema),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: 'Kill any child still running after this many milliseconds' })),
  agentScope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('both')], {
    description: 'Which agent directories to use. Default "user" (bundled plus user agents). "both" adds project-local agents.',
  })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: 'Prompt before running project-local agents. Default true.' })),
});

export function toolDescription(bundled: Pick<AgentConfig, 'name' | 'description' | 'tools'>[]): string {
  const listing = bundled.length === 0
    ? 'Bundled agents: none.'
    : `Bundled agents. ${bundled.map((item) => {
      const tools = item.tools?.length ? item.tools.join(', ') : '(host default tools)';
      return `${item.name}: ${item.description} Tools: ${tools}.`;
    }).join(' ')}`;
  return [
    'Delegate tasks to specialized subagents with isolated context and wait for their results before you continue.',
    'Use it for read-only lookups and whenever you need the answer before your next step. For real work, prefer the non-blocking subagent tool, which opens a pane the user can watch and steer.',
    'Each call runs one child. To run several at once, make several blocking_subagent calls in one message; at most four children run at a time and the rest wait.',
    listing,
    `User and project agents override bundled ones by name. User agents live in ${path.join(getAgentDir(), 'agents')}.`,
    `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both".`,
    `model accepts inherit-parent or provider/model-id. role selects a configured model from ${modelConfigPath(getAgentDir())}; roles: ${roles.join(', ')}.`,
    'Explicit model overrides role, then the agent file\'s role, then its model, then the parent model. thinking sets the child reasoning level for the call. Children cannot delegate.',
    'Single result text starts with `resolved-model: provider/model-id` from the child response, or `resolved-model: unknown`. That line is the resolved identity. The requested selector is not.',
    'Every child keeps a Pi session file in PI_CODING_AGENT_SESSION_DIR or else Pi\'s default session folder for its cwd, and the result adds `session-id: <id>` and `session-path: <absolute path>` lines after resolved-model.',
    'Inside cmux or tmux, the child runs as a real Pi in the subagents layout the user can watch and steer.',
  ].join(' ');
}

/** A counting semaphore. Waiters start in call order; an abort while waiting rejects. */
export function createSlots(limit: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return {
    get active() { return active; },
    async acquire(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw new Error('Subagent was aborted');
      if (active < limit) { active++; return; }
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal?.removeEventListener('abort', cancel); active++; resolve(); };
        const cancel = () => { waiters.splice(waiters.indexOf(start), 1); reject(new Error('Subagent was aborted')); };
        waiters.push(start);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    release(): void {
      active--;
      waiters.shift()?.();
    },
  };
}

export default function subagentExtension(pi: ExtensionAPI, { spawnChild = spawnDetachedChild, env = process.env, termGraceMs = TERM_GRACE_MS, runPane }: {
  spawnChild?: SpawnChild;
  env?: NodeJS.ProcessEnv;
  termGraceMs?: number;
  /** Pane launcher; null forces the headless path. Defaults to the interactive subagents' launcher inside a multiplexer. */
  runPane?: PaneRunner | null;
} = {}) {
  if (deniedTools(env).has(TOOL_NAME)) return;

  const router = new ModelRouter();
  const registry = new ChildRegistry();
  const headlessSlots = createSlots(MAX_CONCURRENCY);
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
    if (event.toolName !== TOOL_NAME) return;
    const saved = pendingDetails.get(event.toolCallId);
    pendingDetails.delete(event.toolCallId);
    return event.isError && saved ? { details: saved } : undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: 'Blocking subagent',
    description: toolDescription(bundledAgents()),
    promptSnippet: 'Run subagents and wait for their results: read-only lookups, answers you need before continuing, roles, and several children side by side',
    promptGuidelines: [
      'Use subagent, not blocking_subagent, by default for real work: it opens a pane the user can watch and steer, returns at once, and delivers the result later as a new turn.',
      'Use blocking_subagent for read-only lookups, for answers you need before your next step, and when no terminal multiplexer is available.',
    ],
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
        const makeDetails = (results: SingleResult[]): SubagentDetails => ({ agentScope, projectAgentsDir: discovery.projectAgentsDir, results });
        const listAgents = () => agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';

        const agent = agents.find((a) => a.name === params.agent);
        if (!agent) {
          return { content: [{ type: 'text', text: `Unknown agent "${params.agent}". Available agents: ${listAgents()}` }], details: makeDetails([]) };
        }
        const config = await loadModelConfig(getAgentDir());
        const selection = router.select({ config, role: params.role, model: params.model, agentRole: agent.role, agentModel: agent.model });
        const inherits = selection.choice.kind === 'inheritParent';
        const resolved: ResolvedTask = {
          agent, task: params.task, cwd: params.cwd ?? ctx.cwd,
          model: inherits ? defaults.model : formatModelChoice(selection.choice),
          modelSource: selection.source, thinking: params.thinking ?? (inherits ? defaults.thinkingLevel : undefined), role: params.role ?? agent.role,
        };

        if ((agentScope === 'project' || agentScope === 'both') && (params.confirmProjectAgents ?? true) && ctx.hasUI && !ctx.isProjectTrusted()) {
          if (agent.source === 'project') {
            const ok = await ctx.ui.confirm('Run project-local agents?',
              `Agents: ${agent.name}\nSource: ${discovery.projectAgentsDir ?? '(unknown)'}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`);
            if (!ok) return { content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }], details: makeDetails([]) };
          }
        }

        partial = { content: [{ type: 'text', text: '(starting...)' }], details: makeDetails([]) };
        view.begin(toolCallId);
        progress = new RunProgress([{ agent: agent.name, task: resolved.task, role: resolved.role, model: resolved.model, thinking: resolved.thinking }], (value) => {
          snapshot = value;
          view.publish(value, ctx, toolCallId);
          publish();
        });
        activeProgress.add(progress);
        // The child opens in the subagents layout when a multiplexer and a session file exist, else runs headless.
        // Both paths cap how many children run at once: the pane runner through its spawn slots, headless here.
        const pane = runPane === undefined ? publishedPaneRunner() : runPane;
        const paneCtx = pane && ctx.sessionManager?.getSessionFile() ? ctx : undefined;
        const observe = (event: unknown, result: SingleResult) => {
          const type = (event as { type?: string } | null)?.type;
          if (type === 'child_started') progress!.started(0);
          else if (type === 'child_stopping') progress!.stopping(0);
          else if (type === 'child_finished') progress!.result(0, result);
          else progress!.event(0, event, result.usage);
        };
        let result: SingleResult;
        if (pane && paneCtx) {
          progress.started(0);
          result = await runPaneAgent({ resolved, runPane: pane, ctx: paneCtx, signal, timeoutMs: params.timeoutMs });
          observe({ type: 'child_finished' }, result);
        } else {
          await headlessSlots.acquire(signal);
          try {
            result = await runSingleAgent({ resolved, signal, timeoutMs: params.timeoutMs, onUpdate, makeDetails, spawnChild, registry, termGraceMs, onEvent: observe });
          } finally {
            headlessSlots.release();
          }
        }
        if (isFailedResult(result)) {
          return { content: [{ type: 'text', text: modelFacingText(result.observedModel, `Agent ${result.stopReason || 'failed'}: ${getResultOutput(result)}`, result) }], details: makeDetails([result]) };
        }
        return { content: [{ type: 'text', text: modelFacingText(result.observedModel, getFinalOutput(result.messages) || '(no output)', result) }], details: makeDetails([result]) };
      };
      try {
        const result = await request();
        progress?.finish();
        const details = { ...result.details, ...(snapshot ? { progress: snapshot } : {}) };
        pendingDetails.delete(toolCallId);
        const isError = result.details.results.some(isFailedResult);
        return { ...result, details, isError };
      } catch (error) {
        progress?.finish(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (progress) activeProgress.delete(progress);
      }
    },

    renderCall(args, theme) {
      const scope: AgentScope = args.agentScope ?? 'user';
      const title = theme.fg('toolTitle', theme.bold(`${TOOL_NAME} `));
      const tag = (item: { model?: string; role?: string }) => {
        const bits = [item.role && `role:${item.role}`, item.model && item.model].filter(Boolean);
        return bits.length ? theme.fg('muted', ` (${bits.join(', ')})`) : '';
      };
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

      const collapsedTask = (r: SingleResult, header: string) => {
        const displayItems = getDisplayItems(r.messages);
        let text = header;
        if (isFailedResult(r) && r.errorMessage) text += `\n${theme.fg('error', `Error: ${r.errorMessage}`)}`;
        if (displayItems.length === 0) text += `\n${theme.fg('muted', r.exitCode === -1 ? '(running...)' : '(no output)')}`;
        else text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
        const usage = formatUsageStats(r.usage, r.model);
        if (usage) text += `\n${theme.fg('dim', usage)}`;
        return text;
      };

      const r = details.results[0];
      const isError = isFailedResult(r);
      const icon = r.exitCode === -1 ? theme.fg('warning', '⏳') : isError ? theme.fg('error', '✗') : theme.fg('success', '✓');
      let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`;
      if (isError && r.stopReason) header += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
      if (expanded) {
        const container = new Container();
        expandedTask(container, r, header);
        return container;
      }
      let text = collapsedTask(r, header);
      if (getDisplayItems(r.messages).length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
      return new Text(text, 0, 0);
    },
  });
}
