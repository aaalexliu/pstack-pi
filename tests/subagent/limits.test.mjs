import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { executionLimits, protocolLimits, parseDepth, requireRoot, reduceLimits, parseRequest, RunRegistry } from '../../extensions/subagent/domain.ts';
import { PiInvocation, childEnvironment } from '../../extensions/subagent/process.ts';

const root = parseDepth(undefined);

test('host policy is immutable and separate from protocol caps', () => {
  assert.deepEqual(executionLimits, { maxTasks: 1, maxConcurrent: 1, maxDepth: 1, timeoutMs: 120000, outputBytes: 32768 });
  assert.ok(Object.isFrozen(executionLimits));
  assert.ok(Object.isFrozen(protocolLimits));
  assert.ok(!('outputBytes' in protocolLimits));
});

test('canonical bounded depth never raises host policy', () => {
  assert.equal(root, 0);
  for (const depth of ['0', '1', '2', '999999']) assert.equal(parseDepth(depth), Number(depth));
  for (const bad of ['', '00', '01', '-1', '+1', ' 0', '0\n', '1.0', '1e0', 'NaN', 'Infinity', '1000000', '9'.repeat(1000)]) assert.throws(() => parseDepth(bad));
  requireRoot(root);
  for (const depth of ['1', '2', '999999']) assert.throws(() => requireRoot(parseDepth(depth)));
});

test('requests only reduce timeout and output; larger values clamp visibly', () => {
  assert.deepEqual(reduceLimits().limits, executionLimits);
  assert.equal(reduceLimits({ timeoutMs: 1, outputBytes: 3 }).limits.timeoutMs, 1);
  const larger = reduceLimits({ timeoutMs: 120001, outputBytes: 32769 });
  assert.deepEqual(larger.limits, executionLimits);
  assert.deepEqual(larger.diagnostics, ['timeoutMs clamped to 120000', 'outputBytes clamped to 32768']);
  for (const value of [null, [], 1, { maxDepth: 2 }, { outputBytes: '3' }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 1.1 }, { timeoutMs: -1 }, { timeoutMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => reduceLimits(value));
    assert.throws(() => parseRequest({ agent: 'general-purpose', task: 't', limits: value }));
  }
});

test('admission remains held through stop and verification, then releases or quarantines', async () => {
  const registry = new RunRegistry();
  const first = registry.admit(root, 120000);
  try {
    assert.equal(first.state.kind, 'admitted');
    first.prepare(); first.run();
    first.cancel('user'); first.cancel('deadline');
    assert.equal(first.cancellation, 'user');
    first.stop({ kind: 'cancelled', reason: 'user' }); first.force();
    assert.equal(first.state.kind, 'forcedStop');
    assert.throws(() => registry.admit(root, 120000));
    first.verify();
    assert.throws(() => registry.admit(root, 120000));
  } finally { first.verify(); first.finish(true); }
  await first.done;
  const second = registry.admit(root, 120000);
  second.verify(); second.finish(false);
  assert.throws(() => registry.admit(root, 120000), /quarantined/);
});

test('shutdown freezes the first cause and awaits cleanup even during preparation', async () => {
  const registry = new RunRegistry();
  const lease = registry.admit(root, 120000);
  const shutdown = registry.shutdown();
  lease.cancel('user');
  assert.equal(lease.cancellation, 'parentShutdown');
  assert.throws(() => registry.admit(root, 120000), /shutting down/);
  lease.verify(); lease.finish(true);
  await shutdown; await registry.shutdown();
});

test('deadline cancels an admitted run', async () => {
  const lease = new RunRegistry().admit(root, 5);
  await new Promise((resolve) => lease.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(lease.cancellation, 'deadline');
  lease.verify(); lease.finish(true);
});

test('child transport drops stale pstack state and writes its own depth', () => {
  assert.deepEqual(childEnvironment(root, { PATH: '/poison', PSTACK_SUBAGENT_DEPTH: '999', PSTACK_RECURSION_TEST_CONFIG: 'stale', PSTACK_MAX_DEPTH: '9', PI_OFFLINE: '1' }), { PATH: '/poison', PI_OFFLINE: '1', PSTACK_SUBAGENT_DEPTH: '1' });
  assert.throws(() => childEnvironment(parseDepth('1')));
});

test('invocation pins canonical Node and the real Pi package bin, never PATH', async () => {
  const cli = fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));
  const invocation = await PiInvocation.resolve({ entrypoint: cli });
  assert.equal(invocation.node, await realpath(process.execPath));
  assert.equal(invocation.cli, await realpath(cli));
  for (const entrypoint of ['pi', '/missing', fileURLToPath(import.meta.url), cli.replace('cli.js', 'main.js')]) {
    await assert.rejects(PiInvocation.resolve({ entrypoint }), /Cannot validate/);
  }
});
