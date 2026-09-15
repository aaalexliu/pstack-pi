import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

/** @param {Record<string, unknown>} request @param {string} id */
function toolResult(request, id) {
  assert.ok(Array.isArray(request.messages));
  const result = request.messages.find((/** @type {any} */ message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result, `Missing tool result ${id}`);
  return JSON.stringify(result.content);
}

test('packed real Pi persists and updates pstack todos', async () => {
  const expected = 'Todo workflow finished.';
  await runPiSmoke({
    expectedText: expected,
    expectedRequests: 5,
    prompt: 'Track and finish the requested checklist.',
    fixture: { script: [
      { reply: { kind: 'tool', id: 'set', name: 'pstack_todo', arguments: { action: 'set', items: ['first'] } }, check: (request) => {
        assert.ok(Array.isArray(request.tools));
        const tools = request.tools.map((/** @type {any} */ tool) => tool.function.name);
        assert.ok(tools.includes('pstack_todo'));
        for (const name of ['pstack_todo', 'pstack_config']) {
          /** @type {any} */
          const tool = request.tools.find((/** @type {any} */ candidate) => candidate.function.name === name);
          assert.ok(tool, `Missing tool ${name}`);
          assert.equal(tool.function.parameters.type, 'object');
          assert.deepEqual(tool.function.parameters.anyOf.map((/** @type {any} */ branch) => branch.properties.action.const),
            name === 'pstack_todo' ? ['get', 'set', 'add', 'complete'] : ['get', 'list-models']);
        }
      } },
      { reply: { kind: 'tool', id: 'add', name: 'pstack_todo', arguments: { action: 'add', item: 'second' } }, check: (request) => {
        assert.match(toolResult(request, 'set'), /1\. first/);
      } },
      { reply: { kind: 'tool', id: 'complete', name: 'pstack_todo', arguments: { action: 'complete', item: 'first' } }, check: (request) => {
        assert.match(toolResult(request, 'add'), /2\. second/);
      } },
      { reply: { kind: 'tool', id: 'get', name: 'pstack_todo', arguments: { action: 'get' } }, check: (request) => {
        assert.match(toolResult(request, 'complete'), /\[done\] first/);
      } },
      { reply: { kind: 'text', text: expected }, check: (request) => {
        const result = toolResult(request, 'get');
        assert.match(result, /1\. \[done\] first/);
        assert.match(result, /2\. second/);
      } },
    ] },
    verify: async (run) => {
      const results = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'pstack_todo');
      assert.equal(results.length, 4);
      assert.ok(results.every((event) => event.isError === false));
      const result = /** @type {any} */ (results.at(-1)?.result);
      assert.deepEqual(result.details, { version: 1, items: ['[done] first', 'second'] });
    },
  });
});
