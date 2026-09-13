import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FIXTURE_MODEL } from './provider.mjs';
import { runPiSmoke } from './runner.mjs';
import { startConcurrentProvider } from './concurrent-provider.mjs';
import { ProductionObserver } from './production-observer.mjs';

/** @param {Record<string, unknown>} payload @param {string} id */
function resultIn(payload, id) {
  assert.ok(Array.isArray(payload.messages));
  const result = payload.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result);
  return JSON.stringify(result.content);
}

test('nine tasks and invalid last-task models reject before any child request or pool commit', { timeout: 20000 }, async (t) => {
  const prompt = 'invalid-parallel-parent';
  const entry = { agent: 'general-purpose', task: 'must-not-start', role: 'feature' };
  const prefix = [entry, ...Array(6).fill({ agent: entry.agent, task: entry.task })];
  const invalid = [
    { tasks: Array(9).fill(entry) },
    ...['pi-fixture/missing', 'pi-fixture/pi-smoke-mod', 'unknown/model', 'auto'].map((model) => ({ tasks: [...prefix, { ...entry, model }] })),
    { tasks: [...prefix, { ...entry, role: 'typo', model: 'inherit-parent' }] },
    { tasks: [{ ...entry, cwd: '.' }] },
    { tasks: [entry], tools: ['bash'] },
  ];
  /** @type {import('./concurrent-provider.mjs').ConcurrentStep[]} */
  const steps = invalid.map((arguments_, index) => ({ model: FIXTURE_MODEL,
    reply: { kind: 'tool', id: `invalid-${index}`, name: 'subagent', arguments: arguments_ },
    check: (payload) => { if (index) assert.match(resultIn(payload, `invalid-${index - 1}`), /Invalid|unavailable|validation|role/); },
  }));
  steps.push(
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'accepted', name: 'subagent', arguments: { ...entry, task: 'accepted-after-rejections' } } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Atomic rejection verified.' }, check: (payload) => { assert.match(resultIn(payload, 'accepted'), /first pool entry/); } },
  );
  const observer = new ProductionObserver();
  t.after(() => observer.rescue());
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider([
    { marker: prompt, steps },
    { marker: 'accepted-after-rejections', steps: [{ model: FIXTURE_MODEL, reply: { kind: 'text', text: 'The first pool entry remains.' } }] },
  ]), prompt, expectedRequests: steps.length + 1, expectedText: 'Atomic rejection verified.', keepArtifacts: true,
    onSpawn: (pid) => observer.start(pid),
    setup: async (paths) => {
      await mkdir(path.join(paths.profile, 'pstack-pi'));
      await writeFile(path.join(paths.profile, 'pstack-pi/models.json'), JSON.stringify({ version: 1, roles: { feature: ['inherit-parent', 'pi-fixture/missing'] } }));
    },
    verify: async (run) => {
      const events = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.equal(events.length, invalid.length + 1);
      assert.ok(events.slice(0, -1).every((event) => event.isError === true));
      assert.equal(events.at(-1)?.isError, false);
      observer.verifyGone();
      assert.equal(observer.peakLivePi, 2);
      assert.deepEqual(run.cleanup.signals, []);
      await writeFile(path.join(run.paths.root, 'rejection-processes.json'), JSON.stringify(observer.report(), null, 2));
    },
  });
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, rejectedRequests: invalid.length, childRequests: 1, cleanup: run.cleanup }));
});

test('a packed task failure does not cancel siblings and a forced leaf subagent call stays unavailable', { timeout: 20000 }, async (t) => {
  const observer = new ProductionObserver({ maxLivePi: 5 });
  t.after(() => observer.rescue());
  const prompt = 'mixed-parallel-parent';
  const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'general-purpose', task: `mixed-child-${index}` }));
  const arrived = new Set();
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: 'mixed', name: 'subagent', arguments: { tasks, limits: { outputBytes: 23 } } } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Sibling isolation verified.' }, check: (payload) => {
      assert.equal(arrived.size, 8);
      assert.match(resultIn(payload, 'mixed'), /failed/);
      assert.equal(observer.sample().length, 1, 'Child survived tool return');
    } },
  ] }, ...tasks.map((task, index) => {
    /** @type {import('./concurrent-provider.mjs').ConcurrentStep[]} */
    const steps = [{ model: FIXTURE_MODEL,
      reply: index === 0 ? { kind: 'failure' } : index === 2 ? { kind: 'tool', id: 'nested', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Do not run.' } } : { kind: 'text', text: `result-${index}` },
      check: async (payload) => {
        assert.ok(Array.isArray(payload.tools) && !payload.tools.some((tool) => tool.function.name === 'subagent'));
        arrived.add(index);
        if (index < 4) {
          const deadline = Date.now() + 4000;
          while (arrived.size < 4 && Date.now() < deadline) await delay(20);
          assert.ok(arrived.size >= 4);
          observer.sample();
        }
      },
    }];
    if (index === 2) steps.push({ model: FIXTURE_MODEL, reply: { kind: 'text', text: 'The leaf cannot delegate.' }, check: (payload) => { assert.match(resultIn(payload, 'nested'), /not found|Unknown|not available/i); } });
    return { marker: task.task, steps };
  })];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), prompt, expectedRequests: 11, expectedText: 'Sibling isolation verified.', keepArtifacts: true,
    onSpawn: (pid) => observer.start(pid),
    verify: async (run) => {
      const event = run.events.find((event) => event.type === 'tool_execution_end' && event.toolCallId === 'mixed');
      assert.ok(event && event.isError === true);
      const result = /** @type {{content: {text: string}[], details?: unknown}} */ (event.result);
      assert.ok(result.details && typeof result.details === 'object' && 'tasks' in result.details);
      assert.ok(Array.isArray(result.details.tasks) && result.details.tasks.length === 8);
      assert.deepEqual([...result.content[0].text.matchAll(/\[\d\] general-purpose (\w+)/g)].map((match) => match[1]), ['failed', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 23 + 4096);
      observer.verifyGone();
      assert.equal(observer.peakLivePi, 5);
      assert.deepEqual(run.cleanup.signals, []);
      await writeFile(path.join(run.paths.root, 'mixed-processes.json'), JSON.stringify(observer.report(), null, 2));
    },
  });
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, reachedProvider: [...arrived], peakLivePi: observer.peakLivePi, cleanup: run.cleanup }));
});
