import assert from 'node:assert/strict';
import { usageReport } from '../../extensions/subagent/usage.ts';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { executionLimits, maximumTimerDelayMs, parseDepth, parseRequest, inputLimits } from '../../extensions/subagent/domain.ts';
import { boundedOutput, resolveCwd } from '../../extensions/subagent/runner.ts';
import { PiInvocation } from '../../extensions/subagent/process.ts';
import { DelegationScheduler, immutable, outputQuota } from '../../extensions/subagent/scheduler.ts';

const root = parseDepth(undefined);
const cwd = await resolveCwd({ current: process.cwd() });
const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
/** @param {number} index @returns {import('../../extensions/subagent/scheduler.ts').ResolvedTask} */
function task(index) {
  const provenance = { kind: /** @type {const} */ ('bundled'), path: '/agent.md', sha256: 'a'.repeat(64) };
  return { identity: { id: String(index), agent: { name: 'test', provenance }, cwd },
    agent: { name: 'test', description: 'Test.', tools: [], systemPrompt: 'Test.', provenance }, task: String(index),
    model: { provider: 'fixture', id: 'model', thinkingLevel: 'off' }, depth: root, limits: executionLimits, invocation,
    requested: { model: null, role: null }, selection: { source: 'parent', choice: { kind: 'inheritParent' } } };
}
function manualTimer() {
  let now = 0;
  /** @type {{callback: () => void, delayMs: number, cancelled: boolean}[]} */
  const scheduled = [];
  return {
    controls: {
      now: () => now,
      schedule: (/** @type {() => void} */ callback, /** @type {number} */ delayMs) => {
        const entry = { callback, delayMs, cancelled: false };
        scheduled.push(entry);
        return { cancel: () => { entry.cancelled = true; } };
      },
    },
    scheduled,
    advance: (/** @type {number} */ durationMs) => { now += durationMs; },
  };
}

function controlledRun() {
  /** @type {Map<string, () => void>} */
  const finish = new Map();
  /** @type {Map<string, import('../../extensions/subagent/domain.ts').RunLease>} */
  const leases = new Map();
  /** @type {string[]} */
  const started = [];
  /** @type {string[]} */
  const aborted = [];
  /** @type {typeof import('../../extensions/subagent/runner.ts').runChild} */
  const run = async ({ identity, lease }) => {
    assert.ok(lease);
    started.push(identity.id);
    leases.set(identity.id, lease);
    lease.prepare(); lease.run();
    lease.signal.addEventListener('abort', () => aborted.push(identity.id), { once: true });
    await new Promise((resolve) => { finish.set(identity.id, () => resolve(undefined)); });
    lease.verify(); lease.finish(true);
    const base = { ...identity, output: boundedOutput(identity.id), diagnostics: [], usage: usageReport(), observedModel: null,
      cleanup: { verified: true, durationMs: 0, forced: false, observedProcesses: 1 } };
    return lease.cancellation ? { ...base, kind: 'cancelled', reason: lease.cancellation } : { ...base, kind: 'succeeded' };
  };
  return { run, finish, started, aborted, leases };
}

test('parallel boundary rejects mixed shapes, unknown fields at every level, and UTF-8 overflow', () => {
  const entry = { agent: 'general-purpose', task: 'x' };
  assert.equal(parseRequest({ tasks: [entry] }).kind, 'parallel');
  assert.equal(parseRequest({ tasks: Array(8).fill(entry) }).kind, 'parallel');
  for (const input of [{ tasks: [] }, { tasks: Array(9).fill(entry) }, { tasks: [entry], ...entry }, { chain: [entry] }, { tasks: [entry], model: 'inherit-parent' }]) assert.throws(() => parseRequest(input));
  for (const key of ['cwd', 'limits', 'tools', 'executable', 'trust', 'agentScope', 'confirmProjectAgents', 'recursion', 'unknown']) {
    assert.throws(() => parseRequest({ tasks: [{ ...entry, [key]: true }] }), key);
  }
  assert.throws(() => parseRequest({ tasks: [entry], limits: { maxConcurrent: 5 } }));
  assert.throws(() => parseRequest({ ...entry, task: '✓'.repeat(11000) }), /byte limit/);
  assert.throws(() => parseRequest({ tasks: Array(5).fill({ ...entry, task: 'x'.repeat(inputLimits.taskBytes) }) }), /byte limit/);
  assert.throws(() => parseRequest({ tasks: Array(4).fill({ ...entry, task: '\u0001'.repeat(inputLimits.taskBytes) }) }), /byte limit/);
});

test('quotas split aggregate bytes by input index, including zero-byte quotas', () => {
  for (const bytes of [1, 3, 7, 13, 32768]) {
    const quotas = Array.from({ length: 8 }, (_, index) => outputQuota(bytes, 8, index));
    assert.equal(quotas.reduce((sum, quota) => sum + quota, 0), bytes);
    assert.ok(quotas.every((quota, index) => index === 0 || quota <= quotas[index - 1]));
    assert.ok(quotas[0] - quotas[7] <= 1);
  }
});

test('four slots hold through cleanup, replace in FIFO order, and return eight results in input order', async () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  const fixture = controlledRun();
  request.admit(Array.from({ length: 8 }, (_, index) => task(index)), () => {});
  const pending = request.run(fixture.run);
  assert.deepEqual(fixture.started, ['0', '1', '2', '3']);
  assert.throws(() => scheduler.reserve(root));
  for (const [finished, replacement] of [['3', '4'], ['2', '5'], ['1', '6'], ['0', '7']]) {
    fixture.finish.get(finished)?.();
    await delay(0);
    assert.equal(fixture.started.at(-1), replacement);
  }
  for (const index of ['7', '6', '5', '4']) { fixture.finish.get(index)?.(); await delay(0); }
  const results = await pending;
  assert.deepEqual(results.map((result) => result.output.text), ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.ok(results.every((result) => result.kind === 'succeeded'));
  request.finish();
});

for (const reason of ['user', 'deadline', 'parentShutdown']) {
  test(`${reason} broadcasts to all four leases before waiting and skips four queued tasks`, async () => {
    const scheduler = new DelegationScheduler();
    const request = scheduler.reserve(root);
    const fixture = controlledRun();
    request.admit(Array.from({ length: 8 }, (_, index) => task(index)), () => {});
    const pending = request.run(fixture.run);
    if (reason === 'parentShutdown') void scheduler.shutdown();
    else if (reason === 'deadline') { request.lowerDeadline(1); await delay(5); }
    else request.cancel('user');
    assert.deepEqual(fixture.aborted, ['0', '1', '2', '3']);
    assert.deepEqual(fixture.started, ['0', '1', '2', '3']);
    for (const finish of fixture.finish.values()) finish();
    const results = await pending;
    assert.deepEqual(results.map((result) => result.kind), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'skipped', 'skipped', 'skipped', 'skipped']);
    request.finish();
  });
}

test('ordinary failure leaves siblings and queued tasks running', async () => {
  const request = new DelegationScheduler().reserve(root);
  const fixture = controlledRun();
  request.admit(Array.from({ length: 8 }, (_, index) => task(index)), () => {});
  const pending = request.run(async (args) => {
    const result = await fixture.run(args);
    return args.identity.id === '0' ? { ...result, kind: 'failed', reason: 'Ordinary failure' } : result;
  });
  for (const index of ['0', '1', '2', '3', '4', '5', '6', '7']) { fixture.finish.get(index)?.(); await delay(0); }
  const results = await pending;
  assert.equal(results[0].kind, 'failed');
  assert.ok(results.slice(1).every((result) => result.kind === 'succeeded'));
  assert.deepEqual(fixture.aborted, []);
  request.finish();
});

test('early uncertainty is sticky and prevents a finished sibling from releasing a queued slot', async () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  const fixture = controlledRun();
  request.admit(Array.from({ length: 8 }, (_, index) => task(index)), () => {});
  const pending = request.run(fixture.run);
  const uncertain = fixture.leases.get('2');
  assert.ok(uncertain);
  uncertain.distrustCleanup();
  uncertain.distrustCleanup();
  assert.deepEqual(fixture.aborted, ['0', '1', '2', '3']);
  assert.equal(request.state, 'quarantined');
  fixture.finish.get('0')?.();
  await delay(0);
  assert.deepEqual(fixture.started, ['0', '1', '2', '3']);
  assert.throws(() => scheduler.reserve(root), /quarantined/);
  for (const finish of fixture.finish.values()) finish();
  const results = await pending;
  assert.equal(results[2].kind, 'failed');
  assert.equal(results[2].cleanup.verified, false);
  assert.equal(uncertain.state.kind, 'quarantined', 'A later verified finish cannot repair lost trust');
  assert.ok(results.slice(4).every((result) => result.kind === 'skipped'));
  request.finish();
  assert.throws(() => scheduler.reserve(root), /quarantined/);
});

test('non-cooperative spawn-free preparation cannot hold shutdown open or commit after cancellation', async () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  let completed = false;
  const waiting = request.wait(() => new Promise(() => {})).catch(() => { completed = true; });
  const shutdown = scheduler.shutdown();
  await waiting;
  assert.equal(completed, true);
  assert.equal(request.cancellation, 'parentShutdown');
  request.finish();
  await shutdown;
});

test('each admitted batch can dispatch only once', async () => {
  const request = new DelegationScheduler().reserve(root);
  const fixture = controlledRun();
  request.admit([task(0)], () => {});
  const pending = request.run(fixture.run);
  await assert.rejects(request.run(fixture.run));
  request.cancel('user');
  await assert.rejects(request.run(fixture.run));
  fixture.finish.get('0')?.();
  await pending;
  request.finish();
});

test('request reservation excludes overlap before preparation and releases rejected work', () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  assert.equal(request.state, 'reserved');
  assert.throws(() => scheduler.reserve(root), /already running/);
  request.finish();
  scheduler.reserve(root).finish();
});

test('an omitted deadline creates no timer and stays active past the former boundary', () => {
  const timer = manualTimer();
  const request = new DelegationScheduler(timer.controls).reserve(root);
  assert.equal(timer.scheduled.length, 0);
  timer.advance(120001);
  request.check();
  assert.equal(request.cancellation, undefined);
  assert.equal(timer.scheduled.length, 0);
  request.finish();
});

test('an explicit deadline includes preparation and can only get shorter', async () => {
  const scheduler = new DelegationScheduler();
  const request = scheduler.reserve(root);
  request.lowerDeadline(10);
  request.lowerDeadline(120000);
  await delay(20);
  assert.equal(request.cancellation, 'deadline');
  let commits = 0;
  assert.throws(() => request.admit([task(0)], () => { commits++; }));
  assert.equal(commits, 0);
  request.finish();
});

test('a deadline beyond one Node timer interval is scheduled without shortening it', () => {
  const timer = manualTimer();
  const request = new DelegationScheduler(timer.controls).reserve(root);
  request.lowerDeadline(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(timer.scheduled.map(({ delayMs }) => delayMs), [maximumTimerDelayMs]);
  timer.advance(maximumTimerDelayMs);
  timer.scheduled[0].callback();
  assert.equal(request.cancellation, undefined);
  assert.deepEqual(timer.scheduled.filter(({ cancelled }) => !cancelled).map(({ delayMs }) => delayMs), [maximumTimerDelayMs]);
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
  const frozen = immutable({ model: { id: 'first' }, tools: ['read'] });
  assert.throws(() => { frozen.model.id = 'second'; });
  assert.throws(() => frozen.tools.push('bash'));
  request.admit([task(0)], () => { commits++; });
  assert.throws(() => request.admit([task(0)], () => { commits++; }));
  assert.equal(commits, 1);
  request.finish();
});
