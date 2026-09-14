import assert from 'node:assert/strict';
import test from 'node:test';
import { RunProgress, plain, progressLines, taskLine } from '../../extensions/subagent/progress.ts';
import { usageReport, zeroUsage } from '../../extensions/subagent/usage.ts';

function fixture() {
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot[]} */
  const snapshots = [];
  const run = new RunProgress([{ agent: 'general-purpose', task: 'Inspect the runner.' }], (snapshot) => snapshots.push(snapshot));
  run.started(0);
  const latest = () => { const value = snapshots.at(-1); assert.ok(value); return value; };
  return { run, snapshots, latest, row: () => latest().tasks[0] };
}
test('bounded public text, tools, checklist, observed model, and replacement usage', () => {
  const { run, snapshots, row, latest } = fixture();
  try {
    run.event(0, { type: 'message_start', message: { role: 'assistant', provider: 'fixture', model: 'test' } }, usageReport());
    run.event(0, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_THOUGHT' } }, usageReport());
    run.event(0, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '\x1b[31mPublic update' } }, usageReport());
    run.event(0, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'src/main.ts' } }, usageReport());
    run.event(0, { type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'SECRET_COMMAND' } }, usageReport());
    run.event(0, { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read' }, usageReport());
    run.event(0, { type: 'tool_execution_end', toolName: 'pstack_todo', result: { details: { version: 1, items: ['[done] Read', 'Test'] } } }, usageReport());
    const provisional = { ...zeroUsage(), input: 12, output: 4, totalTokens: 16 };
    run.event(0, { type: 'message_update' }, usageReport({ provisional }));
    run.event(0, { type: 'message_update' }, usageReport({ provisional: { ...provisional, input: 2, totalTokens: 6 } }));
    run.publish();
    assert.equal(row().observedModel, 'fixture/test');
    assert.equal(row().message, 'Public update');
    assert.deepEqual(row().tools, [{ id: 'b', name: 'bash' }]);
    assert.deepEqual(row().todos, ['[done] Read', 'Test']);
    assert.equal(row().usage.direct.usage.input, 2);
    assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE_THOUGHT|SECRET_COMMAND|\\u001b/);
    assert.match(progressLines(latest(), true).join('\n'), /todos 1\/2 \(self-reported\)/);
    assert.equal(plain('x'.repeat(10_000)).length, 180);
    assert.equal(plain('x\u202ey\n\x00z'), 'x y z');
  } finally { run.finish(); }
});
test('quiet and long-run warnings are advisory and do not claim a loop', () => {
  const { run, row } = fixture();
  try {
    const task = row();
    assert.ok(task.startedAt !== null);
    assert.match(taskLine(task, task.startedAt + 61_000), /QUIET/);
    assert.match(taskLine(task, task.startedAt + 601_000), /LONG RUN/);
    task.endedAt = task.startedAt + 1_000;
    task.state = 'succeeded';
    assert.doesNotMatch(taskLine(task, task.startedAt + 601_000), /QUIET|LONG RUN/);
  } finally { run.finish(); }
});
test('batch completion does not extend an earlier child duration', (t) => {
  const { run, row } = fixture();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const result = /** @type {import('../../extensions/subagent/domain.ts').TaskResult} */ ({
    kind: 'succeeded', usage: usageReport(), cleanup: { verified: true, durationMs: 0, forced: false, observedProcesses: 1 },
  });
  run.result(0, result);
  now = 65000;
  run.result(0, result);
  run.finish();
  assert.equal(row().endedAt, 1000);
});

test('throwing publisher cannot abort work and final state stays frozen in time', () => {
  const run = new RunProgress([{ agent: 'general-purpose', task: 'Inspect' }], () => { throw new Error('display failure'); });
  assert.doesNotThrow(() => { run.started(0); run.stopping(); run.finish('cancelled'); run.finish(); });
});
