import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { ReplayMessage } from './runtime.ts';
import type { HandoffToken, SummaryText } from './summary.ts';

export type CapturedRequest = {
  readonly messages: readonly ReplayMessage[];
  readonly model: Model<Api>;
  readonly thinkingLevel: string | undefined;
  readonly longTtlMs: number | undefined;
  readonly startedAt: number;
};

/** A finished run whose cache entry a replay can read: the captured request and the reply that answered it. */
export type CachedTurn = CapturedRequest & {
  readonly reply: AssistantMessage;
  readonly replyEntryId: string;
  readonly contextTokens: number;
};

export type CacheWindow = {
  readonly fireAt: number;
  readonly staleAt: number;
};

export type IdlePlan = { readonly turn: CachedTurn; readonly window: CacheWindow };

export type IdleFacts = {
  readonly mode: ExtensionContext['mode'];
  readonly canReplay: boolean;
  readonly autoCompaction: boolean;
  readonly enabled: boolean;
  readonly longRetention: boolean;
  readonly minTokens: number;
};

export type Ineligible =
  | { readonly reason: 'not-tui' }
  | { readonly reason: 'unsupported-pi' }
  | { readonly reason: 'auto-compaction-off' }
  | { readonly reason: 'turned-off' }
  | { readonly reason: 'no-request' }
  | { readonly reason: 'aborted' }
  | { readonly reason: 'unfinished-reply' }
  | { readonly reason: 'context-moved' }
  | { readonly reason: 'short-cache' }
  | { readonly reason: 'no-long-cache'; readonly model: string }
  | { readonly reason: 'below-threshold'; readonly tokens: number; readonly minTokens: number };

export type PreparedSummary = { readonly text: SummaryText; readonly usage: Usage };

export type Handoff = { readonly token: HandoffToken; readonly summary: PreparedSummary; readonly plan: IdlePlan };

export type WaitReason =
  | Ineligible
  | { readonly reason: 'activity' }
  | { readonly reason: 'missed' }
  | { readonly reason: 'compacted'; readonly at: number }
  | { readonly reason: 'failed'; readonly error: string };

/** Each resource lives in exactly one phase, so one writer that tears down the old phase keeps at most one timer or summary alive. */
export type Phase =
  | { readonly kind: 'waiting'; readonly why: WaitReason }
  | { readonly kind: 'armed'; readonly plan: IdlePlan; readonly timer: ReturnType<typeof setTimeout> }
  | { readonly kind: 'summarizing'; readonly plan: IdlePlan; readonly controller: AbortController }
  | { readonly kind: 'handing-off'; readonly handoff: Handoff };

/** Claude Code's `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` default. */
export const defaultMinTokens = 200_000;

/** Pi's `getCacheWarmingDelayMs` (`dist/core/cache-warmer.js`), which Pi does not export. */
export function warmingDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Like Pi's cache warmer, a late timer keeps half of the margin left before expiry. */
export function cacheWindow(startedAt: number, ttlMs: number): CacheWindow | undefined {
  const delay = warmingDelayMs(ttlMs);
  if (delay === undefined) return undefined;
  const fireAt = startedAt + delay;
  return { fireAt, staleAt: fireAt + Math.floor((ttlMs - delay) / 2) };
}

const invisibleEntryTypes: ReadonlySet<string> = new Set(['custom', 'label', 'session_info', 'usage']);

export function contextUnchangedSince(branch: readonly { readonly id: string; readonly type: string }[], replyEntryId: string): boolean {
  const index = branch.findLastIndex((entry) => entry.id === replyEntryId);
  return index >= 0 && branch.slice(index + 1).every((entry) => invisibleEntryTypes.has(entry.type));
}

type ReplyEntry = SessionMessageEntry & { message: AssistantMessage };

export function settleTurn(capture: CapturedRequest | undefined, branch: readonly SessionEntry[]): CachedTurn | Ineligible {
  if (!capture) return { reason: 'no-request' };
  const entry = branch.findLast((candidate): candidate is ReplyEntry => candidate.type === 'message' && candidate.message.role === 'assistant');
  if (!entry || entry.message.timestamp < capture.startedAt) return { reason: 'no-request' };
  const reply = entry.message;
  if (reply.stopReason !== 'stop' || reply.content.some((block) => block.type === 'toolCall')) return { reason: 'unfinished-reply' };
  if (!contextUnchangedSince(branch, entry.id)) return { reason: 'context-moved' };
  const { input, cacheRead, cacheWrite, output } = reply.usage;
  return { ...capture, reply, replyEntryId: entry.id, contextTokens: input + cacheRead + cacheWrite + output };
}

export function planIdle(turn: CachedTurn | Ineligible, facts: IdleFacts): IdlePlan | Ineligible {
  if (facts.mode !== 'tui') return { reason: 'not-tui' };
  if (!facts.canReplay) return { reason: 'unsupported-pi' };
  if (!facts.autoCompaction) return { reason: 'auto-compaction-off' };
  if (!facts.enabled) return { reason: 'turned-off' };
  if ('reason' in turn) return turn;
  if (!facts.longRetention) return { reason: 'short-cache' };
  const window = turn.longTtlMs === undefined ? undefined : cacheWindow(turn.startedAt, turn.longTtlMs);
  if (!window) return { reason: 'no-long-cache', model: turn.model.id };
  if (turn.contextTokens < facts.minTokens) return { reason: 'below-threshold', tokens: turn.contextTokens, minTokens: facts.minTokens };
  return { turn, window };
}

const count = (value: number) => value.toLocaleString('en-US');
const pad = (value: number) => String(value).padStart(2, '0');
const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

type WaitMap = { [R in WaitReason['reason']]: Extract<WaitReason, { reason: R }> };

const waitingText: { [R in keyof WaitMap]: (why: WaitMap[R]) => string } = {
  'not-tui': () => 'Not armed: idle compaction runs only in the interactive TUI.',
  'unsupported-pi': () => 'Not armed: this Pi version cannot replay requests from an extension.',
  'auto-compaction-off': () => "Not armed: Pi's auto-compaction is off (compaction.enabled is false).",
  'turned-off': () => 'Not armed: turned off. Run /idle-compaction on to turn it back on.',
  'no-request': () => 'Not armed: waiting for the next run to finish.',
  aborted: () => 'Not armed: the last run was stopped.',
  'unfinished-reply': () => 'Not armed: the last run did not end on a plain answer.',
  'context-moved': () => 'Not armed: the conversation changed after the last reply.',
  'short-cache': () => 'Not armed: Pi uses the 5-minute prompt cache. Start Pi with PI_CACHE_RETENTION=long to use idle compaction.',
  'no-long-cache': (why) => `Not armed: ${why.model} has no one-hour prompt cache.`,
  'below-threshold': (why) => `Not armed: ${count(why.tokens)} tokens is below the ${count(why.minTokens)}-token threshold (PSTACK_IDLE_COMPACT_MIN_TOKENS).`,
  activity: () => 'Not armed: the session was used after the last run. The next finished run arms it again.',
  missed: () => 'Not armed: the timer ran after the prompt cache may have expired, so it did nothing. Was the computer asleep?',
  compacted: (why) => `Not armed: compacted while idle at ${clock(why.at)}. The next finished run arms it again.`,
  failed: (why) => `Not armed: the last idle compaction failed: ${why.error}`,
};

const describeWait = <R extends keyof WaitMap>(reason: R, why: WaitMap[R]): string => waitingText[reason](why);

export function statusText(phase: Phase, now: number): string {
  switch (phase.kind) {
    case 'waiting': return describeWait(phase.why.reason, phase.why);
    case 'armed': {
      const { fireAt } = phase.plan.window;
      return `Armed. Compacts at ${clock(fireAt)} (in ${Math.max(0, Math.ceil((fireAt - now) / 60_000))} min) if this session stays idle.`;
    }
    case 'summarizing': return 'Compacting now: writing the summary from the prompt cache.';
    case 'handing-off': return 'Compacting now.';
  }
}
