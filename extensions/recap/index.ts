import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { replyText, smallModel } from '../shared/model.ts';
import { cleanRecap, needsRecap, recapEntryType, systemPrompt, transcript } from './summary.ts';

/** Claude Code's away-summary delay. */
export const idleMs = 180_000;
const requestTimeoutMs = 60_000;
const statusKey = 'pstack-recap';

type RecapData = { text?: unknown };

export default function recap(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let job: AbortController | undefined;
  let warned = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    job?.abort();
    job = undefined;
  };

  /** Resolves to an error message, or undefined when it wrote a recap or had nothing to do. */
  const write = async (ctx: ExtensionContext, manual: boolean): Promise<string | undefined> => {
    const model = smallModel(ctx.modelRegistry, ctx.model);
    if (!model) return undefined;
    const branch = ctx.sessionManager.getBranch();
    if (!manual && !needsRecap(branch)) return undefined;
    const prompt = transcript(branch, pi.getSessionName());
    if (!prompt) return manual ? 'there is no conversation to recap yet' : undefined;

    const controller = new AbortController();
    job = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    ctx.ui.setStatus(statusKey, ctx.ui.theme.fg('dim', '※ writing recap…'));
    try {
      const reply = await ctx.modelRegistry.complete(model, {
        systemPrompt,
        messages: [{ role: 'user', content: `Recap this session.\n\n<transcript>\n${prompt}\n</transcript>`, timestamp: Date.now() }],
      }, { maxTokens: 1024, signal: controller.signal });
      if (timedOut) return `no reply within ${requestTimeoutMs / 1000}s`;
      if (controller.signal.aborted) return undefined;
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return reply.errorMessage ?? `the ${model.id} request failed`;
      const text = cleanRecap(replyText(reply));
      if (!text) return `${model.id} returned an empty recap`;
      pi.appendEntry(recapEntryType, { text });
      return undefined;
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return undefined;
      return error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
      if (job === controller) job = undefined;
      if (!job) ctx.ui.setStatus(statusKey, undefined);
    }
  };

  pi.registerEntryRenderer<RecapData>(recapEntryType, (entry, _options, theme) => {
    const text = entry.data?.text;
    if (typeof text !== 'string') return undefined;
    return new Text(`${theme.fg('dim', '※ ')}${theme.fg('muted', theme.bold('recap:'))} ${theme.fg('dim', theme.italic(text))}`, 1, 0);
  });

  pi.on('session_start', () => {
    cancel();
    warned = false;
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      void write(ctx, false).then((error) => {
        if (!error || warned) return;
        warned = true;
        ctx.ui.notify(`[recap] could not write a recap: ${error}`, 'warning');
      });
    }, idleMs);
    timer.unref?.();
  });

  pi.on('input', () => cancel());
  pi.on('user_bash', () => cancel());
  pi.on('agent_start', () => cancel());
  pi.on('session_shutdown', () => cancel());

  pi.registerCommand('recap', {
    description: 'Write a recap of this session now',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify('[recap] wait until the agent finishes', 'warning');
        return;
      }
      cancel();
      const error = await write(ctx, true);
      if (error) ctx.ui.notify(`[recap] could not write a recap: ${error}`, 'warning');
    },
  });
}
