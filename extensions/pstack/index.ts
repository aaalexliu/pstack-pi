import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { disabledModeState, enabledModeState, invokesPotetoMode, modeEntryType, restoreMode, type ModeState } from './mode.ts';
import { formatTodos, reduceTodos, restoreTodos, todoEntryType, todoParameters, emptyTodoState, type TodoState } from './todo.ts';

const potetoSkill = fileURLToPath(new URL('../../skills/poteto-mode/SKILL.md', import.meta.url));

export default function pstack(pi: ExtensionAPI): void {
  let mode: ModeState = disabledModeState;
  let todos: TodoState = emptyTodoState;

  const restore = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    mode = restoreMode(branch);
    todos = restoreTodos(branch);
  };

  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('input', (event) => {
    if (!invokesPotetoMode(event.text)) return { action: 'continue' } as const;
    mode = enabledModeState;
    pi.appendEntry(modeEntryType, mode);
    return { action: 'continue' } as const;
  });
  pi.on('before_agent_start', (event) => {
    if (!mode.enabled) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPstack Poteto Mode is active for this session branch. Use pstack_todo for non-trivial work, read the matching playbook, delegate bounded work when it helps, review every change, and verify real behavior. Read ${potetoSkill} before applying the mode.`,
    };
  });

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
