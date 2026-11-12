import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';

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

export function replyText(message: Pick<AssistantMessage, 'content'>): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Removes terminal escape sequences and turns control characters into spaces. */
export function stripControls(text: string): string {
  return text
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}
