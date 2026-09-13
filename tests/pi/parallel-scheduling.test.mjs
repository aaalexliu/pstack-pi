import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FIXTURE_MODEL } from './provider.mjs';
import { runPiSmoke } from './runner.mjs';
import { startConcurrentProvider } from './concurrent-provider.mjs';
import { ProductionObserver } from './production-observer.mjs';

/** @param {() => boolean | Promise<boolean>} predicate */
async function until(predicate) {
  const end = Date.now() + 4500;
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
  const tasks = Array.from({ length: 4 }, (_, index) => ({ agent: 'general-purpose', task: `parallel-child-${index}` }));
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
  ] }, ...tasks.map((task, index) => ({ marker: task.task, steps: [{ model: FIXTURE_MODEL,
    reply: { kind: /** @type {const} */ ('text'), text: `output-${index}` }, check: async (/** @type {Record<string, unknown>} */ payload) => {
      leaf(payload);
      arrived.add(index);
      await until(() => arrived.size === 4);
      await until(() => livePi(observer) === index + 2);
      completed.push(index);
    },
  }] }))];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 6, expectedText: 'Parallel order verified.', keepArtifacts: true,
    onSpawn: (pid) => observer.start(pid),
    verify: async (run) => {
      const event = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.ok(event && event.isError === false);
      const result = /** @type {{content: {text: string}[], details: {kind: string, tasks: {id: string, kind: string, usage: null}[]}}} */ (event.result);
      assert.equal(result.details.kind, 'parallel');
      assert.deepEqual(result.details.tasks.map((task) => task.id), ['batch/1', 'batch/2', 'batch/3', 'batch/4']);
      assert.ok(result.details.tasks.every((task) => task.kind === 'succeeded' && task.usage === null));
      assert.deepEqual([...result.content[0].text.matchAll(/output-([0-3])/g)].map((match) => Number(match[1])), [0, 1, 2, 3]);
      await evidence(t, observer, run);
    },
  });
  t.diagnostic(JSON.stringify({ completed, returned: [0, 1, 2, 3], requests: run.provider?.requests }));
});
