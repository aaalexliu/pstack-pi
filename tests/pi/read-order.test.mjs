import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

/** @param {Record<string, unknown>} request @param {string} id */
function toolResult(request, id) {
  assert.ok(Array.isArray(request.messages));
  const result = request.messages.find((/** @type {any} */ message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result, `Missing tool result ${id}`);
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

test('packed real Pi reads a file as the bash call before it in the same message left it', async () => {
  const expected = 'Read order finished.';
  await runPiSmoke({
    expectedText: expected,
    expectedRequests: 3,
    prompt: 'Write the files, then read them.',
    fixture: { script: [
      { reply: { kind: 'tools', calls: [
        { id: 'seed', name: 'bash', arguments: { command: 'printf old > over.txt' } },
      ] } },
      { reply: { kind: 'tools', calls: [
        { id: 'before', name: 'read', arguments: { path: 'over.txt' } },
        { id: 'write', name: 'bash', arguments: { command: 'sleep 1; printf new > over.txt; printf new > fresh.txt' } },
        { id: 'over', name: 'read', arguments: { path: 'over.txt' } },
        { id: 'fresh', name: 'read', arguments: { path: 'fresh.txt' } },
      ] } },
      { reply: { kind: 'text', text: expected }, check: (request) => {
        assert.equal(toolResult(request, 'before'), 'old', 'a read before the bash call does not wait for it');
        assert.equal(toolResult(request, 'over'), 'new', 'a read after the bash call sees the overwritten file');
        assert.equal(toolResult(request, 'fresh'), 'new', 'a read after the bash call sees the new file');
      } },
    ] },
  });
});
