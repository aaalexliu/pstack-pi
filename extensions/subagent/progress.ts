import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { decodeTodoState } from '../pstack/todo.ts';
import type { SingleResult } from './index.ts';

// The runner owns usage and terminal results. This module owns only public display state.
export type ProgressUsage = SingleResult['usage'];
export type ProgressTask = { agent: string; task: string; role?: string; model?: string };
export type TaskProgress = {
  index: number; agent: string; role: string; task: string; model: string; observedModel: string | null;
  state: 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'aborted' | 'skipped';
  startedAt: number | null; lastEventAt: number | null; endedAt: number | null;
  activity: string; message: string; tools: { id: string; name: string }[];
  todos: string[] | null; usage: ProgressUsage; warning: string | null;
  events: { at: number; type: string; summary: string }[];
};
export type ProgressSnapshot = { version: 1; updatedAt: number; startedAt: number; endedAt: number | null; tasks: TaskProgress[] };
export const INLINE_TASK_LIMIT = 8;

export function plain(value: string, limit = 180): string {
  return Array.from(stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
}
export function clip(text: string, width: number): string {
  return width <= 0 ? '' : truncateToWidth(text, width, '');
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function copyUsage(usage?: ProgressUsage): ProgressUsage {
  return { input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0, cost: usage?.cost ?? 0, contextTokens: usage?.contextTokens ?? 0, turns: usage?.turns ?? 0 };
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
export function taskLine(row: TaskProgress, now: number): string {
  const end = row.endedAt ?? now;
  const elapsed = row.startedAt === null ? '' : ` ${duration(end - row.startedAt)}`;
  const quiet = row.lastEventAt === null ? 'no events yet' : `last event ${duration(end - row.lastEventAt)} ${row.endedAt === null ? 'ago' : 'before finish'}`;
  const warning = row.warning ?? (row.endedAt === null && row.startedAt !== null && now - row.startedAt >= 600_000 ? 'LONG RUN: check scope'
    : row.state === 'running' && now - (row.lastEventAt ?? row.startedAt ?? now) >= 60_000 ? 'QUIET: check activity' : null);
  return `#${row.index + 1} ${plain(row.role)} | ${row.state}${elapsed} | ${quiet}${warning ? ` | ${plain(warning)}` : ''}`;
}
function heading(snapshot: ProgressSnapshot): string {
  return `Subagents ${snapshot.tasks.filter((row) => row.endedAt !== null).length}/${snapshot.tasks.length} finished`;
}
function modelLine(row: TaskProgress): string {
  return `  ${plain(row.agent)} | ${plain(row.observedModel ?? row.model, 201)}${row.observedModel ? '' : ' (selected)'}`;
}
function usageLine(row: TaskProgress): string {
  const usage = row.usage;
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const todos = row.todos === null ? 'todos not reported' : `todos ${row.todos.filter((item) => item.startsWith('[done] ')).length}/${row.todos.length} (self-reported)`;
  return `  ${tokens} tok $${usage.cost.toFixed(4)} | ${todos}`;
}
function previewLine(row: TaskProgress): string {
  return `  ${plain(row.tools.length ? row.tools.map((tool) => tool.name).join(', ') : row.activity)} | ${plain(row.message || row.task, 240)}`;
}
export function progressLines(snapshot: ProgressSnapshot, detailed = false): string[] {
  const lines = [heading(snapshot)];
  for (const row of snapshot.tasks) {
    lines.push(taskLine(row, snapshot.endedAt ?? snapshot.updatedAt), modelLine(row), usageLine(row), previewLine(row));
    if (detailed) {
      lines.push(`  Task: ${plain(row.task, 600)}`, `  Turns: ${row.usage.turns} | in ${row.usage.input} / out ${row.usage.output} / cache ${row.usage.cacheRead + row.usage.cacheWrite} | ctx ${row.usage.contextTokens}`);
      if (row.todos !== null) lines.push(...row.todos.map((item) => `  ${item.startsWith('[done] ') ? '[x] ' + plain(item.slice(7)) : '[ ] ' + plain(item)}`));
      lines.push(...row.events.map((event) => `  ${duration(event.at - (row.startedAt ?? event.at))} ${plain(event.type, 60)}: ${plain(event.summary)}`));
    }
  }
  lines.push('Event age is not proof of work. Usage can lag.');
  return lines;
}

// Bound the inline view, not the chain. Active tasks precede queued tasks and recent results.
export function inlineTasks(snapshot: ProgressSnapshot): TaskProgress[] {
  const active = snapshot.tasks.filter((row) => row.endedAt === null && row.state !== 'queued');
  const queued = snapshot.tasks.filter((row) => row.endedAt === null && row.state === 'queued');
  const ended = snapshot.tasks.filter((row) => row.endedAt !== null).reverse();
  return [...active, ...queued, ...ended].slice(0, INLINE_TASK_LIMIT).sort((a, b) => a.index - b.index);
}
export function progressCard(snapshot: ProgressSnapshot, includePreview = snapshot.endedAt === null, expanded = false): { version: 1; lines: string[] } {
  const rows = expanded ? snapshot.tasks : inlineTasks(snapshot);
  const lines = [heading(snapshot)];
  for (const row of rows) {
    lines.push(taskLine(row, snapshot.endedAt ?? snapshot.updatedAt), modelLine(row), usageLine(row));
    if (includePreview) lines.push(previewLine(row));
  }
  if (rows.length < snapshot.tasks.length) lines.push(`... ${snapshot.tasks.length - rows.length} tasks omitted | expand this tool card for all tasks`);
  return { version: 1, lines };
}

export class RunProgress {
  readonly #snapshot: ProgressSnapshot;
  readonly #publish: (snapshot: ProgressSnapshot) => void;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #drafts = new Map<number, string>();
  #closed = false;
  constructor(tasks: readonly ProgressTask[], publish: (snapshot: ProgressSnapshot) => void) {
    const now = Date.now();
    this.#publish = publish;
    this.#snapshot = { version: 1, startedAt: now, updatedAt: now, endedAt: null, tasks: tasks.map((task, index) => ({
      index, agent: plain(task.agent, 80), role: plain(task.role ?? 'default', 80), task: plain(task.task, 600), model: plain(task.model ?? 'parent model', 201), observedModel: null,
      state: 'queued', startedAt: null, lastEventAt: null, endedAt: null, activity: 'waiting to start', message: '', tools: [],
      todos: null, usage: copyUsage(), warning: null, events: [],
    })) };
    this.#timer = setInterval(() => this.publish(), 1000).unref();
    this.publish();
  }
  publish(): void {
    this.#snapshot.updatedAt = this.#snapshot.endedAt ?? Date.now();
    try { Promise.resolve(this.#publish(structuredClone(this.#snapshot))).catch(() => {}); } catch { /* Display failures must not cancel work. */ }
  }
  #openRow(index: number): TaskProgress | undefined {
    const row = this.#snapshot.tasks[index];
    return !this.#closed && row?.endedAt === null ? row : undefined;
  }
  started(index: number): void {
    const row = this.#openRow(index);
    if (!row || row.state !== 'queued') return;
    Object.assign(row, { state: 'running', startedAt: Date.now(), activity: 'waiting for model' });
    this.publish();
  }
  stopping(index: number): void {
    const row = this.#openRow(index);
    if (!row || row.startedAt === null) return;
    row.state = 'stopping';
    row.activity = 'stop requested';
    this.publish();
  }
  event(index: number, value: unknown, usage: ProgressUsage): void {
    const row = this.#openRow(index);
    if (!row || row.startedAt === null) return;
    row.usage = copyUsage(usage);
    const event = record(value);
    if (typeof event.type !== 'string') return;
    const message = record(event.message);
    let summary: string | undefined;
    if (['message_start', 'message_update', 'message_end'].includes(event.type) && message.role === 'assistant') {
      if (typeof message.provider === 'string' && typeof message.model === 'string') row.observedModel = `${plain(message.provider, 80)}/${plain(message.model, 120)}`;
    }
    if (event.type === 'message_start' && message.role === 'assistant') {
      this.#drafts.delete(index);
      row.activity = 'model responding';
      summary = row.activity;
    }
    if (event.type === 'message_update') {
      const delta = record(event.assistantMessageEvent);
      if (delta.type === 'text_start') { this.#drafts.delete(index); row.message = ''; }
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
        const draft = ((this.#drafts.get(index) ?? '') + delta.delta).slice(0, 4096);
        this.#drafts.set(index, draft);
        row.message = plain(draft, 240);
        summary = 'public text update';
      }
      // Record activity, never thinking content or protocol payloads.
      if (delta.type === 'thinking_delta') summary = 'model responding';
    }
    if (event.type === 'message_end' && message.role === 'assistant') {
      let text = '';
      if (Array.isArray(message.content)) for (const value of message.content) {
        const part = record(value);
        if (part.type === 'text' && typeof part.text === 'string') text = plain(`${text} ${plain(part.text, 240)}`, 240);
        if (text.length >= 240) break;
      }
      if (text) row.message = text;
      this.#drafts.delete(index);
      summary = 'assistant message finished';
    }
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
      const name = plain(event.toolName, 60);
      const args = record(event.args);
      const path = typeof args.path === 'string' ? ` ${plain(args.path, 120)}` : '';
      const id = plain(event.toolCallId, 256);
      if (row.tools.length < 16 && !row.tools.some((tool) => tool.id === id)) row.tools.push({ id, name: name + path });
      summary = row.activity = plain(name + path);
    }
    if (event.type === 'tool_execution_end') {
      if (typeof event.toolCallId === 'string') {
        const id = plain(event.toolCallId, 256);
        row.tools = row.tools.filter((tool) => tool.id !== id);
      }
      summary = row.activity = `${typeof event.toolName === 'string' ? plain(event.toolName, 60) : 'tool'} ${event.isError ? 'failed' : 'finished'}`;
      if (event.toolName === 'pstack_todo' && !event.isError) this.#todos(row, record(event.result).details);
    }
    if (event.type === 'message_end' && message.role === 'toolResult' && message.toolName === 'pstack_todo' && !message.isError) {
      this.#todos(row, message.details);
      summary = 'todo list reported';
    }
    if (event.type === 'tool_execution_update') summary = 'tool update';
    if (event.type === 'agent_start' || event.type === 'turn_start') summary = row.activity = 'waiting for model';
    if (event.type === 'agent_end' || event.type === 'turn_end') summary = 'turn finished';
    if (event.type === 'agent_settled') summary = row.activity = 'agent settled; awaiting result';
    if (event.type === 'auto_retry_start') summary = row.activity = 'provider retry';
    if (event.type === 'auto_compaction_start') summary = row.activity = 'compacting context';
    if (summary !== undefined) {
      row.lastEventAt = Date.now();
      row.events.push({ at: row.lastEventAt, type: event.type, summary: plain(summary) });
      if (row.events.length > 16) row.events.shift();
    }
  }
  #todos(row: TaskProgress, value: unknown): void {
    const todos = decodeTodoState(value);
    if (todos) row.todos = todos.items.map((item) => plain(item, 180));
  }
  result(index: number, result: Pick<SingleResult, 'exitCode' | 'stopReason' | 'errorMessage' | 'usage'>): void {
    const row = this.#openRow(index);
    if (!row) return;
    const state = result.stopReason === 'aborted' ? 'aborted' : result.exitCode !== 0 || result.stopReason === 'error' ? 'failed' : 'succeeded';
    Object.assign(row, { state, endedAt: Date.now(), tools: [], usage: copyUsage(result.usage),
      activity: state === 'succeeded' ? 'finished' : plain(result.errorMessage || result.stopReason || `Exited with code ${result.exitCode}`) });
    this.#drafts.delete(index);
    this.publish();
  }
  finish(reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#drafts.clear();
    const now = Date.now();
    this.#snapshot.endedAt = now;
    for (const row of this.#snapshot.tasks) if (row.endedAt === null) Object.assign(row, {
      state: row.startedAt === null ? 'skipped' : 'failed', endedAt: now, tools: [],
      activity: plain(reason || (row.startedAt === null ? 'not started' : 'ended without a terminal result')),
    });
    this.publish();
  }
}
