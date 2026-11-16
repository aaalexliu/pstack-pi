import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { format } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDueRoutines, lastDue, parseSchedule } from './routines.ts';
import { loadConfig } from './runner.ts';

process.env.TZ = 'America/New_York';
const due = (schedule: string, now: string) => lastDue(schedule, new Date(now)).toString().slice(0, 21);

test('lastDue handles daily and weekly across midnight and DST', () => {
  assert.equal(due('daily 05:00', '2026-03-10T05:00:00'), 'Tue Mar 10 2026 05:00');
  assert.equal(due('daily 05:00', '2026-03-10T04:59:00'), 'Mon Mar 09 2026 05:00');
  assert.equal(due('daily 23:30', '2026-03-10T00:10:00'), 'Mon Mar 09 2026 23:30');
  assert.equal(due('daily 05:00', '2026-03-08T04:00:00'), 'Sat Mar 07 2026 05:00'); // DST starts Mar 8 at 02:00
  assert.equal(due('daily 05:00', '2026-03-08T06:00:00'), 'Sun Mar 08 2026 05:00');
  assert.equal(due('daily 01:30', '2026-11-01T03:00:00'), 'Sun Nov 01 2026 01:30'); // DST ends Nov 1
  assert.equal(due('weekly Mon 09:00', '2026-03-09T08:00:00'), 'Mon Mar 02 2026 09:00');
  assert.equal(due('weekly Mon 09:00', '2026-03-10T00:00:00'), 'Mon Mar 09 2026 09:00');
  assert.equal(due('weekly Sun 05:00', '2026-03-08T05:00:00'), 'Sun Mar 08 2026 05:00');
});

test('parseSchedule accepts real clock times and weekdays only', () => {
  assert.deepEqual(parseSchedule('daily 00:00'), { day: undefined, hour: 0, minute: 0 });
  assert.deepEqual(parseSchedule('weekly Sat 23:59'), { day: 'Sat', hour: 23, minute: 59 });
  for (const bad of ['daily 24:00', 'daily 05:60', 'daily 5:00', 'weekly Fun 05:00', 'every 6h', 'every 0h', 'hourly']) assert.throws(() => parseSchedule(bad), /Bad routine schedule/, bad);
});

test('loadConfig refuses a bad routine schedule, so the runner and --dry-run both stop at start', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'routines-')), 'config.json');
  const base = { linearTokenCommand: 'true', team: 'ALE', runnerUser: 'runner', decisionAssignee: 'Alex', repos: {}, models: { lead: 'a', review: 'b' }, worktreeRoot: '/tmp' };
  writeFileSync(file, JSON.stringify({ ...base, routines: [{ ...routine, schedule: 'daily 24:00' }] }));
  assert.throws(() => loadConfig(file), /Bad routine schedule/);
  writeFileSync(file, JSON.stringify({ ...base, routines: [routine] }));
  assert.equal(loadConfig(file).routines?.length, 1);
});

type Fake = { description: string; state: string; archived?: boolean; input?: Record<string, unknown> };
function fakeLinear(o: { failSearchFor?: string; refuse?: boolean } = {}) {
  const issues: Fake[] = [];
  let calls = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    calls++;
    const { query, variables } = JSON.parse(init.body);
    let data: unknown;
    if (query.includes('Marked')) {
      if (o.failSearchFor && variables.mark.includes(o.failSearchFor)) return new Response(JSON.stringify({ errors: ['down'] }), { status: 500 });
      assert.match(query, /includeArchived: true/);
      assert.match(query, /description: \{ contains: \$mark \}/);
      assert.doesNotMatch(query, /state/);
      assert.match(variables.mark, /^runner-routine \S+ \d{4}-\d\d-\d\dT[\d:.]+Z$/);
      data = { issues: { nodes: issues.filter((i) => i.description.includes(variables.mark) && (!i.archived || query.includes('includeArchived: true'))) } };
    } else if (query.includes('Ids')) {
      assert.match(query, /issueLabels\(filter: \{ name: \{ eq: \$label \}, or: \[\{ team: \{ key: \{ eq: \$team \} \} \}, \{ team: \{ null: true \} \}\] \}\)/);
      data = { teams: { nodes: [{ id: 't', states: { nodes: [{ id: 's', name: 'Todo' }] } }] }, users: { nodes: [{ id: 'u' }] }, issueLabels: { nodes: [{ id: 'l' }] } };
    } else {
      if (!o.refuse) issues.push({ description: variables.input.description, state: 'Todo', input: variables.input });
      data = { issueCreate: { success: !o.refuse } };
    }
    return new Response(JSON.stringify({ data }));
  }) as unknown as typeof fetch;
  return { issues, fetchFn, get calls() { return calls; } };
}
const routine = { name: 'audit', schedule: 'daily 05:00', repo: 'pstack-pi', title: 'Audit', prompt: 'Do it' };
const config = { linearTokenCommand: 'echo token', team: 'ALE', runnerUser: 'runner', routines: [routine] };
/**
 * Captures what createDueRoutines prints: the first line of each log and error.
 * When the test ends, the errors must match `expected` exactly, in order, so an unexpected error fails it.
 */
function capture(t: TestContext, expected: (string | RegExp)[] = []) {
  const lines = (method: 'log' | 'error') => t.mock.method(console, method, () => {});
  const logs = lines('log');
  const errors = lines('error');
  const first = (m: typeof logs) => () => m.mock.calls.map((c) => format(...c.arguments).split('\n')[0]);
  t.after(() => {
    const got = first(errors)();
    assert.equal(got.length, expected.length, `printed errors: ${JSON.stringify(got)}`);
    expected.forEach((e, i) => typeof e === 'string' ? assert.equal(got[i], e) : assert.match(got[i], e));
  });
  return { logs: first(logs) };
}
const markFor = (name: string, at: string) => `runner-routine ${name} ${new Date(at).toISOString()}`;

test('creates one delegated Todo issue for the due run, and no duplicate when its marker exists', async (t) => {
  const printed = capture(t);
  const linear = fakeLinear();
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T07:00:00'));
  assert.equal(linear.issues.length, 1);
  assert.deepEqual(printed.logs(), ['Routine audit: created the 2026-03-10 run']);
  assert.deepEqual(linear.issues[0].input, {
    teamId: 't', stateId: 's', delegateId: 'u', labelIds: ['l'], title: 'Audit (2026-03-10)', description: `Do it\n\n${markFor('audit', '2026-03-10T05:00:00')}`,
  });
});

test('a Done, Canceled or archived issue with the marker blocks a new one; a similarly named routine does not', async (t) => {
  const printed = capture(t);
  for (const old of [{ state: 'Done' }, { state: 'Canceled' }, { state: 'Done', archived: true }]) {
    const linear = fakeLinear();
    linear.issues.push({ ...old, description: `x\n\n${markFor('audit', '2026-03-10T05:00:00')}` });
    await createDueRoutines({ ...config, routines: [routine, { ...routine, name: 'audit-2' }] }, linear.fetchFn, new Date('2026-03-10T06:00:00'));
    assert.deepEqual(linear.issues.slice(1).map((i) => i.description), [`Do it\n\n${markFor('audit-2', '2026-03-10T05:00:00')}`], JSON.stringify(old));
  }
  assert.deepEqual(printed.logs(), Array(3).fill('Routine audit-2: created the 2026-03-10 run'));
});

test('a failed search creates nothing for that routine, the next routine still runs, and the call resolves', async (t) => {
  const printed = capture(t, ['Routine audit: failed; the next poll tries again Error: Linear 500: ["down"]']);
  const linear = fakeLinear({ failSearchFor: 'runner-routine audit ' });
  await createDueRoutines({ ...config, routines: [routine, { ...routine, name: 'other' }] }, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  assert.deepEqual(linear.issues.map((i) => i.description), [`Do it\n\n${markFor('other', '2026-03-10T05:00:00')}`]);
  assert.deepEqual(printed.logs(), ['Routine other: created the 2026-03-10 run']);
});

test('issueCreate success false is a failure, not a created run', async (t) => {
  const printed = capture(t, [/^Routine audit: failed; the next poll tries again .*refused/]);
  await createDueRoutines(config, fakeLinear({ refuse: true }).fetchFn, new Date('2026-03-10T06:00:00'));
  assert.deepEqual(printed.logs(), []);
});

test('after a long downtime only the latest missed run is created', async (t) => {
  const printed = capture(t);
  const linear = fakeLinear();
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-01T06:00:00'));
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  assert.deepEqual(linear.issues.map((i) => i.input?.title), ['Audit (2026-03-01)', 'Audit (2026-03-10)']);
  assert.deepEqual(printed.logs(), ['Routine audit: created the 2026-03-01 run', 'Routine audit: created the 2026-03-10 run']);
});

test('nothing new before the due time', async (t) => {
  const printed = capture(t);
  const linear = fakeLinear();
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-11T04:59:00'));
  assert.equal(linear.issues.length, 1);
  assert.deepEqual(printed.logs(), ['Routine audit: created the 2026-03-10 run']);
});

test('a Linear call that hangs times out, so the poll goes on to tickets', async (t) => {
  capture(t, ['Routine audit: failed; the next poll tries again DOMException [TimeoutError]: The operation was aborted due to timeout']);
  const hang = ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason));
  })) as unknown as typeof fetch;
  const started = Date.now();
  await createDueRoutines(config, hang, new Date('2026-03-10T06:00:00'), 50);
  assert.ok(Date.now() - started < 2000);
});

test('a token command that hangs times out too', async (t) => {
  capture(t, [/^Routine audit: failed; the next poll tries again .*spawnSync \/bin\/sh ETIMEDOUT$/]);
  const started = Date.now();
  await createDueRoutines({ ...config, linearTokenCommand: 'sleep 5' }, fakeLinear().fetchFn, new Date('2026-03-10T06:00:00'), 100);
  assert.ok(Date.now() - started < 2000);
});
