import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

/** @param {Record<string, unknown>} request @param {string} id */
function toolResult(request, id) {
  assert.ok(Array.isArray(request.messages));
  const result = request.messages.find((/** @type {any} */ message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result, `Missing tool result ${id}`);
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

test('packed real Pi trails every tool result and journals agent-supplied papercut evidence', async () => {
  const expected = 'Papercut workflow finished.';
  const evidence = { tool: 'bash', durationMs: 7, outputBytes: 5, isError: true };
  await runPiSmoke({
    expectedText: expected,
    expectedRequests: 3,
    prompt: 'Run the shell commands, then record the friction.',
    fixture: { script: [
      { reply: { kind: 'tools', calls: [
        { id: 'echo', name: 'bash', arguments: { command: 'echo done' } },
        { id: 'fail', name: 'bash', arguments: { command: 'printf oops; exit 3' } },
      ] }, check: (request) => {
        assert.ok(Array.isArray(request.tools));
        assert.ok(request.tools.map((/** @type {any} */ tool) => tool.function.name).includes('pstack_papercut'));
      } },
      { reply: { kind: 'tool', id: 'papercut', name: 'pstack_papercut', arguments: { kind: 'tool.confusing-error', note: 'The shell error had no structured exit status.', evidence } }, check: (request) => {
        assert.match(toolResult(request, 'echo'), /^done\n\n\[pstack: bash \d+ms 5B\]$/u);
        assert.match(toolResult(request, 'fail'), /\[pstack: bash \d+ms \d+B failed\]/u);
        assert.doesNotMatch(toolResult(request, 'fail'), /failed\].*\[pstack/u);
      } },
      { reply: { kind: 'text', text: expected }, check: (request) => {
        const result = toolResult(request, 'papercut');
        assert.match(result, /Recorded papercut \[tool\.confusing-error\]/u);
        assert.doesNotMatch(result, /\[pstack:/u, 'The papercut tool does not trail its own result');
      } },
    ] },
    verify: async (run) => {
      const ends = run.events.filter((event) => event.type === 'tool_execution_end');
      assert.deepEqual(ends.map((event) => [event.toolName, event.isError]).sort(), [['bash', false], ['bash', true], ['pstack_papercut', false]]);
      const directory = path.join(run.paths.profile, 'pstack-pi', 'papercuts');
      const [file, ...rest] = await readdir(directory);
      assert.deepEqual(rest, []);
      assert.match(file, /^[0-9a-f-]+\.\d+\.jsonl$/u);
      const lines = (await readFile(path.join(directory, file), 'utf8')).trim().split('\n');
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.equal(record.version, 1);
      assert.equal(record.cwd, run.paths.cwd);
      assert.equal(record.kind, 'tool.confusing-error');
      assert.equal(record.note, 'The shell error had no structured exit status.');
      assert.deepEqual(record.evidence, evidence);
    },
  });
});
