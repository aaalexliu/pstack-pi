import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** The small model to use on each provider. Other providers use the session model. */
export const smallModels: Readonly<Record<string, string>> = { anthropic: 'claude-haiku-5-5' };

type Registry = {
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
};

export function smallModel(registry: Registry, session: Model<Api> | undefined): Model<Api> | undefined {
  if (!session) return undefined;
  const id = smallModels[session.provider];
  const small = id === undefined ? undefined : registry.find(session.provider, id);
  return small && registry.hasConfiguredAuth(small) ? small : session;
}

export type Complete = (model: Model<Api>, context: Context, options: { maxTokens: number; signal: AbortSignal }) => Promise<AssistantMessage>;

/** `ModelRegistry.complete` arrived after Pi 0.85.1. Without it, callers skip their model request. */
export function completer(ctx: ExtensionContext): Complete | undefined {
  const complete = (ctx.modelRegistry as unknown as { complete?: Complete }).complete;
  return typeof complete === 'function' ? complete.bind(ctx.modelRegistry) : undefined;
}

export function replyText(message: Pick<AssistantMessage, 'content'>): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Removes terminal escape sequences and turns control characters into spaces. */
export function stripControls(text: string): string {
  return text
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}
