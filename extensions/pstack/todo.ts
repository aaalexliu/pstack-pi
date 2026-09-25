import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const todoEntryType = 'pstack-todo';
export const todoStateVersion = 1 as const;
const itemOptions = { minLength: 1, maxLength: 4096, pattern: '\\S' };
const itemSchema = Type.String(itemOptions);
const itemsSchema = Type.Array(itemSchema, { maxItems: 128, description: 'Checklist items. Used by set.' });
const storedItemSchema = Type.String({ minLength: 1, maxLength: 4103, pattern: '\\S' });

// Anthropic copies properties and required only, so a root union drops every field.
export const todoParameters = Type.Object({
  action: Type.Union([
    Type.Literal('get'),
    Type.Literal('set'),
    Type.Literal('add'),
    Type.Literal('complete'),
  ]),
  items: Type.Optional(itemsSchema),
  item: Type.Optional(Type.String({ ...itemOptions, description: 'One checklist item. Used by add and complete.' })),
}, { additionalProperties: false });

const todoStateSchema = Type.Object({
  version: Type.Literal(todoStateVersion),
  items: Type.Array(storedItemSchema, { maxItems: 128 }),
}, { additionalProperties: false });

export type TodoAction =
  | { readonly action: 'get' }
  | { readonly action: 'set'; readonly items: readonly string[] }
  | { readonly action: 'add'; readonly item: string }
  | { readonly action: 'complete'; readonly item: string };

const examples = {
  get: '{"action":"get"}',
  set: '{"action":"set","items":["step one"]}',
  add: '{"action":"add","item":"another"}',
  complete: '{"action":"complete","item":"step one"}',
} as const;

function invalidTodo(field: string, example: string): never {
  throw new Error(`pstack_todo ${field} is invalid. Example: ${example}`);
}

// Pi checks the flat schema before execute. Only cross-field presence remains.
export function parseTodoAction(value: Static<typeof todoParameters>): TodoAction {
  switch (value.action) {
    case 'get':
      if (value.items !== undefined) invalidTodo('items', examples.get);
      if (value.item !== undefined) invalidTodo('item', examples.get);
      return { action: 'get' };
    case 'set':
      if (value.item !== undefined) invalidTodo('item', examples.set);
      if (value.items === undefined) invalidTodo('items', examples.set);
      return { action: 'set', items: value.items };
    case 'add':
    case 'complete': {
      const example = examples[value.action];
      if (value.items !== undefined) invalidTodo('items', example);
      if (value.item === undefined) invalidTodo('item', example);
      return { action: value.action, item: value.item };
    }
  }
}

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
