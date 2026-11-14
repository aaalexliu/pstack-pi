import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDueRoutines, lastDue } from './routines.ts';

process.env.TZ = 'America/New_York';
const local = (s: string) => new Date(s).toString().slice(0, 21);
const due = (schedule: string, now: string) => local(lastDue(schedule, new Date(now)).toISOString());

test('lastDue handles daily, weekly and every-N-hours across midnight and DST', () => {
  assert.equal(due('daily 05:00', '2026-03-10T05:00:00'), 'Tue Mar 10 2026 05:00');
  assert.equal(due('daily 05:00', '2026-03-10T04:59:00'), 'Mon Mar 09 2026 05:00');
  assert.equal(due('daily 23:30', '2026-03-10T00:10:00'), 'Mon Mar 09 2026 23:30');
  assert.equal(due('daily 05:00', '2026-03-08T04:00:00'), 'Sat Mar 07 2026 05:00'); // DST starts Mar 8 at 02:00
  assert.equal(due('daily 05:00', '2026-03-08T06:00:00'), 'Sun Mar 08 2026 05:00');
  assert.equal(due('weekly Mon 09:00', '2026-03-09T08:00:00'), 'Mon Mar 02 2026 09:00');
  assert.equal(due('weekly Mon 09:00', '2026-03-10T00:00:00'), 'Mon Mar 09 2026 09:00');
  assert.equal(due('weekly Sun 05:00', '2026-03-08T05:00:00'), 'Sun Mar 08 2026 05:00');
  assert.equal(due('every 6h', '2026-03-10T00:30:00'), 'Tue Mar 10 2026 00:00');
  assert.equal(due('every 6h', '2026-03-09T23:59:00'), 'Mon Mar 09 2026 18:00');
  assert.equal(due('every 6h', '2026-11-01T07:00:00'), 'Sun Nov 01 2026 06:00'); // DST ends Nov 1
  assert.equal(due('every 6h', '2026-03-08T05:00:00'), 'Sun Mar 08 2026 00:00');
  assert.throws(() => lastDue('hourly', new Date()));
});

function fakeLinear() {
  const issues: { title: string; description: string; input: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body);
    let data: unknown;
    if (query.includes('Marked')) data = { issues: { nodes: issues.filter((i) => i.description.includes(variables.mark)) } };
    else if (query.includes('Ids')) data = { teams: { nodes: [{ id: 't', states: { nodes: [{ id: 's', name: 'Todo' }] } }] }, users: { nodes: [{ id: 'u' }] }, issueLabels: { nodes: [{ id: 'l' }] } };
    else { issues.push({ ...variables.input, input: variables.input }); data = { issueCreate: { success: true } }; }
    return new Response(JSON.stringify({ data }));
  }) as unknown as typeof fetch;
  return { issues, fetchFn };
}
const config = { linearTokenCommand: 'echo token', team: 'ALE', runnerUser: 'runner', routines: [{ name: 'audit', schedule: 'daily 05:00', repo: 'pstack-pi', title: 'Audit', prompt: 'Do it' }] };

test('creates one delegated Todo issue for the due run, and no duplicate when its marker exists', async () => {
  const linear = fakeLinear();
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T07:00:00'));
  assert.equal(linear.issues.length, 1);
  assert.deepEqual(linear.issues[0].input, {
    teamId: 't', stateId: 's', delegateId: 'u', labelIds: ['l'], title: 'Audit (2026-03-10)',
    description: `Do it\n\nrunner-routine audit ${new Date('2026-03-10T05:00:00').toISOString()}`,
  });
});

test('after a long downtime only the latest missed run is created', async () => {
  const linear = fakeLinear();
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-01T06:00:00'));
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  assert.deepEqual(linear.issues.map((i) => i.title), ['Audit (2026-03-01)', 'Audit (2026-03-10)']);
});

test('nothing new before the due time', async () => {
  const linear = fakeLinear();
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-10T06:00:00'));
  await createDueRoutines(config, linear.fetchFn, new Date('2026-03-11T04:59:00'));
  assert.equal(linear.issues.length, 1);
});
