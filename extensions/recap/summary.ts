import { stripControls } from '../shared/model.ts';

export const recapEntryType = 'pstack-recap';
export const maxRecapLength = 400;
const maxTranscriptChars = 12_000;
const maxTextChars = 2_000;
const maxToolChars = 200;

export const systemPrompt = `You write the recap a developer reads when they come back to a coding-agent session after a break.

Write one or two sentences, under 40 words, as plain text: the goal of the latest task and where it stands, including anything that failed or waits on the developer. If work remains, end with one sentence that starts with "Next," and names the next step.

Example: The goal was a Claude Code config cleanup, and its commits are done: dotfiles is pushed to main and the CLAUDE.md trim PR is merged. Next, run a Home Manager rebuild so auto mode becomes your default.

Rules:
- Write about the task, not the session, the user, or the assistant.
- State only what happened. Never say that nothing failed, that nothing waits, or that there is no next step.
- The transcript shows each tool call as "[tool <name>] <input>" and leaves out tool output unless the tool failed, so trust what the assistant reports about results.
- Use short, plain words. No Markdown, lists, quotes, or "Recap:" label.`;

type Entry = { type: string; customType?: string; message?: unknown };
type Block = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
type Message = { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown };

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function texts(content: unknown): string {
  return blocks(content).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n').trim();
}

function toolInput(args: unknown): string {
  if (args && typeof args === 'object' && 'command' in args && typeof args.command === 'string') return args.command;
  return JSON.stringify(args ?? {});
}

function lines(message: Message): string[] {
  if (message.role === 'user') {
    const text = texts(message.content);
    return text ? [`User: ${clip(text, maxTextChars)}`] : [];
  }
  if (message.role === 'assistant') {
    const out: string[] = [];
    const text = texts(message.content);
    if (text) out.push(`Assistant: ${clip(text, maxTextChars)}`);
    for (const block of blocks(message.content)) {
      if (block.type === 'toolCall' && typeof block.name === 'string') out.push(`[tool ${block.name}] ${clip(toolInput(block.arguments), maxToolChars)}`);
    }
    return out;
  }
  if (message.role === 'toolResult' && message.isError === true && typeof message.toolName === 'string') {
    return [`[tool ${message.toolName} failed] ${clip(texts(message.content), maxToolChars)}`];
  }
  return [];
}

const isConversation = (entry: Entry) => {
  const role = (entry.message as Message | undefined)?.role;
  return entry.type === 'message' && (role === 'user' || role === 'assistant');
};

/** True when the branch has conversation newer than its last recap. */
export function needsRecap(branch: readonly Entry[]): boolean {
  let index = branch.length - 1;
  for (; index >= 0; index--) {
    if (isConversation(branch[index])) return true;
    if (branch[index].type === 'custom' && branch[index].customType === recapEntryType) return false;
  }
  return false;
}

/** The newest part of the conversation, as plain text for the recap model. */
export function transcript(branch: readonly Entry[], sessionName: string | undefined): string {
  const body = branch.flatMap((entry) => (entry.type === 'message' && entry.message ? lines(entry.message as Message) : [])).join('\n\n');
  if (!body) return '';
  const start = body.length - maxTranscriptChars;
  const recent = start <= 0 ? body : body.slice(body.indexOf('\n', start) + 1 || start);
  return [sessionName ? `Session title: ${sessionName}` : undefined, recent].filter(Boolean).join('\n\n');
}

export function cleanRecap(raw: string): string | undefined {
  const text = stripControls(raw)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(?:\*\*)?recap:?(?:\*\*)?\s*/iu, '')
    .replace(/^["']|["']$/gu, '')
    .trim();
  if (!text) return undefined;
  return text.length <= maxRecapLength ? text : `${text.slice(0, maxRecapLength - 1).trimEnd()}…`;
}
