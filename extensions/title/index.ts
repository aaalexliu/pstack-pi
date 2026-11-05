import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  lastAssistantText,
  nextTitle,
  parseReply,
  replyText,
  restoreAutoTitle,
  systemPrompt,
  terminalTitle,
  titleEntryType,
  titleModel,
  userPrompt,
} from './naming.ts';

const requestTimeoutMs = 30_000;
// Pi writes its own title after every session_start handler has finished, and other
// extensions can make that take a while. Write ours again until Pi is surely done.
const startTitleDelaysMs = [0, 500, 2000, 5000];

type Complete = (model: Model<Api>, context: Context, options: { maxTokens: number; signal: AbortSignal }) => Promise<AssistantMessage>;

/** `ModelRegistry.complete` arrived after Pi 0.85.1. Without it the extension does nothing. */
function completer(ctx: ExtensionContext): Complete | undefined {
  const complete = (ctx.modelRegistry as unknown as { complete?: Complete }).complete;
  return typeof complete === 'function' ? complete.bind(ctx.modelRegistry) : undefined;
}

export default function title(pi: ExtensionAPI): void {
  let autoTitle: string | undefined;
  let job: AbortController | undefined;
  let warned = false;
  let titleTimers: ReturnType<typeof setTimeout>[] = [];

  const cancel = () => {
    job?.abort();
    job = undefined;
  };

  const clearTitleTimers = () => {
    for (const timer of titleTimers) clearTimeout(timer);
    titleTimers = [];
  };

  const showTitle = (ctx: ExtensionContext) => {
    if (ctx.mode === 'tui') ctx.ui.setTitle(terminalTitle(pi.getSessionName(), ctx.sessionManager.getCwd()));
  };

  pi.on('session_start', (_event, ctx) => {
    cancel();
    clearTitleTimers();
    autoTitle = restoreAutoTitle(ctx.sessionManager.getEntries());
    warned = false;
    if (ctx.mode !== 'tui') return;
    titleTimers = startTitleDelaysMs.map((delay) => {
      const timer = setTimeout(() => showTitle(ctx), delay);
      timer.unref?.();
      return timer;
    });
  });

  // Pi rewrites its title on this event before extensions see it.
  pi.on('session_info_changed', (event, ctx) => {
    if (event.name !== autoTitle) cancel();
    showTitle(ctx);
  });

  pi.on('agent_start', (_event, ctx) => showTitle(ctx));

  pi.on('session_shutdown', () => {
    cancel();
    clearTitleTimers();
  });

  pi.on('input', (event, ctx) => {
    if (event.source !== 'interactive' || !ctx.hasUI || !event.text.trim()) return;
    const current = pi.getSessionName();
    if (current !== undefined && current !== autoTitle) return;
    const complete = completer(ctx);
    const model = titleModel(ctx.modelRegistry, ctx.model);
    if (!complete || !model) return;

    cancel();
    const controller = new AbortController();
    job = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    const prompt = userPrompt({ current, assistant: lastAssistantText(ctx.sessionManager.getBranch()), user: event.text });

    void (async () => {
      try {
        const reply = await complete(model, {
          systemPrompt,
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        }, { maxTokens: 1024, signal: controller.signal });
        if (timedOut) throw new Error(`no reply within ${requestTimeoutMs / 1000}s`);
        if (controller.signal.aborted) return;
        if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `the ${model.id} request failed`);
        const next = nextTitle(current, parseReply(replyText(reply)));
        if (next === undefined || pi.getSessionName() !== current) return;
        autoTitle = next;
        pi.setSessionName(next);
        pi.appendEntry(titleEntryType, { title: next });
      } catch (error) {
        if ((controller.signal.aborted && !timedOut) || warned) return;
        warned = true;
        ctx.ui.notify(`[title] could not name this session: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      } finally {
        clearTimeout(timeout);
        if (job === controller) job = undefined;
      }
    })();
  });
}
