import assert from 'node:assert/strict';
import test from 'node:test';
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

test('registered tool follows session branches and persists only mutations', async () => {
  /** @type {any[]} */
  let branch = [];
  /** @type {Map<string, any>} */
  const handlers = new Map();
  /** @type {any[]} */
  const appended = [];
  /** @type {any} */
  let tool;
  const pi = {
    on(/** @type {string} */ name, /** @type {any} */ handler) { handlers.set(name, handler); },
    registerTool(/** @type {any} */ value) { tool = value; },
    appendEntry(/** @type {string} */ customType, /** @type {unknown} */ data) {
      const entry = { type: 'custom', customType, data };
      appended.push(entry);
      branch.push(entry);
    },
  };
  pstack(/** @type {any} */ (pi));
  assert.deepEqual([...handlers.keys()], ['session_start', 'session_tree']);
  assert.equal(tool.name, 'pstack_todo');
  const ctx = { sessionManager: { getBranch: () => branch } };
  await handlers.get('session_start')({}, ctx);

  await tool.execute('set', { action: 'set', items: ['root'] });
  assert.equal(appended.length, 1);
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, '1. root');
  assert.equal(appended.length, 1);

  const rootBranch = [...branch];
  await tool.execute('add', { action: 'add', item: 'child' });
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, '1. root\n2. child');

  branch = rootBranch;
  await handlers.get('session_tree')({}, ctx);
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, '1. root');

  branch = [];
  await handlers.get('session_tree')({}, ctx);
  assert.equal((await tool.execute('get', { action: 'get' })).content[0].text, 'No pstack todo items.');
});
