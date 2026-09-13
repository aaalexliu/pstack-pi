import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FIXTURE_KEY, FIXTURE_MODEL } from './provider.mjs';
import { runPiSmoke } from './runner.mjs';
import { startConcurrentProvider } from './concurrent-provider.mjs';
import { ProductionObserver } from './production-observer.mjs';

const alpha = 'org/alpha:tag';
const beta = 'beta';
const gamma = 'gamma';
/** @param {import('./runner.mjs').PiTestRun['paths']} paths @param {string} baseUrl */
async function configureModels(paths, baseUrl) {
  const provider = { baseUrl, api: 'openai-completions', apiKey: FIXTURE_KEY, compat: { supportsReasoningEffort: true } };
  await writeFile(path.join(paths.profile, 'models.json'), JSON.stringify({ providers: {
    'pi-fixture': { ...provider, models: [{ id: FIXTURE_MODEL, reasoning: true }, { id: alpha, reasoning: true }] },
    'pi-other': { ...provider, models: [{ id: beta, reasoning: true }, { id: gamma, reasoning: true }] },
  } }));
}
/** @param {import('./runner.mjs').PiTestRun['paths']} paths @param {Record<string, string[]>} roles */
async function configureRoles(paths, roles) {
  await mkdir(path.join(paths.profile, 'pstack-pi'));
  await writeFile(path.join(paths.profile, 'pstack-pi/models.json'), JSON.stringify({ version: 1, roles }));
}
/** @param {Record<string, unknown>} payload @param {string} id */
function resultIn(payload, id) {
  assert.ok(Array.isArray(payload.messages));
  const result = payload.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result);
  return JSON.stringify(result.content);
}
/** @param {import('./runner.mjs').PiEvent} event */
function batchResult(event) {
  assert.ok(event.result && typeof event.result === 'object');
  return /** @type {{content: {text: string}[], details?: {kind: string, tasks: {id: string, kind: string, usage: null, limits: {outputBytes: number}, model: {requested: unknown, selection: {source: string}, resolved: {provider: string, id: string, thinkingLevel: string}, observed: {provider: string, id: string}}, output: {bytes: number, truncated: boolean}, cleanup: {verified: boolean}}[]}}} */ (event.result);
}

/** @param {() => boolean | Promise<boolean>} predicate */
async function until(predicate) {
  const end = Date.now() + 11000;
  while (Date.now() < end) { if (await predicate()) return; await delay(20); }
  assert.fail('Concurrent proof did not reach its bounded condition');
}
/** @param {Record<string, unknown>} payload */
function leaf(payload) {
  assert.ok(Array.isArray(payload.tools));
  assert.ok(!payload.tools.some((tool) => tool.function.name === 'subagent'));
}
/** @param {import('node:test').TestContext} t */
function observerFor(t) {
  const observer = new ProductionObserver({ maxLivePi: 5 });
  t.after(() => observer.rescue());
  return observer;
}
/** @param {ProductionObserver} observer */
function livePi(observer) { observer.sample(); return observer.samples.at(-1)?.piPids.length ?? 0; }
/** @param {import('node:test').TestContext} t @param {ProductionObserver} observer @param {import('./runner.mjs').PiTestRun} run */
async function evidence(t, observer, run) {
  observer.verifyGone();
  assert.equal(observer.maxDepth, 1);
  assert.equal(observer.peakLivePi, 5);
  assert.equal(run.timeout.expired, false);
  assert.deepEqual(run.cleanup.signals, []);
  assert.ok(!(await readdir(run.paths.root)).some((name) => name.startsWith('pstack-subagent-')));
  await writeFile(path.join(run.paths.root, 'parallel-processes.json'), JSON.stringify(observer.report(), null, 2));
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, peakLivePi: observer.peakLivePi, maxDepth: observer.maxDepth, verifiedBeforeRescue: observer.verifiedBeforeRescue, requests: run.provider?.requests, inventory: run.pack.files }));
}

test('packed relocated Pi holds four children, completes in reverse, and returns input order', { timeout: 20000 }, async (t) => {
  const observer = observerFor(t);
  const prompt = 'parallel-parent';
  const tasks = Array.from({ length: 4 }, (_, index) => ({ agent: 'general-purpose', task: `parallel-child-${index}`, role: 'feature' }));
  const models = [alpha, FIXTURE_MODEL, alpha, beta];
  const arrived = new Set();
  /** @type {number[]} */
  const completed = [];
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'batch', name: 'subagent', arguments: { tasks } } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Parallel order verified.' }, check: () => {
      assert.deepEqual(completed, [3, 2, 1, 0]);
      assert.equal(livePi(observer), 1, 'Child survived tool return');
    } },
  ] }, ...tasks.map((task, index) => ({ marker: task.task, steps: [{ model: models[index],
    reply: { kind: /** @type {const} */ ('text'), text: `output-${index}` }, check: async (/** @type {Record<string, unknown>} */ payload) => {
      leaf(payload);
      assert.equal(payload.reasoning_effort, index === 1 ? 'high' : undefined);
      arrived.add(index);
      await until(() => arrived.size === 4);
      await until(() => livePi(observer) === index + 2);
      completed.push(index);
    },
  }] }))];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 6, expectedText: 'Parallel order verified.', keepArtifacts: true,
    configureModels, thinkingLevel: 'high', setup: (paths) => configureRoles(paths, { feature: [`pi-fixture/${alpha}`, 'inherit-parent', `pi-fixture/${alpha}`, `pi-other/${beta}`] }),
    onSpawn: (pid) => observer.start(pid),
    verify: async (run) => {
      const event = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.ok(event && event.isError === false);
      const result = batchResult(event);
      assert.ok(result.details);
      assert.equal(result.details.kind, 'parallel');
      assert.deepEqual(result.details.tasks.map((task) => task.model.resolved.id), models);
      assert.deepEqual(result.details.tasks.map((task) => task.model.observed.id), models);
      assert.deepEqual(result.details.tasks.map((task) => task.id), ['batch/1', 'batch/2', 'batch/3', 'batch/4']);
      assert.ok(result.details.tasks.every((task) => task.kind === 'succeeded' && task.usage === null));
      assert.deepEqual([...result.content[0].text.matchAll(/output-([0-3])/g)].map((match) => Number(match[1])), [0, 1, 2, 3]);
      await evidence(t, observer, run);
    },
  });
  t.diagnostic(JSON.stringify({ completed, returned: [0, 1, 2, 3], assignments: models, requests: run.provider?.requests }));
});

test('eight packed tasks replace cleaned slots in FIFO order and preserve independent role cursors across requests', { timeout: 25000 }, async (t) => {
  const observer = observerFor(t);
  const prompt = 'fifo-parent';
  const choices = [
    { role: 'feature' }, { role: 'review' }, { role: 'feature' }, { role: 'feature', model: `pi-other/${gamma}` },
    { role: 'feature' }, { role: 'review' }, { role: 'feature' }, { role: 'feature' },
  ];
  const expected = [alpha, beta, FIXTURE_MODEL, gamma, alpha, FIXTURE_MODEL, beta, alpha];
  const nextModels = [FIXTURE_MODEL, beta, alpha];
  const tasks = choices.map((choice, index) => ({ agent: 'general-purpose', task: `fifo-child-${index}`, ...choice }));
  const later = ['feature', 'review', 'feature'].map((role, index) => ({ agent: 'general-purpose', task: `later-child-${index}`, role }));
  /** @type {number[]} */
  const arrivals = [];
  let root = '';
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tools', calls: [
      { id: 'eight', name: 'subagent', arguments: { tasks, limits: { outputBytes: 67 } } },
      { id: 'overlap', name: 'subagent', arguments: { tasks: [tasks[0]] } },
      { id: 'shell', name: 'bash', arguments: { command: 'printf "%s\\n" "literal git push and PR edit" > parallel-shell.txt' } },
    ] } },
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'later', name: 'subagent', arguments: { tasks: later } }, check: (payload) => {
      assert.match(resultIn(payload, 'overlap'), /already running or stopping/);
      assert.deepEqual(arrivals.slice(4), [4, 5, 6, 7]);
      assert.equal(livePi(observer), 1);
    } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Eight FIFO assignments verified.' } },
  ] }, ...tasks.map((task, index) => ({ marker: task.task, steps: [{ model: expected[index],
    reply: { kind: /** @type {const} */ ('text'), text: `R${index}:` + '✓'.repeat(3000) }, check: async (/** @type {Record<string, unknown>} */ payload) => {
      leaf(payload);
      assert.equal(payload.reasoning_effort, expected[index] === FIXTURE_MODEL ? 'high' : undefined);
      arrivals.push(index);
      assert.ok((await readdir(root)).filter((name) => name.startsWith('pstack-subagent-')).length <= 4, 'A slot outlived its prompt cleanup');
      if (index === 0) await until(() => arrivals.length === 4);
      else if (index < 4) await until(() => arrivals.includes(index + 3));
      else {
        await until(() => arrivals.includes(7));
        await until(() => livePi(observer) === index - 2);
      }
    },
  }] })), ...later.map((task, index) => ({ marker: task.task, steps: [{ model: nextModels[index],
    reply: { kind: /** @type {const} */ ('text'), text: `later-${index}` }, check: leaf,
  }] }))];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 14, expectedText: 'Eight FIFO assignments verified.', keepArtifacts: true,
    configureModels, thinkingLevel: 'high', timeoutMs: 18000, onSpawn: (pid) => observer.start(pid),
    setup: async (paths) => {
      root = paths.root;
      await configureRoles(paths, { feature: [`pi-fixture/${alpha}`, 'inherit-parent', `pi-fixture/${alpha}`, `pi-other/${beta}`], review: [`pi-other/${beta}`, 'inherit-parent'] });
    },
    verify: async (run) => {
      assert.equal(await readFile(path.join(run.paths.cwd, 'parallel-shell.txt'), 'utf8'), 'literal git push and PR edit\n');
      const events = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.equal(events.length, 3);
      const event = events.find((event) => event.toolCallId === 'eight');
      assert.ok(event && event.isError === false);
      const result = batchResult(event);
      assert.ok(result.details);
      assert.deepEqual(result.details.tasks.map((task) => task.model.resolved.id), expected);
      assert.deepEqual(result.details.tasks.map((task) => task.model.observed.id), expected);
      assert.deepEqual(result.details.tasks.map((task) => task.limits.outputBytes), [9, 9, 9, 8, 8, 8, 8, 8]);
      assert.ok(result.details.tasks.every((task) => task.output.bytes === 9003 && task.output.truncated && task.cleanup.verified));
      assert.deepEqual([...result.content[0].text.matchAll(/R([0-7]):/g)].map((match) => Number(match[1])), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
      assert.ok(!JSON.stringify(result.details).includes('✓'));
      const next = events.find((event) => event.toolCallId === 'later');
      assert.ok(next && next.isError === false);
      const nextResult = batchResult(next);
      assert.ok(nextResult.details);
      assert.deepEqual(nextResult.details.tasks.map((task) => task.model.resolved.id), nextModels);
      await evidence(t, observer, run);
    },
  });
  t.diagnostic(JSON.stringify({ arrivals, assignments: expected, nextRequest: nextModels, requests: run.provider?.requests }));
});

test('one packed deadline cancels four active children, skips four queued tasks, and keeps all eight assignments consumed', { timeout: 20000 }, async (t) => {
  const observer = observerFor(t);
  const prompt = 'deadline-parent';
  const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'general-purpose', task: `deadline-child-${index}`, role: 'feature' }));
  const expected = [alpha, FIXTURE_MODEL, beta, alpha, FIXTURE_MODEL, beta, alpha, FIXTURE_MODEL];
  const arrived = new Set();
  let allActiveAt = 0;
  let returnedAt = 0;
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'deadline', name: 'subagent', arguments: { tasks, limits: { timeoutMs: 4000 } } } },
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'after', name: 'subagent', arguments: { agent: 'general-purpose', task: 'after-deadline', role: 'feature' } }, check: (payload) => {
      returnedAt = Date.now();
      assert.equal(livePi(observer), 1);
      assert.match(resultIn(payload, 'deadline'), /cancelled.*deadline/);
    } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Deadline queue verified.' } },
  ] }, ...tasks.map((task, index) => ({ marker: task.task, steps: [{ model: expected[index], reply: { kind: /** @type {const} */ ('stall') }, check: (/** @type {Record<string, unknown>} */ payload) => {
    leaf(payload);
    assert.ok(index < 4, 'Queued task reached provider after cancellation');
    arrived.add(index);
    if (arrived.size === 4) { allActiveAt = Date.now(); assert.equal(livePi(observer), 5); }
  } }] })), { marker: 'after-deadline', steps: [{ model: beta, reply: { kind: 'text', text: 'Queued assignments were consumed.' }, check: leaf }] }];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 8, expectedText: 'Deadline queue verified.', keepArtifacts: true,
    configureModels, thinkingLevel: 'high', timeoutMs: 12000, onSpawn: (pid) => observer.start(pid),
    setup: (paths) => configureRoles(paths, { feature: [`pi-fixture/${alpha}`, 'inherit-parent', `pi-other/${beta}`] }),
    verify: async (run) => {
      assert.equal(arrived.size, 4);
      assert.ok(allActiveAt > 0 && returnedAt > allActiveAt && returnedAt - allActiveAt < 6000);
      const event = run.events.find((event) => event.type === 'tool_execution_end' && event.toolCallId === 'deadline');
      assert.ok(event && event.isError === true);
      const result = batchResult(event);
      assert.deepEqual(result.details, {}, 'Pi supplies empty error details, not batch metadata');
      assert.deepEqual([...result.content[0].text.matchAll(/\[\d\] general-purpose (\w+)/g)].map((match) => match[1]), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'skipped', 'skipped', 'skipped', 'skipped']);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 4096);
      await evidence(t, observer, run);
    },
  });
  t.diagnostic(JSON.stringify({ active: [...arrived], skipped: [4, 5, 6, 7], activeToReturnMs: returnedAt - allActiveAt, nextAssignment: beta, requests: run.provider?.requests }));
});

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) {
  test(`parent ${signal} cleans four packed children and leaves an unrelated sibling alive`, { timeout: 18000 }, async (t) => {
    const observer = observerFor(t);
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => sibling.kill('SIGKILL'));
    const prompt = `shutdown-parent-${signal}`;
    const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'general-purpose', task: `shutdown-child-${index}` }));
    const arrived = new Set();
    let stoppedAt = 0;
    /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
    const routes = [{ marker: prompt, steps: [{ model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'shutdown', name: 'subagent', arguments: { tasks } } }] },
      ...tasks.map((task, index) => ({ marker: task.task, steps: [{ model: FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('stall') }, check: (/** @type {Record<string, unknown>} */ payload) => {
        leaf(payload);
        assert.ok(index < 4);
        arrived.add(index);
        if (arrived.size === 4) { assert.equal(livePi(observer), 5); stoppedAt = Date.now(); process.kill(observer.root, signal); }
      } }] })),
    ];
    await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 5, keepArtifacts: true,
      timeoutMs: 10000, expectedExit: { code: signal === 'SIGTERM' ? 143 : 129, signal: null }, onSpawn: (pid) => observer.start(pid),
      verify: async (run) => {
        assert.equal(arrived.size, 4);
        assert.ok(sibling.pid); process.kill(sibling.pid, 0);
        assert.ok(stoppedAt > 0 && Date.now() - stoppedAt < 5000);
        t.diagnostic(JSON.stringify({ signal, active: [...arrived], signalToExitMs: Date.now() - stoppedAt, siblingPid: sibling.pid }));
        await evidence(t, observer, run);
      },
    });
  });
}
