import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Check } from 'typebox/value';
import pstack from '../../extensions/pstack/index.ts';
import {
  decodeTodoState,
  emptyTodoState,
  formatTodos,
  reduceTodos,
  restoreTodos,
  todoEntryType,
  todoParameters,
} from '../../extensions/pstack/todo.ts';

/** @param {unknown} data */
function custom(data) {
  return { type: 'custom', customType: todoEntryType, data };
}

test('todo reducer is immutable, versioned, bounded, and deterministic', () => {
  const first = reduceTodos(emptyTodoState, { action: 'add', item: 'Read the code' });
  const second = reduceTodos(first, { action: 'complete', item: 'Read the code' });
  assert.deepEqual(first, { version: 1, items: ['Read the code'] });
  assert.deepEqual(second, { version: 1, items: ['[done] Read the code'] });
  assert.equal(formatTodos(second), '1. [done] Read the code');
  assert.throws(() => first.items.push('mutate'));
  assert.equal(reduceTodos(first, { action: 'get' }), first);
  let full = emptyTodoState;
  for (let index = 0; index < 128; index++) full = reduceTodos(full, { action: 'add', item: String(index) });
  assert.throws(() => reduceTodos(full, { action: 'add', item: 'overflow' }), /full/);
});

test('strict actions reject shape drift before execution', () => {
  for (const valid of [
    { action: 'get' },
    { action: 'set', items: [] },
    { action: 'add', item: 'one' },
    { action: 'complete', item: 'one' },
  ]) assert.equal(Check(todoParameters, valid), true);
  for (const invalid of [
    {}, { action: 'get', item: 'x' }, { action: 'set' }, { action: 'set', items: [''] },
    { action: 'add' }, { action: 'add', item: ' ' }, { action: 'complete', items: [] },
    { action: 'clear' }, { action: 'get', extra: true },
  ]) assert.equal(Check(todoParameters, invalid), false);
});

test('restore uses only ordered current-branch snapshots and ignores malformed or future data', () => {
  const older = { version: 1, items: ['older'] };
  const newer = { version: 1, items: ['newer', '[done] complete'] };
  const entries = [
    { type: 'message', customType: todoEntryType, data: newer },
    custom(older), custom({ version: 2, items: ['future'] }), custom({ version: 1, items: [3] }), custom(newer),
  ];
  assert.deepEqual(restoreTodos(entries), newer);
  assert.deepEqual(restoreTodos(entries.slice(0, 4)), older);
  assert.equal(decodeTodoState({ version: 2, items: [] }), null);
  assert.equal(decodeTodoState({ version: 1, items: [], extra: true }), null);
});

test('config and session tools stay read-only, strict, project-scoped, and bounded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-support-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  /** @type {Map<string, any>} */
  const tools = new Map();
  pstack(/** @type {any} */ ({ on() {}, appendEntry() {}, registerCommand() {}, registerTool(/** @type {any} */ value) { tools.set(value.name, value); } }));
  const config = tools.get('pstack_config');
  const configured = await config.execute('config', { action: 'get' });
  assert.equal(configured.content[0].text, 'No pstack model roles configured.');
  assert.deepEqual(configured.details, { version: 1, roles: {} });
  const registry = { getAvailable: () => [
    { provider: 'fixture', id: 'second' },
    { provider: 'fixture', id: 'first' },
    { provider: 'fixture', id: 'second' },
  ] };
  const models = await config.execute('models', { action: 'list-models' }, undefined, undefined, { modelRegistry: registry });
  assert.deepEqual(models.details.models, ['fixture/first', 'fixture/second', 'inherit-parent']);
  assert.equal(models.content[0].text, 'fixture/first\nfixture/second\ninherit-parent');

  const empty = await tools.get('pstack_sessions').execute('empty', { action: 'list' }, undefined, undefined, { cwd: join(root, 'absent') });
  assert.deepEqual(empty.details, { files: [], truncated: false });
  assert.equal(existsSync(join(root, 'sessions')), false);

  const cwd = join(root, 'project');
  const sessionDir = SessionManager.create(cwd).getSessionDir();
  await mkdir(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString();
  await Promise.all(Array.from({ length: 101 }, (_, index) => {
    const file = join(sessionDir, `${String(index).padStart(3, '0')}.jsonl`);
    return writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id: `id-${index}`, timestamp, cwd })}\n`);
  }));
  await writeFile(join(sessionDir, '999.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'wrong-project', timestamp, cwd: join(root, 'other') })}\n`);
  const link = join(sessionDir, 'evil.jsonl');
  await symlink(join(sessionDir, '000.jsonl'), link);
  await assert.rejects(tools.get('pstack_sessions').execute('unsafe', { action: 'list' }, undefined, undefined, { cwd }), /Unsafe Pi session file/);
  await unlink(link);
  const sessions = await tools.get('pstack_sessions').execute('sessions', { action: 'list' }, undefined, undefined, { cwd });
  assert.equal(sessions.details.files.length, 100);
  assert.equal(sessions.details.truncated, true);
  assert.ok(sessions.details.files.every((/** @type {string} */ file) => file.startsWith(`${sessionDir}/`) && !file.endsWith('/999.jsonl')));
});

test('registered tool follows session branches and persists only mutations', async () => {
  /** @type {any[]} */
  let branch = [];
  /** @type {Map<string, any>} */
  const handlers = new Map();
  /** @type {any[]} */
  const appended = [];
  /** @type {Map<string, any>} */
  const tools = new Map();
  const pi = {
    registerCommand() {},
    on(/** @type {string} */ name, /** @type {any} */ handler) { handlers.set(name, handler); },
    registerTool(/** @type {any} */ value) { tools.set(value.name, value); },
    appendEntry(/** @type {string} */ customType, /** @type {unknown} */ data) {
      const entry = { type: 'custom', customType, data };
      appended.push(entry);
      branch.push(entry);
    },
  };
  pstack(/** @type {any} */ (pi));
  assert.deepEqual([...handlers.keys()], ['session_start', 'session_tree', 'input', 'before_agent_start']);
  assert.deepEqual([...tools.keys()], ['pstack_config', 'pstack_sessions', 'pstack_todo']);
  assert.equal(Check(tools.get('pstack_config').parameters, { action: 'get' }), true);
  assert.equal(Check(tools.get('pstack_config').parameters, { action: 'list-models' }), true);
  assert.equal(Check(tools.get('pstack_config').parameters, { action: 'get', extra: true }), false);
  assert.equal(Check(tools.get('pstack_sessions').parameters, { action: 'list' }), true);
  assert.equal(Check(tools.get('pstack_sessions').parameters, { action: 'list', cwd: '/tmp' }), false);
  const tool = tools.get('pstack_todo');
  const ctx = { sessionManager: { getBranch: () => branch } };
  await handlers.get('session_start')({}, ctx);
  assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'base' }, ctx), undefined);
  assert.deepEqual(await handlers.get('input')({ text: '/skill:other' }, ctx), { action: 'continue' });
  assert.deepEqual(await handlers.get('input')({ text: '/skill:poteto-mode task' }, ctx), { action: 'continue' });
  assert.match((await handlers.get('before_agent_start')({ systemPrompt: 'base' }, ctx)).systemPrompt, /skills\/poteto-mode\/SKILL\.md/);

  await tool.execute('set', { action: 'set', items: ['root'] });
  assert.equal(appended.length, 2);
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, '1. root');
  assert.equal(appended.length, 2);

  const rootBranch = [...branch];
  await tool.execute('add', { action: 'add', item: 'child' });
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, '1. root\n2. child');

  branch = rootBranch;
  await handlers.get('session_tree')({}, ctx);
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, '1. root');

  branch = [];
  await handlers.get('session_tree')({}, ctx);
  assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'base' }, ctx), undefined);
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, 'No pstack todo items.');
});
