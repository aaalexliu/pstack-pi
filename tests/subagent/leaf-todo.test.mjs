import assert from 'node:assert/strict';
import test from 'node:test';
import leafTodo from '../../extensions/subagent/leaf-todo.ts';
import { todoParameters } from '../../extensions/pstack/todo.ts';

test('explicit leaf capability registers only a bounded checklist at depth one', async (t) => {
  const previous = process.env.PSTACK_SUBAGENT_DEPTH;
  t.after(() => { if (previous === undefined) delete process.env.PSTACK_SUBAGENT_DEPTH; else process.env.PSTACK_SUBAGENT_DEPTH = previous; });
  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof todoParameters>[]} */
  const tools = [];
  const pi = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), {
    get(_target, name) {
      assert.equal(name, 'registerTool');
      return (/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof todoParameters>} */ tool) => { tools.push(tool); };
    },
  });
  for (const depth of ['0', '2', 'invalid']) { process.env.PSTACK_SUBAGENT_DEPTH = depth; leafTodo(pi); }
  assert.equal(tools.length, 0);
  process.env.PSTACK_SUBAGENT_DEPTH = '1';
  leafTodo(pi);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'pstack_todo');
  const execute = tools[0].execute;
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({});
  await execute('set', { action: 'set', items: ['Read', 'Test'] }, undefined, undefined, ctx);
  const result = await execute('done', { action: 'complete', item: 'Read' }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { version: 1, items: ['[done] Read', 'Test'] });
  await assert.rejects(execute('large', { action: 'set', items: Array(33).fill('item') }, undefined, undefined, ctx));
  await assert.rejects(execute('wide', { action: 'add', item: 'x'.repeat(161) }, undefined, undefined, ctx));
  const unchanged = await execute('get', { action: 'get' }, undefined, undefined, ctx);
  assert.deepEqual(unchanged.details, result.details);
});
