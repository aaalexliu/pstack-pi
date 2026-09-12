import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runPiSmoke } from './runner.mjs';
import { ProductionObserver } from './production-observer.mjs';

/** @param {Record<string, unknown>} request */
function tools(request) {
  assert.ok(Array.isArray(request.tools));
  return request.tools.map((tool) => tool.function.name);
}
/** @param {Record<string, unknown>} request @param {string} id */
function result(request, id) {
  assert.ok(Array.isArray(request.messages));
  const message = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(message, `Missing tool result ${id}`);
  return JSON.stringify(message.content);
}
/** @param {import('node:test').TestContext} t */
function observation(t) {
  const observer = new ProductionObserver();
  t.after(() => observer.rescue());
  return observer;
}
/** @param {import('node:test').TestContext} t @param {ProductionObserver} observer @param {import('./runner.mjs').PiTestRun} run */
async function verified(t, observer, run) {
  observer.verifyGone();
  assert.equal(run.timeout.expired, false);
  assert.deepEqual(run.cleanup.signals, []);
  await writeFile(path.join(run.paths.root, 'production-processes.json'), JSON.stringify(observer.report(), null, 2));
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, maxDepth: observer.maxDepth, peakLivePi: observer.peakLivePi, verifiedBeforeRescue: observer.verifiedBeforeRescue, pids: [...observer.identities.keys()], exit: run.exit }));
}

const delegate = { id: 'delegate', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Do the fixture task.' } };

test('packed leaf has no subagent and real Pi reports unknown tool when forced to call it', { timeout: 12000 }, async (t) => {
  const observer = observation(t);
  await runPiSmoke({ keepArtifacts: true, expectedRequests: 4, expectedText: 'Leaf-only verified.',
    onSpawn: (pid) => observer.start(pid),
    fixture: { script: [
      { reply: { kind: 'tool', ...delegate } },
      { reply: { kind: 'tool', id: 'nested', name: 'subagent', arguments: delegate.arguments }, check: (request) => {
        assert.ok(!tools(request).includes('subagent')); observer.sample();
      } },
      { reply: { kind: 'text', text: 'The child cannot delegate.' }, check: (request) => {
        assert.ok(!tools(request).includes('subagent'));
        assert.match(result(request, 'nested'), /subagent/);
        assert.match(result(request, 'nested'), /not found|Unknown|not available/i);
        observer.sample();
      } },
      { reply: { kind: 'text', text: 'Leaf-only verified.' }, check: (request) => assert.match(result(request, 'delegate'), /cannot delegate/) },
    ] },
    verify: async (run) => { assert.equal(observer.maxDepth, 1); assert.equal(observer.peakLivePi, 2); await verified(t, observer, run); },
  });
});

test('packed deadline returns after child cleanup before the outer watchdog', { timeout: 12000 }, async (t) => {
  const observer = observation(t);
  let childRequestedAt = 0;
  let returnedAt = 0;
  await runPiSmoke({ keepArtifacts: true, timeoutMs: 7000, expectedRequests: 3, expectedText: 'Deadline verified.',
    onSpawn: (pid) => observer.start(pid),
    fixture: { script: [
      { reply: { kind: 'tool', ...delegate, arguments: { ...delegate.arguments, limits: { timeoutMs: 1500 } } } },
      { reply: { kind: 'stall' }, check: (request) => { assert.ok(!tools(request).includes('subagent')); observer.sample(); childRequestedAt = Date.now(); } },
      { reply: { kind: 'text', text: 'Deadline verified.' }, check: (request) => {
        returnedAt = Date.now();
        assert.match(result(request, 'delegate'), /cancelled.*deadline/);
        assert.equal(observer.sample().filter((row) => row.pid !== observer.root).length, 0, 'Work survived tool return');
      } },
    ] },
    verify: async (run) => {
      assert.ok(childRequestedAt > 0);
      assert.ok(returnedAt - childRequestedAt < 3000);
      t.diagnostic(JSON.stringify({ childRequestToReturnMs: returnedAt - childRequestedAt, watchdogMs: 7000 }));
      await verified(t, observer, run);
    },
  });
});

test('packed simultaneous delegates admit one child and leave unrelated parent bash untouched', { timeout: 12000 }, async (t) => {
  const observer = observation(t);
  await runPiSmoke({ keepArtifacts: true, expectedRequests: 3, expectedText: 'Concurrency verified.',
    onSpawn: (pid) => observer.start(pid),
    fixture: { script: [
      { reply: { kind: 'tools', calls: [delegate, { ...delegate, id: 'second' }, { id: 'shell', name: 'bash', arguments: { command: 'printf "%s\\n" "literal git push and PR edit" > shell-survived.txt' } }] } },
      { reply: { kind: 'text', text: 'One leaf.' }, check: async (request) => { assert.ok(!tools(request).includes('subagent')); observer.sample(); await delay(250); } },
      { reply: { kind: 'text', text: 'Concurrency verified.' }, check: (request) => {
        assert.match(result(request, 'delegate'), /One leaf/);
        assert.match(result(request, 'second'), /already running or stopping/);
        result(request, 'shell');
      } },
    ] },
    verify: async (run) => {
      assert.equal(observer.peakLivePi, 2);
      assert.equal(await readFile(path.join(run.paths.cwd, 'shell-survived.txt'), 'utf8'), 'literal git push and PR edit\n');
      const ends = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.deepEqual(ends.map((event) => event.isError).sort(), [false, true]);
      await verified(t, observer, run);
    },
  });
});

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) {
  test(`parent PID ${signal} awaits packed child cleanup and preserves unrelated sibling`, { timeout: 12000 }, async (t) => {
    const observer = observation(t);
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => sibling.kill('SIGKILL'));
    let stoppedAt = 0;
    await runPiSmoke({ keepArtifacts: true, timeoutMs: 7000, expectedRequests: 2, expectedExit: { code: signal === 'SIGTERM' ? 143 : 129, signal: null },
      onSpawn: (pid) => observer.start(pid),
      fixture: { script: [
        { reply: { kind: 'tool', ...delegate } },
        { reply: { kind: 'stall' }, check: () => { observer.sample(); stoppedAt = Date.now(); process.kill(observer.root, signal); } },
      ] },
      verify: async (run) => {
        assert.ok(sibling.pid); process.kill(sibling.pid, 0);
        assert.ok(Date.now() - stoppedAt < 4000);
        t.diagnostic(JSON.stringify({ signal, signalToExitMs: Date.now() - stoppedAt, sibling: sibling.pid }));
        await verified(t, observer, run);
      },
    });
  });
}

for (const outcome of ['normal', 'shutdown']) {
  test(`packed child detached work is removed on ${outcome} before tool return or parent exit`, { timeout: 14000 }, async (t) => {
    const observer = observation(t);
    let descendant = 0;
    let workDoneAt = 0;
    let cwd = '';
    const script = [
      { reply: /** @type {const} */ ({ kind: 'tool', ...delegate }) },
      { reply: /** @type {const} */ ({ kind: 'tool', id: 'detach', name: 'bash', arguments: { command: `${JSON.stringify(process.execPath)} detached-work.mjs` } }) },
      { reply: outcome === 'normal' ? { kind: /** @type {const} */ ('text'), text: 'Detached work remains.' } : { kind: /** @type {const} */ ('stall') }, check: async () => {
        descendant = JSON.parse(await readFile(path.join(cwd, 'detached-pid.json'), 'utf8')).pid;
        assert.ok(observer.sample().some((row) => row.pid === descendant));
        workDoneAt = Date.now();
        if (outcome === 'shutdown') process.kill(observer.root, 'SIGTERM');
      } },
      ...(outcome === 'normal' ? [{ reply: { kind: /** @type {const} */ ('text'), text: 'Detached cleanup verified.' }, check: (/** @type {Record<string, unknown>} */ request) => {
        assert.match(result(request, 'delegate'), /surviving work/);
        assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
      } }] : []),
    ];
    await runPiSmoke({ keepArtifacts: true, timeoutMs: 9000, expectedRequests: script.length, expectedText: 'Detached cleanup verified.', expectedExit: { code: outcome === 'normal' ? 0 : 143, signal: null },
      onSpawn: (pid) => observer.start(pid),
      setup: async (paths) => {
        cwd = paths.cwd;
        await mkdir(path.join(paths.profile, 'agents'));
        await writeFile(path.join(paths.profile, 'agents/general-purpose.md'), '---\nname: general-purpose\ndescription: Detached fixture.\ntools: [bash]\n---\nRun the fixture command.');
        await copyFile(new URL('./fixtures/detached-work.mjs', import.meta.url), path.join(paths.cwd, 'detached-work.mjs'));
      },
      fixture: { script },
      verify: async (run) => {
        assert.ok(descendant > 0);
        assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
        assert.ok(Date.now() - workDoneAt < 4500);
        t.diagnostic(JSON.stringify({ outcome, descendant, cleanupMs: Date.now() - workDoneAt }));
        await verified(t, observer, run);
      },
    });
  });
}

test('packed child ignores fake pi at the front of PATH', { timeout: 12000 }, async (t) => {
  const observer = observation(t);
  /** @type {NodeJS.ProcessEnv} */
  const launchEnvironment = {};
  await runPiSmoke({ keepArtifacts: true, launchEnvironment, expectedRequests: 3, expectedText: 'Pinned Pi verified.',
    onSpawn: (pid) => observer.start(pid),
    setup: async (paths) => {
      const bin = path.join(paths.root, 'poison'); await mkdir(bin);
      const fake = path.join(bin, 'pi');
      await writeFile(fake, `#!/bin/sh\nprintf poison > ${JSON.stringify(path.join(paths.cwd, 'poison-ran'))}\n`); await chmod(fake, 0o755);
      launchEnvironment.PATH = `${bin}:${process.env.PATH}`;
    },
    fixture: { script: [
      { reply: { kind: 'tool', ...delegate } },
      { reply: { kind: 'text', text: 'Real pinned child.' }, check: () => { observer.sample(); } },
      { reply: { kind: 'text', text: 'Pinned Pi verified.' }, check: (request) => assert.match(result(request, 'delegate'), /Real pinned child/) },
    ] },
    verify: async (run) => {
      await assert.rejects(readFile(path.join(run.paths.cwd, 'poison-ran')), { code: 'ENOENT' });
      assert.equal(observer.peakLivePi, 2);
      await verified(t, observer, run);
    },
  });
});

for (const depth of ['01', '1']) {
  test(`packed depth ${depth} disables pstack but leaves parent bash available`, { timeout: 12000 }, async (t) => {
    const observer = observation(t);
    await runPiSmoke({ keepArtifacts: true, launchEnvironment: { PSTACK_SUBAGENT_DEPTH: depth }, expectedRequests: 3, expectedText: 'Depth rejected without a command gate.',
      onSpawn: (pid) => observer.start(pid),
      fixture: { script: [
        { reply: { kind: 'tool', ...delegate }, check: (request) => assert.ok(!tools(request).includes('subagent')) },
        { reply: { kind: 'tool', id: 'shell', name: 'bash', arguments: { command: 'printf untouched > unrelated.txt' } }, check: (request) => assert.match(result(request, 'delegate'), /not found|Unknown|not available/i) },
        { reply: { kind: 'text', text: 'Depth rejected without a command gate.' } },
      ] },
      verify: async (run) => {
        assert.equal(await readFile(path.join(run.paths.cwd, 'unrelated.txt'), 'utf8'), 'untouched');
        assert.equal(observer.peakLivePi, 1);
        await verified(t, observer, run);
      },
    });
  });
}
