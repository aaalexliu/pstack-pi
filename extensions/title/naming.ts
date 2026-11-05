import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

export const titleEntryType = 'pstack-title';
export const maxTitleLength = 60;
const maxUserChars = 1500;
const maxAssistantChars = 800;

/** The small model to name with on each provider. Other providers use the session model. */
export const smallModels: Readonly<Record<string, string>> = { anthropic: 'claude-haiku-5-5' };

export const systemPrompt = `You name a terminal tab after the task a coding agent is working on.

Reply with one JSON object and nothing else: {"newTask": boolean, "title": string | null}

- newTask is true when the latest user message starts a different task from the current title. It is false when the message continues, answers, approves, or follows up on that task. With no current title, newTask is true.
- When newTask is true, title names the task in 2 to 5 words, in sentence case, starting with a verb ending in -ing, such as "Fixing login redirect" or "Committing current changes". Otherwise title is null.
- No quotes, emoji, or trailing period in the title.`;

type Registry = {
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
};

export function titleModel(registry: Registry, session: Model<Api> | undefined): Model<Api> | undefined {
  if (!session) return undefined;
  const id = smallModels[session.provider];
  const small = id === undefined ? undefined : registry.find(session.provider, id);
  return small && registry.hasConfiguredAuth(small) ? small : session;
}

export function userPrompt({ current, assistant, user }: { current: string | undefined; assistant: string | undefined; user: string }): string {
  const parts = [`Current title: ${current ?? 'none'}`];
  if (assistant) parts.push(`End of the previous assistant reply:\n${assistant.slice(-maxAssistantChars)}`);
  parts.push(`Latest user message:\n${user.slice(0, maxUserChars)}`);
  return parts.join('\n\n');
}

export function replyText(message: Pick<AssistantMessage, 'content'>): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

export function sanitizeTitle(raw: string): string | undefined {
  const title = raw
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^["'`]+|["'`.]+$/gu, '')
    .trim();
  if (!title) return undefined;
  return title.length <= maxTitleLength ? title : `${title.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

const replySchema = Type.Object({ newTask: Type.Boolean(), title: Type.Union([Type.String(), Type.Null()]) });
export type TitleReply = { newTask: boolean; title: string | undefined };

export function parseReply(text: string): TitleReply | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); }
  catch { return undefined; }
  if (!Check(replySchema, value)) return undefined;
  return { newTask: value.newTask, title: value.title === null ? undefined : sanitizeTitle(value.title) };
}

/** The name to apply, or undefined to keep the current one. */
export function nextTitle(current: string | undefined, reply: TitleReply | undefined): string | undefined {
  if (!reply?.title || reply.title === current) return undefined;
  return current === undefined || reply.newTask ? reply.title : undefined;
}

type Entry = { type: string; customType?: string; data?: unknown; message?: unknown };

/** The last name this extension applied in the session, so a resumed session keeps renaming. */
export function restoreAutoTitle(entries: readonly Entry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== 'custom' || entry.customType !== titleEntryType) continue;
    const data = entry.data as { title?: unknown } | undefined;
    if (typeof data?.title === 'string') return data.title;
  }
  return undefined;
}

export function lastAssistantText(entries: readonly Entry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index].message as { role?: unknown; content?: unknown } | undefined;
    if (entries[index].type !== 'message' || message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const text = replyText(message as Pick<AssistantMessage, 'content'>).trim();
    if (text) return text;
  }
  return undefined;
}
