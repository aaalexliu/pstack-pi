import { randomUUID } from 'node:crypto';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import type { CompactionResult, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { replyText } from '../shared/model.ts';
import { type CachedTurn, contextUnchangedSince, type Handoff } from './plan.ts';
import type { ReplayMessage } from './runtime.ts';

declare const summaryBrand: unique symbol;
export type SummaryText = string & { readonly [summaryBrand]: true };

declare const tokenBrand: unique symbol;
/** Carried in `customInstructions`, the one field Pi passes from `ctx.compact()` to `session_before_compact`. */
export type HandoffToken = string & { readonly [tokenBrand]: true };

const tokenPrefix = 'pstack-idle-compaction:';

export const noticeEntryType = 'pstack-idle-compaction';

export type IdleNoticeData = {
  readonly tokensBefore: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly input: number;
  readonly idleMinutes: number;
};

export type IdleCompactionDetails = {
  readonly trigger: 'idle';
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
};

type FileLists = Pick<IdleCompactionDetails, 'readFiles' | 'modifiedFiles'>;

/** Pi 0.85.1 does not export `SessionBeforeCompactResult` with a typed `details`. */
export type CompactDecision = { readonly cancel: true } | { readonly compaction: CompactionResult<IdleCompactionDetails> };

export const headings = ['## Goal', '## Constraints & Preferences', '## Progress', '## Key Decisions', '## Next Steps', '## Critical Context'] as const;

/** The replay cannot set `toolChoice` without breaking the cache, so the instruction has to forbid tools in words. */
export const summaryInstruction = `This session is paused. Write a checkpoint summary that will replace every message above except your own last reply. Another model will read the summary to continue the work. Your last reply stays verbatim right after the summary, so do not restate it. The system prompt also stays in place, so leave its instructions out of the summary.

Do not call any tool. Do not continue the task or answer open questions. Reply with only the summary, starting with "## Goal", in exactly this format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements and preferences the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Exact names, paths, values, and errors needed to continue, or "(none)"]

Fold any earlier summary in this conversation into this one.`;

export function replayMessages(turn: CachedTurn, now: number): readonly ReplayMessage[] {
  const instruction: UserMessage = { role: 'user', content: summaryInstruction, timestamp: now };
  return [...turn.messages, turn.reply, instruction];
}

export type SummaryParse = { readonly ok: true; readonly text: SummaryText } | { readonly ok: false; readonly problem: string };

const stopProblems: Readonly<Record<string, string>> = {
  aborted: 'the summary request was aborted',
  length: 'the summary hit the output limit',
  toolUse: 'the model answered with a tool call instead of a summary',
};

export function parseSummary(reply: AssistantMessage): SummaryParse {
  if (reply.stopReason === 'error') return { ok: false, problem: `the summary request failed: ${reply.errorMessage ?? 'unknown error'}` };
  if (reply.stopReason !== 'stop') return { ok: false, problem: stopProblems[reply.stopReason] ?? `the summary request ended with ${reply.stopReason}` };
  if (reply.content.some((block) => block.type === 'toolCall')) return { ok: false, problem: stopProblems.toolUse };
  const lines = replyText(reply).split(/\r?\n/u).map((line) => line.trimEnd());
  const start = lines.indexOf(headings[0]);
  if (start < 0) return { ok: false, problem: `the reply was not a summary: no "${headings[0]}" heading` };
  const body = lines.slice(start);
  while (body.length > 0 && (body.at(-1) === '' || body.at(-1) === '```')) body.pop();
  let found = 0;
  for (const line of body) if (line === headings[found]) found++;
  if (found < headings.length) return { ok: false, problem: `the reply was not a summary: no "${headings[found]}" heading` };
  const goalEnd = body.findIndex((line, index) => index > 0 && line.startsWith('## '));
  if (!body.slice(1, goalEnd).some((line) => line.trim() !== '')) return { ok: false, problem: 'the summary has no goal' };
  return { ok: true, text: body.join('\n') as SummaryText };
}

export function newToken(): HandoffToken {
  return `${tokenPrefix}${randomUUID()}` as HandoffToken;
}

export function isIdleToken(customInstructions: string | undefined): boolean {
  return customInstructions?.startsWith(tokenPrefix) === true;
}

const stringList = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

const record = (value: unknown): Readonly<Record<string, unknown>> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** Pi's `extractFileOpsFromMessage`: model tool calls, plus the calls a codemode script made, recorded on its result. */
function toolCalls(message: ReplayMessage): readonly Readonly<Record<string, unknown>>[] {
  const fields = record(message);
  if (message.role === 'toolResult') {
    const calls = record(fields.nestedCalls).calls;
    return Array.isArray(calls) ? calls.map(record) : [];
  }
  if (message.role !== 'assistant' || !Array.isArray(fields.content)) return [];
  return fields.content.map(record).filter((block) => block.type === 'toolCall');
}

/** Pi carries file lists forward only from its own compactions, so merge the newest compaction's lists here. */
export function fileLists(messages: readonly ReplayMessage[], branch: readonly { readonly type: string; readonly details?: unknown }[]): FileLists {
  const previous = record(branch.findLast((entry) => entry.type === 'compaction')?.details);
  const read = new Set(stringList(previous.readFiles));
  const modified = new Set(stringList(previous.modifiedFiles));
  for (const call of messages.flatMap(toolCalls)) {
    const file = record(call.arguments).path;
    if (typeof file !== 'string' || file === '') continue;
    if (call.name === 'read') read.add(file);
    if (call.name === 'write' || call.name === 'edit') modified.add(file);
  }
  return { readFiles: [...read].filter((file) => !modified.has(file)).sort(), modifiedFiles: [...modified].sort() };
}

export function withFileLists(text: SummaryText, lists: FileLists): string {
  const sections = [
    lists.readFiles.length > 0 ? `<read-files>\n${lists.readFiles.join('\n')}\n</read-files>` : '',
    lists.modifiedFiles.length > 0 ? `<modified-files>\n${lists.modifiedFiles.join('\n')}\n</modified-files>` : '',
  ].filter(Boolean);
  return sections.length > 0 ? `${text}\n\n${sections.join('\n\n')}` : text;
}

type CompactEvent = Pick<SessionBeforeCompactEvent, 'customInstructions' | 'reason' | 'preparation' | 'branchEntries'>;

/**
 * A handler that returns nothing for our token lets Pi run its uncached summarizer with the token as
 * its instructions, so anything but the live hand-off cancels. Pi's usual kept tail would repeat what
 * the summary covers, so the compaction keeps from the reply entry, which keeps only the reply.
 */
export function compactionFor(event: CompactEvent, live: Handoff | undefined): CompactDecision | undefined {
  if (!isIdleToken(event.customInstructions)) return undefined;
  if (!live || event.customInstructions !== live.token || event.reason !== 'manual') return { cancel: true };
  if (!contextUnchangedSince(event.branchEntries, live.plan.turn.replyEntryId)) return { cancel: true };
  const { turn } = live.plan;
  const lists = fileLists([...turn.messages, turn.reply], event.branchEntries);
  return {
    compaction: {
      summary: withFileLists(live.summary.text, lists),
      firstKeptEntryId: turn.replyEntryId,
      tokensBefore: event.preparation.tokensBefore,
      usage: live.summary.usage,
      details: { trigger: 'idle', ...lists },
    },
  };
}

export function isIdleCompaction(details: unknown): boolean {
  return typeof details === 'object' && details !== null && 'trigger' in details && details.trigger === 'idle';
}

export function noticeText(data: IdleNoticeData): string {
  const prompt = data.cacheRead + data.cacheWrite + data.input;
  const share = prompt > 0 ? `, ${Math.round((100 * data.cacheRead) / prompt)}% read from cache` : '';
  return `Compacted while idle, before the prompt cache expired (${data.idleMinutes} min idle, ${data.tokensBefore.toLocaleString('en-US')} tokens${share})`;
}

export function parseNotice(data: unknown): IdleNoticeData | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const fields = data as Record<keyof IdleNoticeData, unknown>;
  const keys = ['tokensBefore', 'cacheRead', 'cacheWrite', 'input', 'idleMinutes'] as const;
  return keys.every((key) => typeof fields[key] === 'number' && Number.isFinite(fields[key])) ? fields as IdleNoticeData : undefined;
}
