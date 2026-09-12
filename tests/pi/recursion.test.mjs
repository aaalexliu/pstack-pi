import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessObserver, OBSERVATION_LIMITS } from './process-observer.mjs';
import { jsonlParser, PiTestError, PiWatchdogTimeout, runPiSmoke } from './runner.mjs';
import unsafeRecursion from './fixtures/unsafe-recursion.mjs';

const WATCHDOG_MS = 15_000;

test('unsafe fixture requires both explicit test configuration and a run nonce', () => {
  const saved = { config: process.env.PSTACK_RECURSION_TEST_CONFIG, nonce: process.env.PSTACK_RECURSION_TEST_NONCE };
  let registered = 0;
  const api = { registerTool: () => { registered++; } };
  try {
    delete process.env.PSTACK_RECURSION_TEST_CONFIG;
    delete process.env.PSTACK_RECURSION_TEST_NONCE;
    unsafeRecursion(api);
    process.env.PSTACK_RECURSION_TEST_CONFIG = '{}';
    unsafeRecursion(api);
    delete process.env.PSTACK_RECURSION_TEST_CONFIG;
    process.env.PSTACK_RECURSION_TEST_NONCE = 'a'.repeat(32);
    unsafeRecursion(api);
    process.env.PSTACK_RECURSION_TEST_CONFIG = '{}';
    assert.throws(() => unsafeRecursion(api));
    assert.equal(registered, 0);
  } finally {
    if (saved.config === undefined) delete process.env.PSTACK_RECURSION_TEST_CONFIG;
    else process.env.PSTACK_RECURSION_TEST_CONFIG = saved.config;
    if (saved.nonce === undefined) delete process.env.PSTACK_RECURSION_TEST_NONCE;
    else process.env.PSTACK_RECURSION_TEST_NONCE = saved.nonce;
  }
});

/** @param {Record<string, unknown>} request */
function checkTools(request) {
  assert.ok(Array.isArray(request.tools));
  assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ['read', 'subagent']);
}

/** @param {import('./runner.mjs').PiEvent[]} events */
function checkEvents(events) {
  assert.equal(events[0]?.type, 'session');
  assert.ok(!events.some((event) => event.type === 'agent_settled'), 'Pi refused or settled before watchdog');
  for (const event of events) {
    assert.ok(!/error|warning|diagnostic/i.test(event.type), 'Pi emitted diagnostics');
    if (event.type === 'message_end') {
      const message = event.message;
      assert.ok(message && typeof message === 'object');
      if ('role' in message && message.role === 'assistant') {
        assert.ok('stopReason' in message);
        assert.equal(message.stopReason, 'toolUse', 'Assistant refused or failed a turn');
      }
    }
  }
}

test('test-only real Pi recursion reaches four live edges, reads a file, and dies at the watchdog', { skip: !['darwin', 'linux'].includes(process.platform) }, async (t) => {
  const nonce = randomBytes(16).toString('hex');
  const marker = `RECURSION_READ_${randomBytes(16).toString('hex')}`;
  const observer = new ProcessObserver();
  /** @type {{atMs: number, chain: number[]} | null} */
  let readVerified = null;
  /** @type {{pid: number, bytes: number, events: {type: string, toolName?: unknown, toolCallId?: unknown, isError?: unknown}[]}[]} */
  const traces = [];
  /** @type {import('./provider.mjs').ScriptStep[]} */
  const script = Array.from({ length: 4 }, (_, index) => ({
    reply: { kind: 'tool', id: `recurse-${index}`, name: 'subagent', arguments: {} },
    check: async (request) => {
      checkTools(request);
      const sample = observer.sample(`provider-${index + 1}`);
      assert.equal(sample.chain.length, index + 1, 'Request did not come from a new nested Pi');
      assert.ok(Array.isArray(request.messages));
      assert.equal(request.messages.filter((message) => message.role === 'tool').length, 0, 'Unexpected prior tool result');
    },
  }));
  script.push({
    reply: { kind: 'tool', id: 'deepest-read', name: 'read', arguments: { path: 'marker.txt' } },
    check: async (request) => {
      checkTools(request);
      assert.equal(observer.sample('provider-5').chain.length, 5);
    },
  }, {
    reply: { kind: 'stall' },
    check: async (request) => {
      checkTools(request);
      const sample = observer.sample('provider-6');
      assert.equal(sample.chain.length, 5);
      assert.ok(Array.isArray(request.messages));
      const results = request.messages.filter((message) => message.role === 'tool');
      assert.equal(results.length, 1);
      assert.equal(results[0].tool_call_id, 'deepest-read');
      assert.equal(results[0].content, marker);
      readVerified = { atMs: sample.atMs, chain: sample.chain };
    },
  });
  /** @type {PiTestError | undefined} */
  let failure;
  try {
    await runPiSmoke({
      launch: { kind: 'recursion-control', nonce }, observer, timeoutMs: WATCHDOG_MS, fixture: { script },
      setup: async (paths) => { await writeFile(join(paths.cwd, 'marker.txt'), marker); },
      verifyStopped: async (run) => {
        assert.equal(run.cleanup.providerClosed, true);
        assert.ok(readVerified, 'Deepest real read was not verified');
        assert.equal(run.timeout.expired, true);
        assert.equal(run.stdout.truncated, false);
        assert.equal(run.stderr.truncated, false);
        assert.equal(run.stderr.bytes, 0);
        assert.deepEqual(run.diagnostics, []);
        assert.deepEqual(run.provider?.errors, []);
        assert.equal(run.provider?.requests, 6);
        const state = observer.state;
        assert.equal(state.maxDepth, 4);
        assert.equal(state.peakLivePi, 5);
        assert.equal(state.identities.length, 5, 'Unexpected process or sequential sibling');
        assert.equal(state.droppedPolls, 0);
        assert.equal(state.failedPolls, 0);
        assert.equal(state.overlappingPolls, 0);
        assert.deepEqual(state.errors, []);
        assert.ok(state.watchdog);
        assert.ok(state.watchdog.atMs >= readVerified.atMs + OBSERVATION_LIMITS.intervalMs, 'Watchdog did not leave a live observation interval after the read');
        assert.deepEqual(state.watchdog.chain, readVerified.chain);
        const verifiedAt = readVerified.atMs;
        assert.ok(state.samples.some((sample) => sample.source === 'interval' && sample.atMs > verifiedAt && sample.chain.length === 5));
        const childPids = readVerified.chain.slice(1);
        const directory = join(run.paths.root, 'child-output');
        assert.deepEqual((await readdir(directory)).sort(), childPids.map((pid) => `child-${pid}.jsonl`).sort(), 'Missing child stream or child stderr');
        const allEvents = [run.events];
        for (const pid of childPids) {
          const bytes = await readFile(join(directory, `child-${pid}.jsonl`));
          assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024);
          /** @type {import('./runner.mjs').PiEvent[]} */
          const events = [];
          const parser = jsonlParser((event) => events.push(event));
          parser.write(bytes);
          parser.end();
          allEvents.push(events);
          traces.push({ pid, bytes: bytes.length, events: events.filter((event) => event.type.startsWith('tool_execution')).map(({ type, toolName, toolCallId, isError }) => ({ type, toolName, toolCallId, isError })) });
        }
        for (const events of allEvents) checkEvents(events);
        for (let depth = 0; depth < 4; depth++) {
          const starts = allEvents[depth].filter((event) => event.type === 'tool_execution_start');
          assert.equal(starts.length, 1);
          assert.equal(starts[0].toolName, 'subagent');
          assert.equal(starts[0].toolCallId, `recurse-${depth}`);
          assert.ok(!allEvents[depth].some((event) => event.type === 'tool_execution_end'), 'Delegation did not await child exit');
        }
        const deepest = allEvents[4].filter((event) => event.type.startsWith('tool_execution'));
        assert.deepEqual(deepest.map(({ type, toolName, toolCallId }) => ({ type, toolName, toolCallId })), [
          { type: 'tool_execution_start', toolName: 'read', toolCallId: 'deepest-read' },
          { type: 'tool_execution_end', toolName: 'read', toolCallId: 'deepest-read' },
        ]);
        assert.equal(deepest[1].isError, false);
      },
    });
    assert.fail('Unsafe recursion exited without watchdog');
  } catch (error) {
    assert.ok(error instanceof PiTestError);
    failure = error;
  }
  const { run, cause } = failure;
  assert.ok(cause instanceof AggregateError);
  assert.equal(cause.errors.length, 1, JSON.stringify({ errors: cause.errors.map(String), providerErrors: run.provider?.errors, identities: observer.state.identities, observerErrors: observer.state.errors, cleanup: run.cleanup, stderr: run.stderr }, null, 2));
  assert.ok(cause.errors[0] instanceof PiWatchdogTimeout);
  assert.deepEqual(run.cleanup, { signals: ['SIGKILL'], remainingPids: [], groupAlive: false, providerClosed: true, tempRemoved: true });
  assert.equal(run.exit?.signal, 'SIGKILL');
  assert.equal(existsSync(run.paths.root), false);
  assert.ok(!run.pack.files.some((name) => name.startsWith('tests/')));
  const artifact = join(await mkdtemp(join(tmpdir(), 'pstack-recursion-evidence-')), 'observation.json');
  const summary = {
    platform: process.platform, pi: run.process.version, revision: run.process.revision, elapsedMs: run.durationMs,
    requests: run.provider?.requests, readVerified, traces,
    rootEvents: run.events.filter((event) => event.type.startsWith('tool_execution')).map(({ type, toolName, toolCallId }) => ({ type, toolName, toolCallId })),
    limits: { watchdogMs: WATCHDOG_MS, ...OBSERVATION_LIMITS },
    observation: { ...observer.state, samples: observer.state.samples.map(({ atMs, source, chain, processes }) => ({ atMs, source, chain, processes: processes.map(({ pid, ppid, pgid, state, depth, pi }) => ({ pid, ppid, pgid, state, depth, pi })) })) },
    timeout: run.timeout, exit: run.exit, cleanup: run.cleanup, pack: run.pack.files, packShasum: run.pack.shasum,
  };
  const json = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(json) <= 256 * 1024, 'Observation artifact exceeded 256 KiB');
  await writeFile(artifact, json + '\n');
  t.diagnostic(JSON.stringify({ artifact, elapsedMs: run.durationMs, depth: observer.state.maxDepth, peakLivePi: observer.state.peakLivePi, identities: observer.state.identities, samples: observer.state.samples.length, requests: run.provider?.requests, readVerified, watchdog: observer.state.watchdog, cleanup: observer.state.cleanup, runnerCleanup: run.cleanup }));
});
