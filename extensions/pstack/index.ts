import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatTodos, reduceTodos, restoreTodos, todoEntryType, todoParameters, emptyTodoState, type TodoState } from './todo.ts';

export default function pstack(pi: ExtensionAPI): void {
  let todos: TodoState = emptyTodoState;

  const restore = (ctx: ExtensionContext): void => {
    todos = restoreTodos(ctx.sessionManager.getBranch());
  };

  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: 'pstack_todo',
    label: 'Pstack Todo',
    description: "Maintain pstack's current task checklist. State follows the active session branch. Use at the start of non-trivial multi-step work, then update it as work advances.",
    parameters: todoParameters,
    async execute(_toolCallId, action) {
      const next = reduceTodos(todos, action);
      if (action.action !== 'get') pi.appendEntry(todoEntryType, next);
      todos = next;
      return {
        content: [{ type: 'text', text: formatTodos(todos) }],
        details: { version: todos.version, items: [...todos.items] },
      };
    },
  });
}
