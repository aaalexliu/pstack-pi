import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseDepth } from '../../extensions/subagent/domain.ts';
import { DelegationScheduler, immutable } from '../../extensions/subagent/scheduler.ts';

const root = parseDepth(undefined);

test('request reservation excludes overlap before preparation and releases rejected work', () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  assert.equal(request.state, 'reserved');
  assert.throws(() => scheduler.reserve(root), /already running/);
  request.finish();
  scheduler.reserve(root).finish();
});

test('one deadline includes preparation and can only get shorter', async () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  request.lowerDeadline(10);
  request.lowerDeadline(120000);
  await delay(20);
  assert.equal(request.cancellation, 'deadline');
  let commits = 0;
  assert.throws(() => request.admit(() => { commits++; }));
  assert.equal(commits, 0);
  request.finish();
});

test('shutdown stops preparation synchronously and waits until the request releases ownership', async () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  const first = scheduler.shutdown();
  assert.equal(request.cancellation, 'parentShutdown');
  assert.equal(first, scheduler.shutdown());
  assert.throws(() => scheduler.reserve(root), /shutting down/);
  request.finish();
  await first;
});

test('admission commits once and freezes the full prepared value', () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  let commits = 0;
  const task = immutable({ model: { id: 'first' }, tools: ['read'] });
  assert.throws(() => { task.model.id = 'second'; });
  assert.throws(() => task.tools.push('bash'));
  request.admit(() => { commits++; });
  assert.throws(() => request.admit(() => { commits++; }));
  assert.equal(commits, 1);
  request.finish();
});
