import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

/** @typedef {import('../../extensions/subagent/index.ts').SubagentDetails} Details */

test('packed Pi streams live metadata and saves the finished inline card with unchanged output', async () => {
  const run = await runPiSmoke({
    expectedText: 'Live progress verified.', expectedRequests: 6,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'delegate', name: 'subagent', arguments: { agent: 'poteto-agent', role: 'review', task: 'Inspect then verify with a short wait.' } } },
      { reply: { kind: 'tool', id: 'plan', name: 'pstack_todo', arguments: { action: 'set', items: ['Inspect', 'Verify'] } }, check: (request) => {
        assert.ok(Array.isArray(request.tools));
        assert.ok(request.tools.some((tool) => tool.function.name === 'pstack_todo'));
        assert.ok(!request.tools.some((tool) => tool.function.name === 'subagent'));
      } },
      { reply: { kind: 'tool', id: 'wait', name: 'bash', arguments: { command: 'sleep 2' } } },
      { reply: { kind: 'tool', id: 'done', name: 'pstack_todo', arguments: { action: 'complete', item: 'Inspect' } } },
      { reply: { kind: 'text', text: 'Checked the fixture.' } },
      { reply: { kind: 'text', text: 'Live progress verified.' } },
    ] },
  });
  const end = run.events.findIndex((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
  assert.ok(end > 0);
  const updates = run.events.slice(0, end).filter((event) => event.type === 'tool_execution_update' && event.toolName === 'subagent');
  const snapshots = updates.map((event) => /** @type {{details: Details}} */ (event.partialResult).details.progress).filter((snapshot) => snapshot !== undefined);
  const live = snapshots.find((snapshot) => snapshot.tasks[0].state === 'running' && snapshot.tasks[0].tools.some((tool) => tool.name === 'bash'));
  assert.ok(live, 'Need a live tool snapshot before completion');
  assert.equal(live.tasks[0].role, 'review');
  assert.deepEqual(live.tasks[0].todos, ['Inspect', 'Verify']);
  assert.equal(live.tasks[0].observedModel, 'pi-fixture/pi-smoke-model');
  assert.ok(live.tasks[0].usage.input > 0);
  assert.equal(live.endedAt, null);
  const result = /** @type {{content: {text: string}[], details: Details}} */ (run.events[end].result);
  assert.equal(result.content[0].text, 'Checked the fixture.');
  const final = result.details.progress;
  assert.ok(final?.endedAt);
  assert.equal(final.tasks[0].state, 'succeeded');
  assert.deepEqual(final.tasks[0].todos, ['[done] Inspect', 'Verify']);
  assert.deepEqual(final.tasks[0].usage, result.details.results[0].usage);
  assert.equal(final.tasks[0].usage.input, 44);
  assert.equal(final.tasks[0].usage.output, 28);
  const saved = run.events.find((event) => event.type === 'message_end' && /** @type {{toolName?: string}} */ (event.message)?.toolName === 'subagent');
  assert.ok(saved);
  assert.deepEqual(/** @type {{details: unknown}} */ (saved.message).details, result.details);
});

test('a timed-out real child keeps terminal metadata and reported usage in its failed tool result', async () => {
  const run = await runPiSmoke({
    expectedText: 'Timeout card verified.', expectedRequests: 3,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'timeout', name: 'subagent', arguments: { agent: 'poteto-agent', task: 'Run the slow check.', timeoutMs: 3500 } } },
      { reply: { kind: 'tool', id: 'slow', name: 'bash', arguments: { command: 'sleep 10' } } },
      { reply: { kind: 'text', text: 'Timeout card verified.' } },
    ] },
  });
  const end = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
  assert.ok(end && end.isError === true);
  const result = /** @type {{content: {text: string}[], details: Details}} */ (end.result);
  assert.match(result.content[0].text, /Timed out after 3500 ms/);
  const progress = result.details.progress;
  assert.ok(progress?.endedAt);
  assert.equal(progress.tasks[0].state, 'aborted');
  assert.equal(progress.tasks[0].observedModel, 'pi-fixture/pi-smoke-model');
  assert.equal(progress.tasks[0].usage.input, 11);
});
