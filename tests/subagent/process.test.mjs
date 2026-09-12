import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PiInvocation, parseProcessTable, processTable, processBackend } from '../../extensions/subagent/process.ts';
import { parseDepth, reduceLimits, RunRegistry } from '../../extensions/subagent/domain.ts';
import { resolveCwd, runChild } from '../../extensions/subagent/runner.ts';

const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
const fixture = fileURLToPath(new URL('./process-fixture.mjs', import.meta.url));
const agent = { name: 'test', description: 'Test', systemPrompt: 'PRIVATE_PROMPT', tools: [], provenance: { kind: /** @type {const} */ ('bundled'), path: '/test', sha256: 'a'.repeat(64) } };
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

for (const mode of ['ignore', 'orphan', 'detached', 'pipes', 'term-spawn']) {
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
    await gone(args.task);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(capture.depth, mode === 'ignore' ? '1' : capture.depth);
    const next = registry.admit(parseDepth(undefined), 1000);
    next.verify(); next.finish(true);
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
  test(`cleanup ${fault} failure quarantines admission and keeps errors private`, { timeout: 7000 }, async (t) => {
    const args = await setup(t, 'ignore');
    const registry = new RunRegistry();
    const lease = registry.admit(parseDepth(undefined), 500);
    let pid = 0;
    let injected = false;
    const backend = { ...args.backend,
      table: () => {
        const rows = processTable();
        if (pid && !injected) {
          injected = true;
          if (fault === 'ps') throw new Error('PRIVATE_PROCESS_DATA');
          if (fault === 'identity') return rows.map((row) => row.pid === pid ? { ...row, start: 'changed' } : row);
        }
        return rows;
      },
      signal: (/** @type {number} */ target, /** @type {NodeJS.Signals | 0} */ signal) => {
        if (fault === 'EPERM' && signal === 'SIGTERM') throw Object.assign(new Error('PRIVATE_PROCESS_DATA'), { code: 'EPERM' });
        processBackend.signal(target, signal);
      },
    };
    const running = runChild({ ...args, backend, lease });
    pid = (await started(args.task)).pid;
    const result = await running;
    assert.equal(result.kind, 'failed');
    assert.equal(result.cleanup.verified, false);
    assert.match(result.reason, /quarantined/);
    assert.throws(() => registry.admit(parseDepth(undefined), 500), /quarantined/);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
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
