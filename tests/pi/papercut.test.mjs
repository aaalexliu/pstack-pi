import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE_MODEL } from './provider.mjs';
import { runPiSmoke } from './runner.mjs';

/** @param {Record<string, unknown>} request @param {string} id */
function toolResult(request, id) {
  assert.ok(Array.isArray(request.messages));
  const result = request.messages.find((/** @type {any} */ message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result, `Missing tool result ${id}`);
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

test('packed real Pi leaves fast results bare, journals version 3 papercuts, drops duplicates, and resets the cap each turn', async () => {
  const expected = 'Papercut workflow finished.';
  const culprit = { type: 'pi-tool', name: 'bash' };
  const note = 'The shell error had no structured exit status.';
  /** @param {string} id */
  const distinct = (id) => ({ id, name: 'pstack_papercut', arguments: { note: `Distinct problem ${id}.`, culprit: { type: 'self' }, impact: 'extra-steps' } });
  await runPiSmoke({
    expectedText: expected,
    expectedRequests: 4,
    prompt: 'Run the shell commands, then record the friction.',
    fixture: { script: [
      { reply: { kind: 'tools', calls: [
        { id: 'echo', name: 'bash', arguments: { command: 'echo done' } },
        { id: 'fail', name: 'bash', arguments: { command: 'printf oops; exit 3' } },
      ] }, check: (request) => {
        assert.ok(Array.isArray(request.tools));
        const tool = request.tools.find((/** @type {any} */ tool) => tool.function.name === 'pstack_papercut');
        assert.ok(tool);
        assert.match(tool.function.description, /extra steps, blocked you, or gave a wrong result/u);
        assert.deepEqual(tool.function.parameters.required.sort(), ['culprit', 'impact', 'note']);
        assert.ok(Array.isArray(request.messages));
        const system = JSON.stringify(request.messages.filter((/** @type {any} */ message) => message.role === 'system'));
        for (const hint of ['even if you recover', 'Set culprit to the one thing', 'Before your final response', 'one note per distinct problem', 'Never include secrets or raw tool output']) {
          assert.ok(system.includes(hint), `Missing papercut hint: ${hint}`);
        }
        assert.ok(!system.includes('errors caused by the current task'));
      } },
      { reply: { kind: 'tools', calls: [
        { id: 'papercut', name: 'pstack_papercut', arguments: { note, culprit, impact: 'extra-steps' } },
        { id: 'repeat', name: 'pstack_papercut', arguments: { note: ` ${note}  `, culprit, impact: 'blocked' } },
        distinct('a'),
        distinct('b'),
      ] }, check: (request) => {
        assert.equal(toolResult(request, 'echo'), 'done\n', 'a fast call gets no trailer');
        assert.doesNotMatch(toolResult(request, 'fail'), /\[pstack/u);
      } },
      { reply: { kind: 'tools', calls: ['c', 'd', 'e', 'f'].map(distinct) }, check: (request) => {
        const result = toolResult(request, 'papercut');
        assert.match(result, /Recorded papercut \[pi-tool:bash\]/u);
        assert.doesNotMatch(result, /\[pstack:/u, 'The papercut tool does not trail its own result');
        assert.match(toolResult(request, 'repeat'), /Not recorded: this session already recorded the same papercut/u);
        for (const id of ['a', 'b']) assert.match(toolResult(request, id), /Recorded papercut \[self\]/u);
      } },
      { reply: { kind: 'text', text: expected }, check: (request) => {
        for (const id of ['c', 'd', 'e', 'f']) assert.match(toolResult(request, id), /Recorded papercut \[self\]/u, `turn_start resets the per-turn cap before ${id}`);
      } },
    ] },
    verify: async (run) => {
      const ends = run.events.filter((event) => event.type === 'tool_execution_end');
      assert.deepEqual(ends.map((event) => [event.toolName, event.isError]).sort(), [['bash', false], ['bash', true], ...Array(8).fill(['pstack_papercut', false])]);
      const directory = path.join(run.paths.profile, 'pstack-pi', 'papercuts');
      const [file, ...rest] = await readdir(directory);
      assert.deepEqual(rest, []);
      assert.match(file, /^[0-9a-f-]+\.\d+\.jsonl$/u);
      const records = (await readFile(path.join(directory, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => record.note).sort(), [note, ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => `Distinct problem ${id}.`)].sort());
      for (const record of records) {
        assert.equal(record.version, 3);
        assert.match(record.build, /^pstack-pi@/u);
        assert.equal(record.cwd, run.paths.cwd);
        assert.equal(record.host, hostname().replace(/\.local$/u, ''));
        assert.equal(record.model, `pi-fixture/${FIXTURE_MODEL}`);
      }
      const [record] = records.filter((entry) => entry.note === note);
      assert.deepEqual([record.callId, record.culprit, record.impact], ['papercut', culprit, 'extra-steps']);
    },
  });
});
