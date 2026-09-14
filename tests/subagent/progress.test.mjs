import assert from 'node:assert/strict';
import test from 'node:test';
import { RunProgress, plain, progressLines, taskLine } from '../../extensions/subagent/progress.ts';
import { Sidebar } from '../../extensions/subagent/view.ts';

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
function deferred() {
  let resolve = (/** @type {unknown} */ _value) => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(count = 1) {
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot[]} */
  const snapshots = [];
  const run = new RunProgress(Array.from({ length: count }, () => ({ agent: 'general-purpose', task: 'Inspect the runner.' })), (snapshot) => snapshots.push(snapshot));
  const latest = () => { const value = snapshots.at(-1); assert.ok(value); return value; };
  return { run, snapshots, latest, row: () => latest().tasks[0] };
}

test('queued rows and public events copy runner usage, never event usage or private content', () => {
  const { run, row, snapshots, latest } = fixture();
  try {
    assert.equal(row().state, 'queued');
    assert.equal(row().startedAt, null);
    run.started(0);
    run.event(0, { type: 'message_start', message: { role: 'assistant', provider: 'fixture', model: 'test' } }, zero());
    run.event(0, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_THOUGHT' } }, zero());
    run.event(0, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '\x1b[31mPublic ' } }, zero());
    run.event(0, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'update' } }, zero());
    run.event(0, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'src/main.ts' } }, zero());
    run.event(0, { type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'SECRET_COMMAND' } }, zero());
    run.event(0, { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read' }, zero());
    run.event(0, { type: 'tool_execution_end', toolName: 'pstack_todo', result: { details: { version: 1, items: ['[done] Read', 'Test'] } } }, zero());
    const authoritative = { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cost: 0.125, contextTokens: 20, turns: 3 };
    const event = { type: 'message_end', message: { role: 'assistant', usage: { input: 9999 }, content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }] } };
    run.event(0, event, { ...authoritative, input: 12 });
    run.event(0, event, authoritative);
    run.publish();
    authoritative.input = 1234;
    assert.equal(row().observedModel, 'fixture/test');
    assert.equal(row().message, 'Public update');
    assert.deepEqual(row().tools, [{ id: 'b', name: 'bash' }]);
    assert.deepEqual(row().todos, ['[done] Read', 'Test']);
    assert.deepEqual(row().usage, { ...authoritative, input: 2 });
    assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE_THOUGHT|SECRET_COMMAND|9999|\\u001b/);
    const lines = progressLines(latest(), true).join('\n');
    assert.match(lines, /todos 1\/2 \(self-reported\)/);
    assert.match(lines, /20 tok \$0.1250/);
    assert.match(lines, /Turns: 3/);
    assert.doesNotMatch(lines, /cleanup|quarantin|delegation disabled|proof of life/);
  } finally { run.finish(); }
});

test('all public fields and event history stay bounded and sanitized', () => {
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot | undefined} */ let latest;
  const dirty = '\x1b[31m\u202e\n' + '界'.repeat(10_000);
  const run = new RunProgress([{ agent: dirty, task: dirty, role: dirty, model: dirty }], (value) => { latest = value; });
  try {
    run.started(0);
    for (let index = 0; index < 100; index++) run.event(0, { type: 'tool_execution_start', toolCallId: `${index}${dirty}`, toolName: dirty, args: { path: dirty } }, zero());
    run.event(0, { type: 'message_end', message: { role: 'assistant', provider: dirty, model: dirty, content: [{ type: 'text', text: dirty }] } }, zero());
    run.event(0, { type: 'tool_execution_end', toolName: 'pstack_todo', result: { details: { version: 1, items: Array(128).fill(dirty.slice(0, 4000)) } } }, zero());
    run.publish();
    assert.ok(latest);
    const row = latest.tasks[0];
    assert.ok(row.agent.length <= 80 && row.role.length <= 80 && row.model.length <= 201);
    assert.ok(row.task.length <= 600 && row.message.length <= 240);
    assert.ok(row.observedModel && row.observedModel.length <= 201);
    assert.equal(row.tools.length, 16);
    assert.ok(row.tools.every((tool) => tool.id.length <= 256 && tool.name.length <= 181));
    assert.equal(row.events.length, 16);
    assert.ok(row.events.every((event) => event.summary.length <= 180 && event.type.length <= 60));
    assert.equal(row.todos?.length, 128);
    assert.ok(row.todos?.every((item) => item.length <= 180));
    assert.doesNotMatch(JSON.stringify(latest), /\\u001b|\\n|\u202e/);
    assert.equal(plain('x'.repeat(10_000)).length, 180);
    assert.equal(plain('x\u202ey\n\x00z'), 'x y z');
  } finally { run.finish(); }
});

test('normal package todo results replace state, preserve empty lists, and reject failed or malformed reports', () => {
  const { run, row } = fixture();
  try {
    run.started(0);
    /** @param {unknown} details @param {boolean} [isError] */
    const todo = (details, isError = false) => {
      run.event(0, { type: 'message_end', message: { role: 'toolResult', toolName: 'pstack_todo', details, isError } }, zero());
      run.publish();
    };
    todo({ version: 1, items: ['[done] Read', 'Test'] });
    assert.deepEqual(row().todos, ['[done] Read', 'Test']);
    todo({ version: 1, items: ['wrong'] }, true);
    todo({ version: 2, items: ['wrong'] });
    todo({ version: 1, items: [3] });
    assert.deepEqual(row().todos, ['[done] Read', 'Test']);
    todo({ version: 1, items: [] });
    assert.deepEqual(row().todos, []);
  } finally { run.finish(); }
});

test('quiet and long-run warnings are advisory, and completion freezes event age and duration', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { run, row, latest } = fixture();
  run.started(0);
  assert.match(taskLine(row(), 61_000), /QUIET/);
  assert.match(taskLine(row(), 601_000), /LONG RUN/);
  run.event(0, { type: 'message_start', message: { role: 'assistant' } }, zero());
  now = 1000;
  run.result(0, { exitCode: 0, usage: zero() });
  const completed = structuredClone(row());
  now = 65_000;
  run.result(0, { exitCode: 1, usage: { ...zero(), input: 100 } });
  run.started(0);
  run.stopping(0);
  run.event(0, { type: 'auto_retry_start' }, zero());
  run.finish();
  const final = structuredClone(latest());
  now = 700_000;
  run.finish();
  run.publish();
  assert.deepEqual(row(), completed);
  assert.deepEqual(latest(), final);
  assert.match(taskLine(row(), now), /succeeded 1s.*last event 1s before finish/);
  assert.doesNotMatch(taskLine(row(), now), /QUIET|LONG RUN/);
});

test('finish skips unstarted chain rows and fails running rows without terminal results', (t) => {
  t.mock.method(Date, 'now', () => 0);
  const { run, latest } = fixture(12);
  run.started(0);
  run.result(0, { exitCode: 0, usage: zero() });
  run.started(1);
  run.result(1, { exitCode: 0, stopReason: 'error', errorMessage: 'Provider failed', usage: zero() });
  run.started(2);
  run.stopping(2);
  run.result(2, { exitCode: 1, stopReason: 'aborted', usage: zero() });
  run.started(3);
  run.started(4);
  run.stopping(4);
  run.stopping(5);
  run.finish('Cancelled');
  assert.deepEqual(latest().tasks.map((row) => row.state), ['succeeded', 'failed', 'aborted', 'failed', 'failed', ...Array(7).fill('skipped')]);
  assert.ok(latest().tasks.every((row) => row.endedAt === 0));
  assert.match(progressLines(latest())[0], /12\/12 finished/);
  assert.equal(latest().tasks[1].activity, 'Provider failed');
});

test('observers cannot mutate owned rows or abort work', () => {
  const { run, row } = fixture();
  row().state = 'failed';
  row().usage.input = 99;
  run.started(0);
  assert.equal(row().state, 'running');
  assert.equal(row().usage.input, 0);
  run.finish();
  const throwing = new RunProgress([{ agent: 'general-purpose', task: 'Inspect' }], () => { throw new Error('display failure'); });
  assert.doesNotThrow(() => { throwing.started(0); throwing.stopping(0); throwing.finish('cancelled'); throwing.finish(); });
});

test('heartbeat publishes quiet status while work runs, then stops at finish', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const { run, latest, snapshots } = fixture();
  run.started(0);
  t.mock.timers.tick(61_000);
  assert.match(progressLines(latest()).join('\n'), /QUIET/);
  run.finish();
  const count = snapshots.length;
  t.mock.timers.tick(600_000);
  assert.equal(snapshots.length, count);
  assert.doesNotMatch(progressLines(latest()).join('\n'), /QUIET|LONG RUN/);
});

test('unknown events and malformed models do not leak payloads or throw', () => {
  const { run, row } = fixture();
  try {
    run.started(0);
    for (const event of [null, [], 'PRIVATE_PAYLOAD', 42, { type: 'PRIVATE_PAYLOAD' },
      { type: 'message_start', message: { role: 'assistant', provider: { secret: 'PRIVATE_PAYLOAD' } } }]) run.event(0, event, zero());
    run.publish();
    assert.equal(row().observedModel, null);
    assert.doesNotMatch(JSON.stringify(row()), /PRIVATE_PAYLOAD|undefined/);
  } finally { run.finish(); }
});

test('rejected async observers cannot cause an unhandled rejection', async () => {
  const run = new RunProgress([{ agent: 'general-purpose', task: 'Inspect' }], async () => { throw new Error('Async display failure'); });
  run.started(0);
  run.finish();
  await new Promise((resolve) => setImmediate(resolve));
});

test('cmux coalesces writes, uses owned keys, and clears after pending work exactly once', async () => {
  const { run, latest } = fixture();
  run.finish();
  /** @type {string[][]} */ const calls = [];
  const gate = deferred();
  const sidebar = new Sidebar('workspace:test', async (args) => { calls.push(args); if (calls.length === 1) await gate.promise; });
  sidebar.publish(latest());
  for (let i = 0; i < 100; i++) sidebar.publish(latest());
  const closing = sidebar.close();
  const again = sidebar.close();
  gate.resolve(undefined);
  await Promise.all([closing, again]);
  sidebar.publish(latest());
  assert.deepEqual(calls.map((args) => args[0]), ['set-status', 'clear-status']);
  assert.equal(calls[0][1], calls[1][1]);
  assert.match(calls[0][1], /^pstack-[\da-f-]+-0$/);
  assert.ok(calls.every((args) => args.at(-1) === 'workspace:test'));
});

test('cmux publishes only the latest pending snapshot and never clears another sidebar owner', async () => {
  const { run, latest } = fixture(2);
  run.finish();
  /** @type {string[][]} */ const calls = [];
  const gate = deferred();
  const sidebar = new Sidebar('workspace:test', async (args) => { calls.push(args); if (calls.length === 1) await gate.promise; });
  const other = new Sidebar('workspace:test', async (args) => { calls.push(args); });
  sidebar.publish(latest());
  for (let i = 0; i < 100; i++) {
    const next = structuredClone(latest());
    next.tasks = next.tasks.slice(0, 1);
    next.tasks[0].activity = `update ${i}`;
    sidebar.publish(next);
  }
  gate.resolve(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((args) => args[0] === 'set-status').length, 3);
  assert.match(calls[2][2], /update 99/);
  assert.deepEqual(calls[3], ['clear-status', calls[1][1], '--workspace', 'workspace:test']);
  other.publish(latest());
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(calls[0][1], calls[4][1]);
  await sidebar.close();
  assert.equal(calls.at(-1)?.[1], calls[0][1]);
  await other.close();
});

test('long chains bound sidebar writes and cleanup to eight task keys', async () => {
  const { run, latest } = fixture(200);
  run.finish();
  /** @type {string[][]} */ const calls = [];
  const sidebar = new Sidebar('workspace:test', async (args) => { calls.push(args); });
  sidebar.publish(latest());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 8);
  await sidebar.close();
  assert.equal(calls.length, 16);
  assert.equal(calls.filter((args) => args[0] === 'clear-status').length, 8);
});

test('a cmux failure after successful writes clears stale running status', async () => {
  const { run, latest } = fixture();
  run.started(0);
  /** @type {string[][]} */ const calls = [];
  const sidebar = new Sidebar('workspace:test', async (args) => {
    calls.push(args);
    if (calls.length === 2) throw new Error('cmux timed out');
  });
  sidebar.publish(latest());
  await new Promise((resolve) => setImmediate(resolve));
  run.result(0, { exitCode: 0, usage: zero() });
  run.finish();
  sidebar.publish(latest());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((args) => args[0]), ['set-status', 'set-status', 'clear-status']);
  assert.equal(calls[2][1], calls[0][1]);
  await sidebar.close();
  assert.equal(calls.length, 3);
});

test('missing cmux and failed cmux commands never affect work', async () => {
  const { run, latest } = fixture();
  run.finish();
  const absent = new Sidebar('', async () => { assert.fail('No cmux call expected'); });
  absent.publish(latest());
  await absent.close();
  let calls = 0;
  const failed = new Sidebar('workspace:test', async () => { calls++; throw new Error('cmux unavailable'); });
  failed.publish(latest());
  await new Promise((resolve) => setImmediate(resolve));
  failed.publish(latest());
  await failed.close();
  assert.equal(calls, 3, 'One failed update, immediate cleanup, then a cleanup retry at shutdown');
});
