import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';
import { startConcurrentProvider } from './concurrent-provider.mjs';
import { FIXTURE_MODEL, FIXTURE_TEXT } from './provider.mjs';
import { persistedStats } from './session-stats.mjs';

const wireA = { prompt_tokens: 16, completion_tokens: 17, total_tokens: 33, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 5 } };
const wireB = { prompt_tokens: 23, completion_tokens: 19, total_tokens: 42, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 7 } };
const knownA = { input: 13, output: 17, cacheRead: 3, cacheWrite: 0, totalTokens: 33, reasoning: 5,
  cost: { input: 13, output: 34, cacheRead: 1.5, cacheWrite: 0, total: 48.5 } };
const knownB = { input: 18, output: 19, cacheRead: 5, cacheWrite: 0, totalTokens: 42, reasoning: 7,
  cost: { input: 18, output: 38, cacheRead: 2.5, cacheWrite: 0, total: 58.5 } };
const combined = { input: 31, output: 36, cacheRead: 8, cacheWrite: 0, totalTokens: 75, reasoning: 12,
  cost: { input: 31, output: 72, cacheRead: 4, cacheWrite: 0, total: 107 } };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const parentCombined = { input: 53, output: 50, cacheRead: 8, cacheWrite: 0, total: 111 };

/** @param {import('./runner.mjs').PiTestRun['paths']} paths */
async function costs(paths) {
  const filename = path.join(paths.profile, 'models.json');
  const models = JSON.parse(await readFile(filename, 'utf8'));
  models.providers['pi-fixture'].models[0].cost = { input: 1000000, output: 2000000, cacheRead: 500000, cacheWrite: 4000000 };
  await writeFile(filename, JSON.stringify(models));
}
/** @param {unknown} value */
function record(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {Record<string, unknown>} payload */
function leaf(payload) {
  assert.ok(Array.isArray(payload.tools));
  assert.ok(!payload.tools.some((tool) => tool.function.name === 'subagent'));
}
/** @param {import('./runner.mjs').PiTestRun} run @param {boolean} isError @param {unknown} usage */
function result(run, isError, usage) {
  const ends = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
  const finals = run.events.filter((event) => event.type === 'message_end' && record(event.message).role === 'toolResult' && record(event.message).toolName === 'subagent');
  assert.equal(ends.length, 1);
  assert.equal(finals.length, 1);
  assert.equal(ends[0].isError, isError);
  const end = record(ends[0].result);
  const final = record(finals[0].message);
  assert.equal(final.isError, isError);
  for (const field of ['content', 'details', 'usage']) assert.deepEqual(end[field], final[field]);
  assert.deepEqual(final.usage, usage);
  assert.ok(Buffer.byteLength(JSON.stringify(end)) <= 65536);
  assert.ok(Array.isArray(end.content) && end.content.length === 1);
  assert.ok(Buffer.byteLength(end.content[0].text) <= 32768);
  return record(final.details);
}
/** @param {import('./runner.mjs').PiTestRun} run @param {unknown} tokens @param {number} cost */
async function totals(run, tokens, cost) {
  const stats = await persistedStats(run);
  assert.deepEqual(stats.before, stats.after, 'Reload changed persisted accounting');
  assert.deepEqual(stats.before.tokens, tokens);
  assert.equal(stats.before.cost, cost);
  assert.equal(stats.messages.filter((/** @type {{role: string, toolName?: string}} */ message) => message.role === 'toolResult' && message.toolName === 'subagent').length, 1);
  await writeFile(path.join(run.paths.root, 'usage-evidence.json'), JSON.stringify({ tokens, cost, before: stats.before, after: stats.after }, null, 2));
}

for (const outputBytes of [32768, 4]) {
  test(`packed child read and two assistant turns count once with output budget ${outputBytes}`, { timeout: 30000 }, async (t) => {
    const prompt = 'usage-read-parent';
    /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
    const routes = [{ marker: prompt, steps: [
      { model: FIXTURE_MODEL, reply: { kind: 'tool', name: 'subagent', id: 'usage', arguments: { agent: 'general-purpose', task: 'usage-read-child', limits: { outputBytes } } } },
      { model: FIXTURE_MODEL, reply: { kind: 'text', text: FIXTURE_TEXT }, check(payload) {
        assert.ok(Array.isArray(payload.messages));
        assert.ok(payload.messages.some((message) => message.role === 'tool' && message.content.includes(outputBytes === 4 ? 'Fina' : 'Final child report')));
      } },
    ] }, { marker: 'usage-read-child', steps: [
      { model: FIXTURE_MODEL, usage: wireA, reply: { kind: 'tool', name: 'read', id: 'read', arguments: { path: 'fixture.txt' } }, check: leaf },
      { model: FIXTURE_MODEL, usage: wireB, reply: { kind: 'text', text: 'Final child report ✓' }, check(payload) {
        leaf(payload);
        assert.ok(Array.isArray(payload.messages));
        assert.ok(payload.messages.some((message) => message.role === 'tool' && message.content.includes('PRIVATE_READ_MARKER')));
      } },
    ] }];
    const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), configureModels: costs, prompt, expectedRequests: 4, keepArtifacts: true,
      setup: (paths) => writeFile(path.join(paths.cwd, 'fixture.txt'), 'PRIVATE_READ_MARKER'),
      async verify(run) {
        const details = result(run, false, combined);
        const usage = record(details.usage);
        assert.deepEqual(usage.direct, { kind: 'complete', usage: combined });
        assert.deepEqual(usage.descendant, { kind: 'complete', usage: zero });
        assert.equal(record(details.output).truncated, outputBytes === 4);
        assert.ok(!JSON.stringify(details).includes('PRIVATE_READ_MARKER'));
        await totals(run, parentCombined, 157);
      },
    });
    t.diagnostic(JSON.stringify({ artifact: run.paths.root, direct: combined, parentTokens: parentCombined, parentCost: 157 }));
  });
}

test('packed mixed success and charged length failure retain ordered details, error flag, and all known usage', { timeout: 30000 }, async (t) => {
  const prompt = 'usage-mixed-parent';
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', name: 'subagent', id: 'usage', arguments: { tasks: [
      { agent: 'general-purpose', task: 'usage-good-child' }, { agent: 'general-purpose', task: 'usage-bad-child' },
    ] } } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: FIXTURE_TEXT } },
  ] }, { marker: 'usage-good-child', steps: [{ model: FIXTURE_MODEL, usage: wireA, reply: { kind: 'text', text: 'good' }, check: leaf }] },
  { marker: 'usage-bad-child', steps: [{ model: FIXTURE_MODEL, usage: wireB, finishReason: 'length', reply: { kind: 'text', text: 'PRIVATE_FAILED_OUTPUT' }, check: leaf }] }];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), configureModels: costs, prompt, expectedRequests: 4, keepArtifacts: true,
    async verify(run) {
      const details = result(run, true, combined);
      assert.ok(Array.isArray(details.tasks));
      assert.deepEqual(details.tasks.map((task) => task.kind), ['succeeded', 'failed']);
      assert.deepEqual(details.tasks.map((task) => task.usage.direct.usage), [knownA, knownB]);
      assert.equal(details.tasks[1].usage.direct.kind, 'partial');
      assert.match(details.tasks[1].reason, /length/);
      assert.ok(!JSON.stringify(details).includes('PRIVATE_FAILED_OUTPUT'));
      await totals(run, parentCombined, 157);
    },
  });
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, direct: combined, parentTokens: parentCombined, parentCost: 157 }));
});

test('packed cancellation preserves latest cumulative updates and four queued tasks remain complete zero', { timeout: 30000 }, async (t) => {
  const prompt = 'usage-partial-parent';
  const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'general-purpose', task: `usage-partial-child-${index}` }));
  const early = { ...wireA, prompt_tokens: 103, completion_tokens: 2, total_tokens: 105 };
  const aggregate = { input: 52, output: 68, cacheRead: 12, cacheWrite: 0, totalTokens: 132, reasoning: 20,
    cost: { input: 52, output: 136, cacheRead: 6, cacheWrite: 0, total: 194 } };
  const parent = { input: 74, output: 82, cacheRead: 12, cacheWrite: 0, total: 168 };
  /** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */
  const routes = [{ marker: prompt, steps: [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', name: 'subagent', id: 'usage', arguments: { tasks, limits: { timeoutMs: 6000, outputBytes: 8 } } } },
    { model: FIXTURE_MODEL, reply: { kind: 'text', text: FIXTURE_TEXT } },
  ] }, ...tasks.map((task, index) => ({ marker: task.task, steps: [{ model: FIXTURE_MODEL,
    reply: { kind: /** @type {const} */ ('partial'), updates: [{ text: 'first', usage: early }, { text: 'second', usage: wireA }] },
    check(/** @type {Record<string, unknown>} */ payload) { assert.ok(index < 4, 'Queued task reached provider'); leaf(payload); },
  }] }))];
  const run = await runPiSmoke({ startFixture: () => startConcurrentProvider(routes), configureModels: costs, prompt, expectedRequests: 6, keepArtifacts: true,
    async verify(run) {
      const details = result(run, true, aggregate);
      assert.ok(Array.isArray(details.tasks));
      assert.deepEqual(details.tasks.map((task) => task.kind), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'skipped', 'skipped', 'skipped', 'skipped']);
      for (const task of details.tasks.slice(0, 4)) {
        assert.equal(task.usage.direct.kind, 'partial');
        assert.deepEqual(task.usage.direct.usage, knownA);
        assert.deepEqual(task.usage.direct.provisional, knownA);
        assert.ok(task.usage.direct.reasons.includes('cancelled'));
      }
      for (const task of details.tasks.slice(4)) assert.deepEqual(task.usage.direct, { kind: 'complete', usage: zero });
      assert.ok(details.tasks.every((task) => task.usage.descendant.kind === 'complete' && task.usage.descendant.usage.totalTokens === 0));
      await totals(run, parent, 244);
    },
  });
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, direct: aggregate, parentTokens: parent, parentCost: 244 }));
});

test('real Pi parent counts injected unsupported descendant evidence once without enabling nested children', { timeout: 30000 }, async (t) => {
  const prompt = 'usage-nested-control-parent';
  const run = await runPiSmoke({ configureModels: costs, prompt, expectedRequests: 2, keepArtifacts: true,
    fixture: { script: [
      { reply: { kind: 'tool', name: 'subagent', id: 'usage', arguments: { agent: 'general-purpose', task: 'Unsupported nested usage control' } } },
      { reply: { kind: 'text', text: FIXTURE_TEXT } },
    ] },
    async setup(paths) {
      const settingsFile = path.join(paths.profile, 'settings.json');
      const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
      settings.packages = [{ source: paths.package, extensions: [] }];
      await writeFile(settingsFile, JSON.stringify(settings));
      const child = path.join(paths.root, 'unsupported-child.mjs');
      const assistant = { role: 'assistant', timestamp: 2, provider: 'pi-fixture', model: FIXTURE_MODEL, stopReason: 'stop', content: [{ type: 'text', text: 'not supported' }], usage: knownB };
      const tool = { role: 'toolResult', timestamp: 1, toolCallId: 'unexpected', toolName: 'read', isError: false, content: [], usage: knownA };
      const events = [
        { type: 'message_start', message: tool }, { type: 'message_end', message: tool },
        { type: 'tool_execution_end', result: tool }, { type: 'turn_end', toolResults: [tool] },
        { type: 'message_start', message: assistant }, { type: 'message_end', message: assistant },
        { type: 'agent_end', messages: [tool, assistant] }, { type: 'agent_settled' },
      ];
      await writeFile(child, `for await (const chunk of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n') + '\n')});\n`);
      await mkdir(path.join(paths.profile, 'extensions'));
      await writeFile(path.join(paths.profile, 'extensions/control.ts'), `
        import { spawn } from 'node:child_process';
        import extension from ${JSON.stringify(path.join(paths.package, 'extensions/subagent/index.ts'))};
        import { runChild } from ${JSON.stringify(path.join(paths.package, 'extensions/subagent/runner.ts'))};
        import { processBackend } from ${JSON.stringify(path.join(paths.package, 'extensions/subagent/process.ts'))};
        export default (pi) => extension(pi, { run: (args) => runChild({ ...args, backend: { ...processBackend,
          spawn: (_invocation, argv, options) => spawn(process.execPath, [${JSON.stringify(child)}, ...argv], options)
        } }) });
      `);
    },
    async verify(run) {
      const details = result(run, true, combined);
      const usage = record(details.usage);
      assert.deepEqual(record(usage.direct).usage, knownB);
      assert.deepEqual(usage.descendant, { kind: 'partial', usage: knownA, reasons: ['unexpected-descendant'], provisional: null });
      await totals(run, parentCombined, 157);
    },
  });
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, injectedDirect: knownB, injectedDescendant: knownA, parentCost: 157 }));
});
