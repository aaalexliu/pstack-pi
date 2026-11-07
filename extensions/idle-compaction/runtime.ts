import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { AgentSettledEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/**
 * The only file that knows Pi 1.x APIs exist. The repo typechecks against Pi 0.85.1, which has no
 * `context_with_system`, `Model.promptCache`, `pi.getSettings`, `ModelRegistry.streamSimple`, or
 * `AgentSettledEvent.aborted`. On 0.85.1 each reader returns undefined and nothing arms.
 */

export type ReplayMessage = { readonly role: string };

export type ReplayOptions = { readonly thinkingLevel: string | undefined; readonly sessionId: string; readonly signal: AbortSignal };

export type Replay = (model: Model<Api>, messages: readonly ReplayMessage[], options: ReplayOptions) => Promise<AssistantMessage>;

type StreamSimple = (model: Model<Api>, context: { messages: readonly ReplayMessage[] }, options: { reasoning?: string; sessionId: string; signal: AbortSignal }) => { result(): Promise<AssistantMessage> };

/**
 * Sends the options Pi's agent loop sends and nothing else. `maxTokens`, `toolChoice`, `tools`,
 * `systemPrompt`, or `cacheRetention` would each change the request the provider keys its cache on.
 */
export function replayer(ctx: ExtensionContext): Replay | undefined {
  const registry = ctx.modelRegistry as unknown as { streamSimple?: StreamSimple };
  const streamSimple = registry.streamSimple;
  if (typeof streamSimple !== 'function') return undefined;
  return (model, messages, { thinkingLevel, sessionId, signal }) => streamSimple
    .call(registry, model, { messages }, { reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel, sessionId, signal })
    .result();
}

type RequestHandler = (event: { messages: readonly ReplayMessage[] }, ctx: ExtensionContext) => void;

export function onRequest(pi: ExtensionAPI, handler: (messages: readonly ReplayMessage[], ctx: ExtensionContext) => void): void {
  (pi.on as unknown as (event: 'context_with_system', handler: RequestHandler) => void)
    .call(pi, 'context_with_system', (event, ctx) => handler(event.messages, ctx));
}

export function autoCompactionEnabled(pi: ExtensionAPI): boolean | undefined {
  const getSettings = (pi as unknown as { getSettings?: () => { compaction?: { enabled?: unknown } } }).getSettings;
  return typeof getSettings === 'function' ? getSettings.call(pi).compaction?.enabled !== false : undefined;
}

export function longCacheTtlMs(model: Model<Api>): number | undefined {
  const seconds = (model as unknown as { promptCache?: { long?: unknown } }).promptCache?.long;
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : undefined;
}

export function settledAborted(event: AgentSettledEvent): boolean {
  return (event as unknown as { aborted?: unknown }).aborted === true;
}

/** Pi reads `PI_CACHE_RETENTION` from the process env unless a provider overrides it in auth config. */
export function longRetention(env: NodeJS.ProcessEnv): boolean {
  return env.PI_CACHE_RETENTION === 'long';
}

/**
 * Like Claude Code's `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`. Below Pi's `keepRecentTokens`, Pi's
 * `compact()` throws "Nothing to compact" after the summary is already paid for.
 */
const minTokensFloor = 100_000;

export function minTokensOverride(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.PSTACK_IDLE_COMPACT_MIN_TOKENS?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.max(value, minTokensFloor) : undefined;
}
