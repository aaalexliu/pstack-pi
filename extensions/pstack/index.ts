import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { roles, loadModelConfig, modelConfigPath, formatModelChoice } from '../subagent/model-config.ts';
import { disabledModeState, enabledModeState, invokesPotetoMode, modeEntryType, restoreMode, type ModeState } from './mode.ts';
import { formatTodos, reduceTodos, restoreTodos, todoEntryType, todoParameters, emptyTodoState, type TodoState } from './todo.ts';

const potetoSkill = fileURLToPath(new URL('../../skills/poteto-mode/SKILL.md', import.meta.url));

function sessionDirectory(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
  return join(resolve(getAgentDir()), 'sessions', safePath);
}

function assertSafeSessionDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Pi session directory');
  if (readdirSync(directory, { withFileTypes: true }).some((entry) => entry.name.endsWith('.jsonl') && !entry.isFile())) {
    throw new Error('Unsafe Pi session file');
  }
}

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

  pi.registerCommand('pstack', {
    description: 'Show pstack model config and the file to edit',
    async handler(_args, ctx) {
      const agentDir = getAgentDir();
      const path = modelConfigPath(agentDir);
      try {
        const config = await loadModelConfig(agentDir);
        const assignments = Object.fromEntries(roles.flatMap((role) => {
          const assignment = config.get(role);
          if (!assignment) return [];
          return [[role, assignment.kind === 'single' ? formatModelChoice(assignment.choice) : assignment.choices.map(formatModelChoice)]];
        }));
        ctx.ui.notify(`Edit: ${path}\n\n${JSON.stringify({ version: 1, roles: assignments }, null, 2)}\n\nUnconfigured roles use the agent default, then the parent model.\nChanges apply to new subagent requests.`, 'info');
      } catch (error) {
        ctx.ui.notify(`Edit: ${path}\n\nCannot read pstack config: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  pi.registerTool({
    name: 'pstack_config',
    label: 'Pstack Config',
    description: 'Read pstack model roles or list exact Pi model selectors. The setup-pstack skill writes the reviewed config.',
    parameters: Type.Union([
      Type.Object({ action: Type.Literal('get') }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal('list-models') }, { additionalProperties: false }),
    ]),
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      if (request.action === 'list-models') {
        const models = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
        const selectors = ['inherit-parent', ...new Set(models)].sort();
        return { content: [{ type: 'text', text: selectors.join('\n') }], details: { models: selectors } };
      }
      const config = await loadModelConfig(getAgentDir());
      const assignments = Object.fromEntries(roles.flatMap((role) => {
        const assignment = config.get(role);
        if (!assignment) return [];
        return [[role, assignment.kind === 'single' ? formatModelChoice(assignment.choice) : assignment.choices.map(formatModelChoice)]];
      }));
      const text = Object.keys(assignments).length ? JSON.stringify({ version: 1, roles: assignments }, null, 2) : 'No pstack model roles configured.';
      return { content: [{ type: 'text', text }], details: { version: 1, roles: assignments } };
    },
  });

  pi.registerTool({
    name: 'pstack_sessions',
    label: 'Pstack Sessions',
    description: 'List saved Pi sessions for the current working directory without scanning other projects.',
    parameters: Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
    async execute(_toolCallId, _request, _signal, _onUpdate, ctx) {
      const directory = sessionDirectory(ctx.cwd);
      const present = existsSync(directory);
      if (present) assertSafeSessionDirectory(directory);
      const resolvedCwd = resolve(ctx.cwd);
      const listed = present
        ? (await SessionManager.list(ctx.cwd, directory)).filter((session) => session.cwd !== '' && resolve(session.cwd) === resolvedCwd)
        : [];
      const files = listed.slice(0, 100).map((session) => session.path);
      return {
        content: [{ type: 'text', text: files.length ? files.join('\n') : 'No saved sessions for this working directory.' }],
        details: { files, truncated: listed.length > 100 },
      };
    },
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
