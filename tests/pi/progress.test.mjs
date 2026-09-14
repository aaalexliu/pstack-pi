import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

test('packed real Pi reports checklist, active tool, model and usage before child finishes', async () => {
  const run = await runPiSmoke({
    expectedText: 'Live progress verified.', expectedRequests: 6,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'delegate', name: 'subagent', arguments: { agent: 'poteto-agent', task: 'Inspect then verify with a short wait.' } } },
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
  const updates = run.events.slice(0, end).filter((event) => event.type === 'tool_execution_update' && event.toolName === 'subagent');
  const snapshots = updates.map((event) => /** @type {{details: {progress: import('../../extensions/subagent/progress.ts').ProgressSnapshot}}} */ (event.partialResult).details.progress);
  const live = snapshots.find((snapshot) => snapshot.tasks[0].state === 'running' && snapshot.tasks[0].tools.some((tool) => tool.name === 'bash'));
  assert.ok(live, 'Need a live tool snapshot before result');
  assert.deepEqual(live.tasks[0].todos, ['Inspect', 'Verify']);
  assert.equal(live.tasks[0].observedModel, 'pi-fixture/pi-smoke-model');
  assert.ok(live.tasks[0].usage.direct.usage.input > 0);
  assert.equal(live.endedAt, null);
  const final = snapshots.at(-1);
  assert.ok(final?.endedAt);
  assert.equal(final.tasks[0].state, 'succeeded');
  assert.deepEqual(final.tasks[0].todos, ['[done] Inspect', 'Verify']);
  assert.equal(final.tasks[0].usage.direct.usage.input, 44);
  assert.equal(final.tasks[0].usage.direct.usage.output, 28);
  assert.ok(updates.every((event) => !('usage' in /** @type {object} */ (event.partialResult))), 'Progress must not charge usage');
  const result = /** @type {{content: {text: string}[], details: {progressCard: {version: number, lines: string[]}}}} */ (run.events[end].result);
  assert.equal(result.content[0].text, 'Checked the fixture.');
  assert.equal(result.details.progressCard.version, 1);
  assert.match(result.details.progressCard.lines.join('\n'), /pi-fixture\/pi-smoke-model/);
  assert.match(result.details.progressCard.lines.join('\n'), /last event.*before finish/);
  const saved = run.events.find((event) => event.type === 'message_end' && /** @type {{toolName?: string}} */ (event.message)?.toolName === 'subagent');
  assert.ok(saved);
  assert.deepEqual(/** @type {{details: unknown}} */ (saved.message).details, result.details);
});

test('a cancelled child retains its inline card in the real failed tool result', async () => {
  const run = await runPiSmoke({
    expectedText: 'Cancellation card verified.', expectedRequests: 3,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'cancel-demo', name: 'subagent', arguments: { agent: 'poteto-agent', task: 'Run the slow check.', limits: { timeoutMs: 2500 } } } },
      { reply: { kind: 'tool', id: 'slow', name: 'bash', arguments: { command: 'sleep 10' } } },
      { reply: { kind: 'text', text: 'Cancellation card verified.' } },
    ] },
  });
  const end = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
  assert.ok(end && end.isError === true);
  const result = /** @type {{details: {progressCard: {lines: string[]}}, usage: {input: number}}} */ (end.result);
  assert.match(result.details.progressCard.lines.join('\n'), /cancelled/);
  assert.match(result.details.progressCard.lines.join('\n'), /pi-fixture\/pi-smoke-model/);
  assert.equal(result.usage.input, 11);
});
