import { stripVTControlCharacters } from 'node:util';
import type { DelegationTask, TaskResult } from './domain.ts';
import type { ResolvedTask } from './scheduler.ts';
import { usageReport, type UsageReport } from './usage.ts';
import { decodeTodoState } from '../pstack/todo.ts';
import { boundedOutput } from './protocol.ts';

export type TaskProgress = {
  index: number; agent: string; role: string; task: string; model: string; observedModel: string | null;
  state: 'preparing' | 'queued' | 'running' | 'stopping' | TaskResult['kind'];
  startedAt: number | null; lastEventAt: number | null; endedAt: number | null;
  activity: string; message: string; tools: { id: string; name: string }[]; turns: number;
  todos: string[] | null; usage: UsageReport; warning: string | null;
};
export type ProgressSnapshot = { version: 1; updatedAt: number; startedAt: number; endedAt: number | null; tasks: TaskProgress[] };
export function plain(value: string, limit = 180): string {
  return Array.from(stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
}
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function clip(text: string, width: number): string {
  let result = '';
  let used = 0;
  for (const { segment } of segments.segment(text)) {
    const cells = /^[\x20-\x7e]$/.test(segment) ? 1 : 2;
    if (used + cells > Math.max(0, width)) break;
    used += cells;
    result += segment;
  }
  return result;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
export function taskLine(row: TaskProgress, now: number): string {
  const end = row.endedAt ?? now;
  const elapsed = row.startedAt === null ? row.state : duration(end - row.startedAt);
  const quiet = row.lastEventAt === null ? 'no events yet' : `last event ${duration(end - row.lastEventAt)} ${row.endedAt === null ? 'ago' : 'before finish'}`;
  const warning = row.warning ?? (row.endedAt === null && row.startedAt !== null && now - row.startedAt >= 600_000 ? 'LONG RUN: check scope'
    : row.state === 'running' && now - (row.lastEventAt ?? row.startedAt ?? now) >= 60_000 ? 'QUIET: check activity' : null);
  return `#${row.index + 1} ${row.role} | ${row.state} ${elapsed} | ${quiet}${warning ? ` | ${warning}` : ''}`;
}
export function progressLines(snapshot: ProgressSnapshot, detailed = false): string[] {
  const active = snapshot.tasks.filter((row) => !row.endedAt);
  const finished = snapshot.tasks.length - active.length;
  const lines = [`Subagents ${finished}/${snapshot.tasks.length} finished | policy: leaf depth 1/1 (delegation disabled)`];
  for (const row of snapshot.tasks) {
    const usage = row.usage.direct;
    const tokens = usage.usage.input + usage.usage.output + usage.usage.cacheRead + usage.usage.cacheWrite;
    const todo = row.todos === null ? 'todos not reported' : `todos ${row.todos.filter((item) => item.startsWith('[done] ')).length}/${row.todos.length} (self-reported)`;
    lines.push(taskLine(row, snapshot.updatedAt));
    lines.push(`  ${row.agent} | ${row.observedModel ?? row.model}${row.observedModel ? '' : ' (selected)'} | ${tokens} tok $${usage.usage.cost.total.toFixed(4)}${usage.kind === 'partial' ? ' partial' : ''} | ${todo}`);
    lines.push(`  ${row.tools.length ? row.tools.map((tool) => tool.name).join(', ') : row.activity}${row.message ? ` | ${row.message}` : ''}`);
    if (detailed) {
      lines.push(`  Task: ${row.task}`, `  Turns: ${row.turns} | in ${usage.usage.input} / out ${usage.usage.output} / cache ${usage.usage.cacheRead + usage.usage.cacheWrite}`);
      if (row.todos !== null) lines.push(...row.todos.map((item) => `  ${item.startsWith('[done] ') ? '[x] ' + item.slice(7) : '[ ] ' + item}`));
    }
  }
  lines.push('Event age is not proof of work. Usage can lag. Esc in parent stops the batch.');
  return lines;
}

export type ProgressCard = { version: 1; lines: string[] };
export function progressCard(snapshot: ProgressSnapshot, includePreview = snapshot.endedAt === null): ProgressCard {
  const lines = [progressLines(snapshot)[0]];
  for (const row of snapshot.tasks) {
    const usage = row.usage.direct;
    const tokens = usage.usage.input + usage.usage.output + usage.usage.cacheRead + usage.usage.cacheWrite;
    const todos = row.todos === null ? 'todos not reported' : `todos ${row.todos.filter((item) => item.startsWith('[done] ')).length}/${row.todos.length} (self-reported)`;
    lines.push(taskLine(row, snapshot.updatedAt),
      `  ${row.agent} | ${row.observedModel ?? row.model}${row.observedModel ? '' : ' (selected)'}`,
      `  ${tokens} tok $${usage.usage.cost.total.toFixed(4)}${usage.kind === 'partial' ? ' partial' : ''} | ${todos}`);
    if (includePreview) lines.push(`  ${row.tools.length ? row.tools.map((tool) => tool.name).join(', ') : row.activity} | ${row.message || row.task}`);
  }
  return { version: 1, lines: lines.map((line) => {
    const value = boundedOutput(line, 512);
    return value.truncated ? boundedOutput(line, 509).text + '...' : value.text;
  }) };
}

export class RunProgress {
  readonly #snapshot: ProgressSnapshot;
  readonly #publish: (snapshot: ProgressSnapshot) => void;
  #timer: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(tasks: readonly DelegationTask[], publish: (snapshot: ProgressSnapshot) => void) {
    const now = Date.now();
    this.#publish = publish;
    this.#snapshot = { version: 1, startedAt: now, updatedAt: now, endedAt: null, tasks: tasks.map((task, index) => ({
      index, agent: task.agent, role: task.role ?? 'default', task: plain(task.task, 600), model: task.model ?? 'resolving', observedModel: null,
      state: 'preparing', startedAt: null, lastEventAt: null, endedAt: null, activity: 'resolving agent/model', message: '', tools: [], turns: 0,
      todos: null, usage: usageReport(), warning: null,
    })) };
    this.#timer = setInterval(() => this.publish(), 1000).unref();
    this.publish();
  }
  publish(): void {
    this.#snapshot.updatedAt = Date.now();
    try { this.#publish(structuredClone(this.#snapshot)); } catch { /* A display failure must not cancel work. */ }
  }
  admitted(batch: readonly ResolvedTask[]): void {
    for (const [index, task] of batch.entries()) {
      Object.assign(this.#snapshot.tasks[index], { state: 'queued', activity: 'waiting for a worker', model: `${task.model.provider}/${task.model.id}` });
    }
    this.publish();
  }
  preparing(index: number): void { Object.assign(this.#snapshot.tasks[index], { state: 'preparing', activity: 'starting child' }); }
  started(index: number): void {
    Object.assign(this.#snapshot.tasks[index], { state: 'running', startedAt: Date.now(), activity: 'waiting for model' });
    this.publish();
  }
  stopping(): void {
    for (const row of this.#snapshot.tasks) if (!row.endedAt) { row.state = 'stopping'; row.activity = 'stopping and verifying cleanup'; }
    this.publish();
  }
  event(index: number, value: unknown, usage: UsageReport): void {
    const event = record(value);
    const row = this.#snapshot.tasks[index];
    row.lastEventAt = Date.now();
    row.usage = usage;
    if (usage.descendant.kind === 'partial') row.warning = 'UNEXPECTED descendant usage';
    const message = record(event.message);
    if (event.type === 'message_start' && message.role === 'assistant') {
      row.turns++;
      row.activity = 'model responding';
      row.observedModel = `${plain(String(message.provider), 80)}/${plain(String(message.model), 120)}`;
    }
    if (event.type === 'message_update') {
      const delta = record(event.assistantMessageEvent);
      if (delta.type === 'text_start') row.message = '';
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') row.message = plain(row.message + delta.delta, 240);
    }
    if (event.type === 'message_end' && message.role === 'assistant' && Array.isArray(message.content)) {
      const text = message.content.map(record).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join(' ');
      if (text) row.message = plain(text, 240);
    }
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
      const name = plain(event.toolName, 60);
      const args = record(event.args);
      const path = typeof args.path === 'string' ? ` ${plain(args.path, 120)}` : '';
      if (row.tools.length < 16) row.tools.push({ id: event.toolCallId.slice(0, 256), name: name + path });
      row.activity = name + path;
      if (event.toolName === 'subagent') row.warning = 'UNEXPECTED delegation attempt';
    }
    if (event.type === 'tool_execution_end') {
      row.tools = row.tools.filter((tool) => tool.id !== event.toolCallId);
      row.activity = `${plain(String(event.toolName), 60)} ${event.isError ? 'failed' : 'finished'}`;
      if (event.toolName === 'pstack_todo' && !event.isError) {
        const todos = decodeTodoState(record(event.result).details);
        if (todos) row.todos = todos.items.slice(0, 32).map((item) => plain(item, 180));
      }
    }
    if (event.type === 'agent_settled') row.activity = 'verifying cleanup';
    if (event.type === 'auto_retry_start') row.activity = 'provider retry';
    if (event.type === 'compaction_start') row.activity = 'compacting context';
  }
  result(index: number, result: TaskResult): void {
    const row = this.#snapshot.tasks[index];
    Object.assign(row, { state: result.kind, endedAt: row.endedAt ?? Date.now(), tools: [], usage: result.usage,
      activity: result.kind === 'succeeded' ? 'finished' : plain(result.reason),
      warning: result.cleanup.verified ? row.warning : 'CLEANUP UNVERIFIED: session quarantined' });
    this.publish();
  }
  finish(reason = 'Preparation failed'): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    const now = Date.now();
    this.#snapshot.endedAt = now;
    for (const row of this.#snapshot.tasks) if (!row.endedAt) Object.assign(row, { state: 'failed', endedAt: now, tools: [], activity: plain(reason) });
    this.publish();
  }
}
