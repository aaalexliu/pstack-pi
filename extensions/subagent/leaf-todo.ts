import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { emptyTodoState, formatTodos, reduceTodos, todoParameters } from '../pstack/todo.ts';

// Explicit CLI-only leaf capability: no resource discovery, persistence, or delegation.
export default function leafTodo(pi: ExtensionAPI) {
  if (process.env.PSTACK_SUBAGENT_DEPTH !== '1') return;
  let state = emptyTodoState;
  pi.registerTool({
    name: 'pstack_todo', label: 'Leaf checklist',
    description: 'Report your checklist to the parent. get, set(items), add(item), complete(exact item). At most 32 items, each at most 160 UTF-8 bytes before the [done] prefix. Checklist completion is self-reported, not task completion.',
    promptSnippet: 'Report a short checklist to the parent.',
    promptGuidelines: ['Use pstack_todo for work with several steps. Mark items complete as you finish them.'],
    parameters: todoParameters,
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const next = reduceTodos(state, params);
      if (next.items.length > 32 || next.items.some((item) => Buffer.byteLength(item.replace(/^\[done\] /u, '')) > 160)) throw new Error('Leaf checklist exceeds 32 items or 160 bytes per item');
      state = next;
      return { content: [{ type: 'text', text: formatTodos(state) }], details: state };
    },
  });
}
