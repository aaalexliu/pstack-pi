import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OwnedProcessTree, PiInvocation, cleanupLimits, parseProcessTable, processTable, processBackend } from '../../extensions/subagent/process.ts';
import { parseDepth, reduceLimits, RunRegistry } from '../../extensions/subagent/domain.ts';
import { resolveCwd, runChild } from '../../extensions/subagent/runner.ts';

const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
const fixture = fileURLToPath(new URL('./process-fixture.mjs', import.meta.url));
const agent = { name: 'test', description: 'Test', systemPrompt: 'PRIVATE_PROMPT', tools: [], provenance: { kind: /** @type {const} */ ('bundled'), path: '/test', sha256: 'a'.repeat(64) } };
/** @type {import('../../extensions/subagent/model-runtime.ts').ChildModel} */
const model = { provider: 'fixture', id: 'model', thinkingLevel: 'off' };

/** @param {import('node:test').TestContext} t @param {string} mode */
async function setup(t, mode) {
  const cwd = await resolveCwd({ current: await mkdtemp(path.join(await realpath(tmpdir()), 'process-test-')) });
  const marker = path.join(cwd, 'started.json');
  const backend = { ...processBackend, spawn: (/** @type {PiInvocation} */ _invocation, /** @type {string[]} */ args, /** @type {import('node:child_process').SpawnOptionsWithoutStdio} */ options) => spawn(process.execPath, [fixture, mode, ...args], options) };
  t.after(async () => {
    try {
      const capture = JSON.parse(await readFile(marker, 'utf8'));
      for (const pid of [capture.pid, ...capture.descendants]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  return { identity: { id: 'test', agent: { name: agent.name, provenance: agent.provenance }, cwd }, agent, model, task: marker, invocation, backend, signal: undefined };
}

/** @param {string} marker */
async function started(marker) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(marker, 'utf8')); } catch { await delay(10); }
  }
  throw new Error('Child did not start');
}

/** @param {string} marker */
async function gone(marker) {
  const capture = await started(marker);
  for (const pid of [capture.pid, ...capture.descendants]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(capture.promptFile), { code: 'ENOENT' });
  return capture;
}

test('process table is bounded and strict, and reads the real host identity', () => {
  assert.ok(processTable().some((row) => row.pid === process.pid));
  const row = ' 12 1 12 Mon Jan  1 00:00:00 2024\n';
  assert.equal(parseProcessTable(row)[0].start, 'Mon Jan 1 00:00:00 2024');
  for (const invalid of ['', row.trim(), row + row, row.replace('12 1', '0 1'), row.replace('Mon', '???'), row + 'truncated', 'x'.repeat(4 * 1024 * 1024 + 1)]) assert.throws(() => parseProcessTable(invalid));
});

for (const mode of ['ignore', 'orphan', 'detached', 'pipes', 'term-spawn', 'malformed-wait']) {
  test(`owned cleanup handles ${mode} before return without runner rescue`, { timeout: 6000 }, async (t) => {
    const args = await setup(t, mode);
    const controller = new AbortController();
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 2000);
    const running = runChild({ ...args, lease, signal: controller.signal });
    const capture = await started(args.task);
    if (['ignore', 'term-spawn'].includes(mode)) controller.abort();
    const result = await running;
    assert.notEqual(result.kind, 'succeeded');
    assert.equal(result.cleanup.verified, true, JSON.stringify(result));
    assert.equal(result.cleanup.forced, true);
    assert.ok(result.cleanup.durationMs < 3500);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    await gone(args.task);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(capture.depth, mode === 'ignore' ? '1' : capture.depth);
    const next = registry.admit(parseDepth(undefined), 1000);
    next.verify(); next.finish();
    t.diagnostic(JSON.stringify({ mode, result: result.kind, ...result.cleanup }));
  });
}

test('deadline owns an ignored-SIGTERM child while an unrelated sibling stays alive', { timeout: 6000 }, async (t) => {
  const args = await setup(t, 'ignore');
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => sibling.kill('SIGKILL'));
  assert.ok(sibling.pid);
  const startedAt = Date.now();
  const result = await runChild({ ...args, limits: reduceLimits({ timeoutMs: 500 }).limits });
  assert.equal(result.kind, 'cancelled');
  assert.match(result.reason, /deadline/);
  assert.equal(result.cleanup.verified, true);
  assert.ok(Date.now() - startedAt < 3500);
  process.kill(sibling.pid, 0);
  await gone(args.task);
  t.diagnostic(JSON.stringify({ elapsedMs: Date.now() - startedAt, cleanup: result.cleanup }));
});

for (const fault of ['ps', 'EPERM', 'identity']) {
  test(`a ${fault} fault keeps errors private, reports honestly, and leaves later admission open`, { timeout: 7000 }, async (t) => {
    const args = await setup(t, 'ignore');
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 500);
    let pid = 0;
    let injected = false;
    /** @type {typeof args.backend.spawn} */
    const spawnChild = (...inputs) => {
      const child = args.backend.spawn(...inputs);
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        if (fault === 'EPERM' && signal === 'SIGTERM') {
          child.emit('error', Object.assign(new Error('PRIVATE_PROCESS_DATA'), { code: 'EPERM', syscall: 'kill' }));
          return false;
        }
        return kill(signal);
      };
      return child;
    };
    const backend = { ...args.backend, spawn: spawnChild,
      table: () => {
        const rows = processTable();
        if (pid && !injected) {
          injected = true;
          if (fault === 'ps') throw new Error('PRIVATE_PROCESS_DATA');
          if (fault === 'identity') return rows.map((row) => row.pid === pid ? { ...row, start: 'changed' } : row);
        }
        return rows;
      },
    };
    const running = runChild({ ...args, backend, lease });
    pid = (await started(args.task)).pid;
    const result = await running;
    t.diagnostic(JSON.stringify({ fault, kind: result.kind, cleanup: result.cleanup, diagnostics: result.diagnostics }));
    assert.equal(result.kind, 'cancelled', 'One bad snapshot must not stop the child; the deadline does');
    assert.match(result.reason, /deadline/);
    if (fault === 'EPERM') {
      assert.equal(result.cleanup.verified, false);
      assert.deepEqual(result.diagnostics, ['Child process cleanup could not be verified']);
    } else {
      assert.equal(result.cleanup.verified, true);
      assert.deepEqual(result.diagnostics, []);
    }
    await gone(args.task);
    assert.equal(lease.state.kind, 'finished');
    const next = registry.admit(parseDepth(undefined), 500);
    next.verify(); next.finish();
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
  });
}

test('continuous observation failure kills the live child before cleanup returns', { timeout: 7000 }, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'unobserved-child-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const marker = path.join(cwd, 'started.json');
  const child = spawn(process.execPath, [fixture, 'unobserved', marker], { detached: true, stdio: 'pipe' });
  /** @type {[number | undefined, NodeJS.Signals | number | undefined][]} */
  const signals = [];
  const kill = child.kill.bind(child);
  child.kill = (signal) => { signals.push([child.pid, signal]); return kill(signal); };
  try {
    const { pid } = await started(marker);
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 5000);
    lease.prepare(); lease.run();
    let polls = 0;
    const owner = new OwnedProcessTree({ invocation, args: [], cwd, env: {}, lease, backend: {
      spawn: () => child,
      table: () => {
        if (polls++ === 0) return processTable();
        throw new Error('PRIVATE_PS_FAILURE');
      },
      signal: (target, signal) => { signals.push([target, signal]); processBackend.signal(target, signal); },
    } });
    await delay(cleanupLimits.pollMs * 3);
    assert.equal(lease.state.kind, 'running', 'Failed snapshots must not stop a running child');
    const report = await owner.cleanup();
    let alive = true;
    try { process.kill(pid, 0); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') alive = false;
      else throw error;
    }
    t.diagnostic(JSON.stringify({ pid, aliveBeforeRescue: alive, failedPolls: polls - 1, signals, report }));
    assert.equal(alive, false, 'direct child must be gone before return, without test rescue');
    assert.deepEqual(signals, [[pid, 'SIGTERM'], [-pid, 'SIGKILL'], [pid, 'SIGKILL']]);
    assert.equal(report.verified, false);
    assert.equal(report.forced, true);
    lease.finish();
    registry.admit(parseDepth(undefined), 500);
  } finally {
    if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
  }
});

/** @param {string} fault */
function fakeUnsettledProcess(fault) {
  const root = 800001;
  const host = { pid: process.pid, ppid: 1, pgid: 800000, start: 'Mon Jan 1 00:00:00 2024' };
  let rows = [host, { ...host, pid: root, ppid: process.pid, pgid: root }];
  /** @type {[PassThrough, PassThrough, PassThrough, undefined, undefined]} */
  const stdio = [new PassThrough(), new PassThrough(), new PassThrough(), undefined, undefined];
  const child = Object.assign(new ChildProcess(), { pid: root, stdin: stdio[0], stdout: stdio[1], stderr: stdio[2], stdio });
  /** @type {[number, NodeJS.Signals | number | undefined][]} */
  const signals = [];
  const denied = () => Object.assign(new Error('PRIVATE_KILL_FAILURE'), { code: 'EPERM', syscall: 'kill' });
  child.kill = (signal) => {
    signals.push([root, signal]);
    if (fault === 'false') return false;
    if (fault === 'EPERM') throw denied();
    if (fault === 'EPERM-event') { child.emit('error', denied()); return false; }
    if (fault === 'missing-exit' || fault === 'missing-close' || fault === 'false-after-exit') {
      rows = [host];
      queueMicrotask(() => {
        Object.defineProperty(child, 'signalCode', { value: 'SIGTERM', configurable: true });
        if (fault !== 'missing-exit') child.emit('exit', null, 'SIGTERM');
        if (fault !== 'missing-close') child.emit('close', null, 'SIGTERM');
      });
    }
    return fault !== 'false-after-exit';
  };
  let polls = 0;
  /** @type {import('../../extensions/subagent/process.ts').ProcessBackend} */
  const backend = {
    spawn: () => child,
    table: () => {
      if (polls++ > 0 && fault === 'observation') throw new Error('PRIVATE_PS_FAILURE');
      return rows;
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (fault === 'EPERM' || fault === 'EPERM-event') throw denied();
    },
  };
  return { child, backend, signals };
}

const cleanupUpperMs = cleanupLimits.graceMs + cleanupLimits.verifyMs + 500;
for (const fault of ['false', 'EPERM', 'EPERM-event', 'missing-events', 'missing-exit', 'missing-close', 'observation', 'force-error', 'false-after-exit']) {
  test(`bounded cleanup reports ${fault} as unverified without rescue`, { timeout: cleanupUpperMs + 1000 }, async (t) => {
    const { child, backend, signals } = fakeUnsettledProcess(fault);
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 10_000);
    lease.prepare(); lease.run();
    if (fault === 'force-error') lease.force = () => { throw new Error('PRIVATE_FORCE_FAILURE'); };
    const owner = new OwnedProcessTree({ invocation, args: [], cwd: process.cwd(), env: {}, lease, backend });
    const startedAt = performance.now();
    owner.requestStop({ kind: 'cancelled', reason: 'user' });
    const cleaning = owner.cleanup();
    assert.equal(owner.cleanup(), cleaning);
    const report = await cleaning;
    const elapsedMs = performance.now() - startedAt;
    lease.finish();
    t.diagnostic(JSON.stringify({ fault, elapsedMs, signals: signals.length, report }));
    assert.ok(elapsedMs < cleanupUpperMs, `cleanup took ${elapsedMs} ms`);
    assert.ok(Math.abs(report.durationMs - elapsedMs) < 100, 'report includes all cleanup waits');
    assert.equal(report.verified, false);
    assert.equal(lease.state.kind, 'finished');
    registry.admit(parseDepth(undefined), 500);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
    if (['false', 'EPERM', 'EPERM-event', 'missing-events', 'observation', 'force-error'].includes(fault)) {
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.ok(signals.filter(([pid, signal]) => pid === child.pid && signal === 'SIGKILL').length > 1, 'retry direct child within the bound');
    }
    const count = signals.length;
    await delay(cleanupLimits.pollMs * 2);
    assert.equal(signals.length, count, 'no background retries after return');
  });
}

for (const fault of ['false', 'EPERM', 'missing-events', 'missing-close']) {
  test(`session shutdown completes with ${fault} cleanup reported unverified without rescue`, { timeout: cleanupUpperMs + 1000 }, async (t) => {
    const { child, backend } = fakeUnsettledProcess(fault);
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 10_000);
    const inputFinished = new Promise((resolve) => child.stdin.once('finish', resolve));
    const cwd = await resolveCwd({ current: process.cwd() });
    const running = runChild({ identity: { id: 'test', agent: { name: agent.name, provenance: agent.provenance }, cwd }, agent, model, task: 'test', invocation, backend, lease, signal: undefined });
    await inputFinished;
    const startedAt = performance.now();
    await registry.shutdown();
    const elapsedMs = performance.now() - startedAt;
    const result = await running;
    t.diagnostic(JSON.stringify({ fault, elapsedMs, result }));
    assert.ok(elapsedMs < cleanupUpperMs, `shutdown took ${elapsedMs} ms`);
    assert.equal(result.cleanup.verified, false);
    assert.equal(result.kind, 'cancelled');
    assert.match(result.reason, /parentShutdown/);
    assert.deepEqual(result.diagnostics, ['Child process cleanup could not be verified']);
    assert.equal(lease.state.kind, 'finished');
    assert.equal(lease.cancellation, 'parentShutdown');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    const settledAt = performance.now();
    await registry.shutdown();
    assert.ok(performance.now() - settledAt < 100);
  });
}

for (const reuse of ['initial', 'detached', 'member-moved', 'unobserved-root', 'leader-reused']) {
  test(`previously owned ${reuse} group cannot adopt or signal a reused group`, { timeout: 5000 }, async (t) => {
    const root = 800001;
    const group = ['initial', 'unobserved-root'].includes(reuse) ? root : 800002;
    const stranger = reuse === 'unobserved-root' ? root : reuse === 'leader-reused' ? group : 800004;
    /** @type {(pid: number, ppid: number, pgid: number, start?: string) => import('../../extensions/subagent/process.ts').ProcessIdentity} */
    const identity = (pid, ppid, pgid, start = 'Mon Jan 1 00:00:00 2024') => ({ pid, ppid, pgid, start });
    const host = identity(process.pid, 1, 800000);
    /** @type {[PassThrough, PassThrough, PassThrough, undefined, undefined]} */
    const stdio = [new PassThrough(), new PassThrough(), new PassThrough(), undefined, undefined];
    const child = Object.assign(new ChildProcess(), { pid: root, stdin: stdio[0], stdout: stdio[1], stderr: stdio[2], stdio });
    /** @type {[number, NodeJS.Signals | number | undefined][]} */
    const signals = [];
    child.kill = (signal) => { signals.push([root, signal]); return true; };
    let rows = reuse === 'unobserved-root' ? [host] : [host, identity(root, process.pid, root)];
    if (group !== root) rows.push(identity(group, root, group), identity(800003, group, group));
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 5000);
    lease.prepare(); lease.run();
    const owner = new OwnedProcessTree({ invocation, args: [], cwd: process.cwd(), env: {}, lease, backend: {
      spawn: () => child,
      table: () => rows,
      signal: (target, signal) => {
        signals.push([target, signal]);
        if (signal === 'SIGKILL') rows = rows.filter((row) => row.pid !== target);
        if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
    } });
    Object.defineProperty(child, 'exitCode', { value: 0 });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    rows = [host, identity(stranger, 1, group, 'Tue Jan 2 00:00:00 2024')];
    if (reuse === 'member-moved') rows.push(identity(800003, 1, 800005));
    const report = await owner.cleanup();
    lease.finish();
    t.diagnostic(JSON.stringify({ reuse, signals, identities: report.identities }));
    assert.ok(!report.identities.some((row) => row.pid === stranger && row.start === 'Tue Jan 2 00:00:00 2024'), 'group ID alone must not adopt a stranger');
    assert.ok(!signals.some(([target]) => target === stranger || target === -group), 'no signal may target the reused group or its stranger');
    assert.ok(rows.some((row) => row.pid === stranger), 'unrelated process survives cleanup');
  });
}

test('fake pi first in PATH cannot run through a validated invocation', { timeout: 5000 }, async (t) => {
  const args = await setup(t, 'ignore');
  const fake = path.join(args.identity.cwd, 'pi');
  await writeFile(fake, '#!/bin/sh\ntouch "' + path.join(args.identity.cwd, 'poison-ran') + '"\n');
  await chmod(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = args.identity.cwd;
  t.after(() => { process.env.PATH = previous; });
  const result = await runChild({ ...args, backend: processBackend, limits: reduceLimits({ timeoutMs: 100 }).limits });
  assert.equal(result.cleanup.verified, true);
  await assert.rejects(readFile(path.join(args.identity.cwd, 'poison-ran')), { code: 'ENOENT' });
});
