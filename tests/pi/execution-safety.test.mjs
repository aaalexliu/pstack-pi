import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runPiSmoke } from './runner.mjs';
import { startConcurrentProvider } from './concurrent-provider.mjs';
import { FIXTURE_MODEL } from './provider.mjs';
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
/** @param {import('node:test').TestContext} t @param {number} [maxLivePi] */
function observation(t, maxLivePi = 2) {
  const observer = new ProductionObserver({ maxLivePi });
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
      { reply: { kind: 'tool', ...delegate, arguments: { ...delegate.arguments, timeoutMs: 1500 } } },
      { reply: { kind: 'stall' }, check: (request) => { assert.ok(!tools(request).includes('subagent')); observer.sample(); childRequestedAt = Date.now(); } },
      { reply: { kind: 'text', text: 'Deadline verified.' }, check: (request) => {
        returnedAt = Date.now();
        assert.match(result(request, 'delegate'), /Timed out after 1500 ms/);
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

test('packed simultaneous delegates both run as separate children and leave unrelated parent bash untouched', { timeout: 15000 }, async (t) => {
  const observer = observation(t, 3);
  const prompt = 'simultaneous-parent';
  const arrived = new Set();
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [
    { marker: prompt, steps: [
      { model: FIXTURE_MODEL, reply: { kind: 'tools', calls: [{ ...delegate, arguments: { agent: 'general-purpose', task: 'leaf-one' } }, { ...delegate, id: 'second', arguments: { agent: 'general-purpose', task: 'leaf-two' } }, { id: 'shell', name: 'bash', arguments: { command: 'printf "%s\\n" "literal git push and PR edit" > shell-survived.txt' } }] } },
      { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Concurrency verified.' }, check: (request) => {
        assert.equal(arrived.size, 2);
        assert.match(result(request, 'delegate'), /Leaf one/);
        assert.match(result(request, 'second'), /Leaf two/);
        result(request, 'shell');
      } },
    ] },
    ...['leaf-one', 'leaf-two'].map((marker, index) => ({ marker, steps: [{ model: FIXTURE_MODEL, reply: /** @type {const} */ ({ kind: 'text', text: index === 0 ? 'Leaf one.' : 'Leaf two.' }), check: async (/** @type {Record<string, unknown>} */ request) => {
      assert.ok(!tools(request).includes('subagent'));
      arrived.add(marker);
      const deadline = Date.now() + 4000;
      while (arrived.size < 2 && Date.now() < deadline) await delay(20);
      assert.equal(arrived.size, 2, 'Both children must be live at once');
      observer.sample();
    } }] })),
  ];
  await runPiSmoke({ keepArtifacts: true, prompt, startFixture: () => startConcurrentProvider(routes), expectedRequests: 4, expectedText: 'Concurrency verified.',
    onSpawn: (pid) => observer.start(pid),
    verify: async (run) => {
      assert.equal(observer.peakLivePi, 3);
      assert.equal(await readFile(path.join(run.paths.cwd, 'shell-survived.txt'), 'utf8'), 'literal git push and PR edit\n');
      const ends = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.deepEqual(ends.map((event) => event.isError), [false, false]);
      await verified(t, observer, run);
    },
  });
});

test('packed parallel tasks run four at a time, keep input order, and one failure does not cancel siblings', { timeout: 25000 }, async (t) => {
  const observer = observation(t, 5);
  const prompt = 'mixed-parallel-parent';
  const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'general-purpose', task: `mixed-child-${index}` }));
  const arrived = new Set();
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'mixed', name: 'subagent', arguments: { tasks } } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Sibling isolation verified.' }, check: (payload) => {
      assert.equal(arrived.size, 8);
      assert.match(result(payload, 'mixed'), /Parallel: 7\/8 succeeded/);
      assert.equal(observer.sample().length, 1, 'Child survived tool return');
    } },
  ] }, ...tasks.map((task, index) => {
    /** @type {import('./concurrent-provider.mjs').ConcurrentStep[]} */
    const steps = [{ model: FIXTURE_MODEL,
      reply: index === 0 ? { kind: 'failure' } : index === 2 ? { kind: 'tool', id: 'nested', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Do not run.' } } : { kind: 'text', text: `result-${index}` },
      check: async (payload) => {
        assert.ok(!tools(payload).includes('subagent'));
        arrived.add(index);
        if (index < 4) {
          const deadline = Date.now() + 4000;
          while (arrived.size < 4 && Date.now() < deadline) await delay(20);
          assert.ok(arrived.size >= 4, 'The first four children run together');
          observer.sample();
        }
      },
    }];
    if (index === 2) steps.push({ model: FIXTURE_MODEL, reply: { kind: 'text', text: 'The leaf cannot delegate.' }, check: (payload) => { assert.match(result(payload, 'nested'), /not found|Unknown|not available/i); } });
    return { marker: task.task, steps };
  })];
  await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 11, expectedText: 'Sibling isolation verified.', keepArtifacts: true,
    onSpawn: (pid) => observer.start(pid),
    verify: async (run) => {
      const event = run.events.find((event) => event.type === 'tool_execution_end' && event.toolCallId === 'mixed');
      assert.ok(event && event.isError === false, 'A partial failure stays a usable result');
      const details = /** @type {import('../../extensions/subagent/index.ts').SubagentDetails} */ (/** @type {any} */ (event.result).details);
      assert.equal(details.mode, 'parallel');
      assert.deepEqual(details.results.map((r) => r.task), tasks.map((task) => task.task));
      assert.deepEqual(details.results.map((r) => r.stopReason), ['error', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop']);
      assert.deepEqual([...(/** @type {any} */ (event.result).content[0].text).matchAll(/### \[general-purpose\] (\w+)/g)].map((match) => match[1]), ['failed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
      assert.equal(observer.peakLivePi, 5);
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
