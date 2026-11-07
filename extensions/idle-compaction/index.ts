import { type ExtensionAPI, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { loadSettings, saveSettings, settingsPath } from '../shared/settings.ts';
import {
  type CachedTurn,
  type CapturedRequest,
  contextUnchangedSince,
  defaultMinTokens,
  type Handoff,
  type IdleFacts,
  type IdlePlan,
  type Phase,
  planIdle,
  type PreparedSummary,
  settleTurn,
  statusText,
  type WaitReason,
} from './plan.ts';
import { autoCompactionEnabled, longCacheTtlMs, longRetention, minTokensOverride, onRequest, type Replay, replayer, settledAborted } from './runtime.ts';
import { compactionFor, isIdleCompaction, isIdleToken, newToken, noticeEntryType, noticeText, parseNotice, parseSummary, replayMessages } from './summary.ts';

export const summaryTimeoutMs = 300_000;
const statusKey = 'pstack-idle-compaction';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function idleCompaction(pi: ExtensionAPI): void {
  let capture: CapturedRequest | undefined;
  let phase: Phase = { kind: 'waiting', why: { reason: 'no-request' } };
  let enabled = true;
  let warned = false;

  const enter = (next: Phase, ctx: ExtensionContext): void => {
    const previous = phase;
    phase = next;
    if (previous.kind === 'armed') clearTimeout(previous.timer);
    if (previous.kind === 'summarizing') {
      previous.controller.abort();
      ctx.ui.setStatus(statusKey, undefined);
    }
    if (next.kind === 'summarizing') ctx.ui.setStatus(statusKey, ctx.ui.theme.fg('dim', '※ compacting while idle…'));
  };

  const wait = (why: WaitReason, ctx: ExtensionContext) => enter({ kind: 'waiting', why }, ctx);

  /** A hand-off already inside Pi's compaction finishes: the summary is paid for, and Pi queues typed input meanwhile. */
  const cancel = (ctx: ExtensionContext): void => {
    if (phase.kind === 'armed' || phase.kind === 'summarizing') wait({ reason: 'activity' }, ctx);
  };

  const warnOnce = (ctx: ExtensionContext, text: string): void => {
    if (warned) return;
    warned = true;
    ctx.ui.notify(`[idle-compaction] ${text}`, 'warning');
  };

  const facts = (ctx: ExtensionContext, replay: Replay | undefined): IdleFacts => {
    const autoCompaction = autoCompactionEnabled(pi);
    return {
      mode: ctx.mode,
      canReplay: replay !== undefined && autoCompaction !== undefined,
      autoCompaction: autoCompaction !== false,
      enabled,
      longRetention: longRetention(process.env),
      minTokens: minTokensOverride(process.env) ?? defaultMinTokens,
    };
  };

  const ready = (ctx: ExtensionContext, turn: CachedTurn): boolean =>
    ctx.isIdle() && !ctx.hasPendingMessages() && contextUnchangedSince(ctx.sessionManager.getBranch(), turn.replyEntryId);

  const fire = (ctx: ExtensionContext, plan: IdlePlan): void => {
    if (phase.kind !== 'armed' || phase.plan !== plan) return;
    if (Date.now() >= plan.window.staleAt) return wait({ reason: 'missed' }, ctx);
    if (autoCompactionEnabled(pi) === false) return wait({ reason: 'auto-compaction-off' }, ctx);
    if (!ready(ctx, plan.turn)) return wait({ reason: 'activity' }, ctx);
    const replay = replayer(ctx);
    if (!replay) return wait({ reason: 'unsupported-pi' }, ctx);
    const current = { kind: 'summarizing', plan, controller: new AbortController() } as const;
    enter(current, ctx);
    void summarize(ctx, current, replay);
  };

  const fail = (ctx: ExtensionContext, error: string): void => {
    wait({ reason: 'failed', error }, ctx);
    warnOnce(ctx, `skipped idle compaction: ${error}`);
  };

  const summarize = async (ctx: ExtensionContext, current: Extract<Phase, { kind: 'summarizing' }>, replay: Replay): Promise<void> => {
    const { turn } = current.plan;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      current.controller.abort();
    }, summaryTimeoutMs);
    timeout.unref?.();
    const timeoutText = `no summary within ${summaryTimeoutMs / 60_000} minutes`;
    try {
      const answer = await replay(turn.model, replayMessages(turn, Date.now()), {
        thinkingLevel: turn.thinkingLevel,
        sessionId: ctx.sessionManager.getSessionId(),
        signal: current.controller.signal,
      });
      if (phase !== current) return;
      if (timedOut) return fail(ctx, timeoutText);
      const parsed = parseSummary(answer);
      if (!parsed.ok) return fail(ctx, parsed.problem);
      handOff(ctx, current.plan, { text: parsed.text, usage: answer.usage });
    } catch (error) {
      if (phase === current) fail(ctx, timedOut ? timeoutText : message(error));
    } finally {
      clearTimeout(timeout);
    }
  };

  /** `ctx.compact()` aborts any agent run first, so idleness is checked in the same tick. */
  const handOff = (ctx: ExtensionContext, plan: IdlePlan, summary: PreparedSummary): void => {
    if (!ready(ctx, plan.turn)) return wait({ reason: 'activity' }, ctx);
    const handoff: Handoff = { token: newToken(), summary, plan };
    enter({ kind: 'handing-off', handoff }, ctx);
    const current = () => phase.kind === 'handing-off' && phase.handoff === handoff;
    ctx.compact({
      customInstructions: handoff.token,
      onComplete: (result) => {
        if (isIdleCompaction(result.details)) {
          const { cacheRead, cacheWrite, input } = summary.usage;
          pi.appendEntry(noticeEntryType, {
            tokensBefore: result.tokensBefore, cacheRead, cacheWrite, input,
            idleMinutes: Math.round((Date.now() - plan.turn.startedAt) / 60_000),
          });
        }
        if (current()) wait({ reason: 'compacted', at: Date.now() }, ctx);
      },
      onError: (error) => {
        if (current()) wait({ reason: 'failed', error: error.message }, ctx);
        if (error.message !== 'Compaction cancelled') warnOnce(ctx, `could not compact while idle: ${error.message}`);
      },
    });
  };

  onRequest(pi, (messages, ctx) => {
    cancel(ctx);
    capture = ctx.model && {
      messages: [...messages],
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      longTtlMs: longCacheTtlMs(ctx.model),
      startedAt: Date.now(),
    };
  });

  pi.on('agent_settled', (event, ctx) => {
    const turn = settledAborted(event) ? { reason: 'aborted' as const } : settleTurn(capture, ctx.sessionManager.getBranch());
    const plan = planIdle(turn, facts(ctx, replayer(ctx)));
    if ('reason' in plan) return wait(plan, ctx);
    const timer = setTimeout(() => fire(ctx, plan), Math.max(0, plan.window.fireAt - Date.now()));
    timer.unref?.();
    enter({ kind: 'armed', plan, timer }, ctx);
  });

  pi.on('session_before_compact', (event, ctx) => {
    if (!isIdleToken(event.customInstructions)) {
      cancel(ctx);
      return undefined;
    }
    try {
      return compactionFor(event, phase.kind === 'handing-off' ? phase.handoff : undefined);
    } catch {
      return { cancel: true };
    }
  });

  pi.on('input', (_event, ctx) => cancel(ctx));
  pi.on('user_bash', (_event, ctx) => cancel(ctx));
  pi.on('agent_start', (_event, ctx) => cancel(ctx));
  pi.on('model_select', (_event, ctx) => cancel(ctx));
  pi.on('thinking_level_select', (_event, ctx) => cancel(ctx));
  pi.on('session_before_tree', (_event, ctx) => cancel(ctx));
  pi.on('session_shutdown', (_event, ctx) => cancel(ctx));

  pi.on('session_start', async (_event, ctx) => {
    capture = undefined;
    warned = false;
    wait({ reason: replayer(ctx) ? 'no-request' : 'unsupported-pi' }, ctx);
    try {
      enabled = (await loadSettings(getAgentDir())).idleCompaction;
    } catch (error) {
      enabled = false;
      warnOnce(ctx, `idle compaction is off: ${message(error)}`);
    }
  });

  pi.registerEntryRenderer(noticeEntryType, (entry, _options, theme) => {
    const data = parseNotice(entry.data);
    return data && new Text(theme.fg('dim', `※ ${noticeText(data)}`), 1, 0);
  });

  pi.registerCommand('idle-compaction', {
    description: 'Show idle compaction status, or turn it on or off',
    getArgumentCompletions: (prefix) => ['status', 'on', 'off'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      if (action !== 'status' && action !== 'on' && action !== 'off') {
        ctx.ui.notify('Usage: /idle-compaction on|off|status', 'warning');
        return;
      }
      const dir = getAgentDir();
      try {
        if (action !== 'status') {
          await saveSettings(dir, { idleCompaction: action === 'on' });
          enabled = action === 'on';
          if (!enabled && phase.kind !== 'handing-off') wait({ reason: 'turned-off' }, ctx);
          if (enabled && phase.kind === 'waiting' && phase.why.reason === 'turned-off') wait({ reason: 'no-request' }, ctx);
        }
        ctx.ui.notify(`Idle compaction: ${enabled ? 'on' : 'off'}. ${statusText(phase, Date.now())}\nSetting: ${settingsPath(dir)}`, 'info');
      } catch (error) {
        ctx.ui.notify(message(error), 'error');
      }
    },
  });
}
