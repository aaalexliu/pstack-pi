import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const todoEntryType = 'pstack-todo';
export const todoStateVersion = 1 as const;
const itemSchema = Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' });
const storedItemSchema = Type.String({ minLength: 1, maxLength: 4103, pattern: '\\S' });

export const todoParameters = Type.Union([
  Type.Object({ action: Type.Literal('get') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('set'), items: Type.Array(itemSchema, { maxItems: 128 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('add'), item: itemSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('complete'), item: itemSchema }, { additionalProperties: false }),
], { type: 'object' });

const todoStateSchema = Type.Object({
  version: Type.Literal(todoStateVersion),
  items: Type.Array(storedItemSchema, { maxItems: 128 }),
}, { additionalProperties: false });

export type TodoAction = Static<typeof todoParameters>;
export type TodoState = Readonly<{ version: typeof todoStateVersion; items: readonly string[] }>;
export type SessionEntry = Readonly<{ type: string; customType?: string; data?: unknown }>;

export const emptyTodoState: TodoState = Object.freeze({ version: todoStateVersion, items: Object.freeze([]) });

function state(items: readonly string[]): TodoState {
  return Object.freeze({ version: todoStateVersion, items: Object.freeze([...items]) });
}

export function decodeTodoState(value: unknown): TodoState | null {
  if (!Check(todoStateSchema, value)) return null;
  return state(value.items);
}

export function restoreTodos(entries: readonly SessionEntry[]): TodoState {
  let restored = emptyTodoState;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== todoEntryType) continue;
    const candidate = decodeTodoState(entry.data);
    if (candidate) restored = candidate;
  }
  return restored;
}

export function reduceTodos(current: TodoState, action: TodoAction): TodoState {
  switch (action.action) {
    case 'get': return current;
    case 'set': return state(action.items);
    case 'add': {
      if (current.items.length >= 128) throw new Error('Pstack todo list is full');
      return state([...current.items, action.item]);
    }
    case 'complete': return state(current.items.map((item) => item === action.item && !item.startsWith('[done] ') ? `[done] ${item}` : item));
  }
}

export function formatTodos(current: TodoState): string {
  return current.items.length
    ? current.items.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : 'No pstack todo items.';
}
