import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runChild } from '../../extensions/subagent/runner.ts';
import { PiInvocation, processBackend } from '../../extensions/subagent/process.ts';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import extension from '../../extensions/subagent/index.ts';
import { subagentParameters } from '../../extensions/subagent/domain.ts';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';

/** @param {typeof import('../../extensions/subagent/runner.ts').runChild} [run] */
function registration(run) {
  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof subagentParameters>[]} */
  const tools = [];
  /** @type {PropertyKey[]} */
  const calls = [];
  /** @type {(() => Promise<void>) | undefined} */
  let shutdown;
  const api = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), {
    get(_target, name) {
      calls.push(name);
      if (name === 'on') return (/** @type {string} */ event, /** @type {() => Promise<void>} */ handler) => { assert.equal(event, 'session_shutdown'); assert.equal(shutdown, undefined); shutdown = handler; };
      assert.equal(name, 'registerTool', `Forbidden API access: ${String(name)}`);
      return (/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof subagentParameters>} */ tool) => tools.push(tool);
    },
  });
  extension(api, { run, pin: () => PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) }) });
  assert.deepEqual(calls, ['on', 'registerTool']);
  assert.ok(shutdown);
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'subagent');
  assert.equal(tool.parameters, subagentParameters);
  assert.deepEqual(Object.keys(tool.parameters.anyOf[0].properties).sort(), ['agent', 'cwd', 'limits', 'model', 'role', 'task']);
  assert.deepEqual(Object.keys(tool.parameters.anyOf[1].properties).sort(), ['cwd', 'limits', 'tasks']);
  return { tool, shutdown };
}

test('fake ExtensionAPI sees only subagent and one session_shutdown handler', () => { registration(); });

test('execute rejects unknown agents, malformed user agents, cwd changes, and injected trust fields before spawn', async (t) => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  await mkdir(path.join(profile, 'agents'), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const { tool } = registration();
  const ctx = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({}), {
    get(_target, name) {
      if (name === 'model' || name === 'thinkingLevel') return undefined;
      assert.equal(name, 'cwd', `Runtime reached unexpected context access: ${String(name)}`);
      return root;
    },
  });
  await assert.rejects(tool.execute('call', { agent: 'unknown', task: 'task' }, undefined, undefined, ctx), /Unknown agent/);
  await assert.rejects(tool.execute('call', { agent: 'general-purpose', task: 'task', cwd: profile }, undefined, undefined, ctx), /differs/);
  await assert.rejects(tool.execute('call', JSON.parse('{"agent":"general-purpose","task":"task","confirmProjectAgents":false}'), undefined, undefined, ctx), /Invalid single/);
  await writeFile(path.join(profile, 'agents/general-purpose.md'), 'malformed');
  await assert.rejects(tool.execute('call', { agent: 'general-purpose', task: 'task' }, undefined, undefined, ctx), /Invalid agent catalog/);
});

for (const depth of ['', '00', '-1', '0\n', '1', '2', '999999', '1000000']) {
  test(`inherited depth ${JSON.stringify(depth)} disables only pstack registration`, () => {
    const previous = process.env.PSTACK_SUBAGENT_DEPTH;
    process.env.PSTACK_SUBAGENT_DEPTH = depth;
    try {
      extension(new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), { get: (_target, name) => { throw new Error(`Unexpected API access ${String(name)}`); } }));
    } finally {
      if (previous === undefined) delete process.env.PSTACK_SUBAGENT_DEPTH;
      else process.env.PSTACK_SUBAGENT_DEPTH = previous;
    }
  });
}

/** @param {import('node:test').TestContext} t */
async function runtime(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'registration-run-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const oldDepth = process.env.PSTACK_SUBAGENT_DEPTH;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'profile');
  delete process.env.PSTACK_SUBAGENT_DEPTH;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (oldDepth === undefined) delete process.env.PSTACK_SUBAGENT_DEPTH; else process.env.PSTACK_SUBAGENT_DEPTH = oldDepth;
    await rm(root, { recursive: true, force: true });
  });
  const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
  const profile = process.env.PI_CODING_AGENT_DIR;
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture-key', models: [{ id: 'model' }],
  } } }));
  const models = await ModelRuntime.create();
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({ cwd: root, model: models.getModel('fixture', 'model'), thinkingLevel: 'off', modelRegistry: new ModelRegistry(models) });
  return { root, invocation, ctx };
}

test('concurrent calls cannot both spawn; shutdown waits through forced cleanup and is idempotent', { timeout: 6000 }, async (t) => {
  const f = await runtime(t);
  let spawns = 0;
  const { tool, shutdown } = registration((args) => runChild({ ...args, invocation: f.invocation, backend: {
    ...processBackend,
    spawn: (_invocation, args, options) => { spawns++; return spawn(process.execPath, [fileURLToPath(new URL('./process-fixture.mjs', import.meta.url)), 'ignore', ...args], options); },
  } }));
  const marker = path.join(f.root, 'started.json');
  const result = tool.execute('one', { agent: 'general-purpose', task: marker }, undefined, undefined, f.ctx).then(() => 'success', (error) => String(error));
  await assert.rejects(tool.execute('two', { agent: 'general-purpose', task: marker }, undefined, undefined, f.ctx), /already running/);
  const deadline = Date.now() + 2000;
  let capture;
  while (Date.now() < deadline) { try { capture = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await delay(10); } }
  assert.ok(capture);
  const stopping = shutdown();
  await assert.rejects(tool.execute('three', { agent: 'general-purpose', task: marker }, undefined, undefined, f.ctx), /shutting down/);
  await stopping; await shutdown();
  assert.match(await result, /parentShutdown/);
  assert.equal(spawns, 1);
  assert.throws(() => process.kill(capture.pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(capture.promptFile), { code: 'ENOENT' });
});

test('shutdown during preparation prevents spawn and does not deadlock', { timeout: 3000 }, async (t) => {
  const f = await runtime(t);
  const { tool, shutdown } = registration(async () => { throw new Error('Must not run'); });
  let stopped = Promise.resolve();
  const ctx = new Proxy(f.ctx, { get(target, name) { if (name === 'cwd') stopped = shutdown(); return Reflect.get(target, name); } });
  await assert.rejects(tool.execute('one', { agent: 'general-purpose', task: 'task' }, undefined, undefined, ctx), /parentShutdown/);
  await stopped;
});

test('pre-abort does not read context or reserve capacity', async (t) => {
  const f = await runtime(t);
  const { tool, shutdown } = registration();
  const controller = new AbortController(); controller.abort('PRIVATE_ABORT_DATA');
  const ctx = new Proxy(f.ctx, { get() { throw new Error('Must not read context'); } });
  await assert.rejects(tool.execute('one', { agent: 'general-purpose', task: 'task' }, controller.signal, undefined, ctx), /cancelled \(user\)/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await shutdown();
});

test('depth is parsed once; request reductions truncate UTF-8 and report clamps without hidden output', async (t) => {
  const f = await runtime(t);
  const { tool } = registration((args) => runChild({ ...args, invocation: f.invocation, backend: {
    ...processBackend,
    spawn: (_invocation, args, options) => {
      assert.equal(options.env?.PSTACK_SUBAGENT_DEPTH, '1');
      return spawn(process.execPath, [fileURLToPath(new URL('./child-fixture.mjs', import.meta.url)), 'large-output', ...args], options);
    },
  } }));
  process.env.PSTACK_SUBAGENT_DEPTH = 'invalid-after-creation';
  const result = await tool.execute('one', { agent: 'general-purpose', task: 'task', limits: { outputBytes: 4, timeoutMs: 999999 } }, undefined, undefined, f.ctx);
  assert.ok(JSON.stringify(result.content).includes('Output truncated at 4 bytes'));
  assert.ok(JSON.stringify(result.content).includes('timeoutMs clamped to 120000'));
  assert.ok(!JSON.stringify(result).includes('�'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
});

test('parallel preparation validates the last task before any runner starts', async (t) => {
  const f = await runtime(t);
  let started = 0;
  const { tool } = registration(async () => { started++; throw new Error('Must not run'); });
  const task = { agent: 'general-purpose', task: 'task' };
  for (const last of [{ ...task, agent: 'missing' }, { ...task, model: 'fixture/missing' }, { ...task, model: 'fixture/mod' }]) {
    await assert.rejects(tool.execute('batch', { tasks: [...Array(7).fill(task), last] }, undefined, undefined, f.ctx));
  }
  await assert.rejects(tool.execute('nine', { tasks: Array(9).fill(task) }, undefined, undefined, f.ctx));
  assert.equal(started, 0);
});

test('parallel output retains only deterministic quotas with remainder bytes and no hidden full text', async (t) => {
  const f = await runtime(t);
  const { tool } = registration((args) => runChild({ ...args, invocation: f.invocation, backend: {
    ...processBackend,
    spawn: (_invocation, args, options) => spawn(process.execPath, [fileURLToPath(new URL('./child-fixture.mjs', import.meta.url)), 'large-output', ...args], options),
  } }));
  const result = await tool.execute('batch', { tasks: Array(8).fill({ agent: 'general-purpose', task: 'task' }), limits: { outputBytes: 27 } }, undefined, undefined, f.ctx);
  assert.ok(result.details && 'tasks' in result.details);
  const details = /** @type {{limits: {outputBytes: number}, output: {bytes: number, truncated: boolean}, usage: null}[]} */ (result.details.tasks);
  assert.deepEqual(details.map((task) => task.limits.outputBytes), [4, 4, 4, 3, 3, 3, 3, 3]);
  assert.ok(details.every((task) => task.output.bytes === 60000 && task.output.truncated && task.usage === null));
  assert.equal(result.content[0].type, 'text');
  assert.ok(JSON.stringify(result).length < 16000);
  assert.ok(!JSON.stringify(result).includes('�'));
  assert.ok(!JSON.stringify(result.details).includes('✓'));
});

test('process observation uncertainty cancels all active leases before cleanup finishes and never starts queued work', { timeout: 10000 }, async (t) => {
  const f = await runtime(t);
  /** @type {import('../../extensions/subagent/domain.ts').RunLease[]} */
  const leases = [];
  let distrust = false;
  const { tool, shutdown } = registration((args) => {
    assert.ok(args.lease);
    const index = leases.push(args.lease) - 1;
    return runChild({ ...args, invocation: f.invocation, backend: {
      ...processBackend,
      table: () => { if (distrust && index === 1) throw new Error('Injected observation failure'); return processBackend.table(); },
      spawn: (_invocation, argv, options) => spawn(process.execPath, [fileURLToPath(new URL('./process-fixture.mjs', import.meta.url)), 'ignore', ...argv], options),
    } });
  });
  const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'general-purpose', task: path.join(f.root, `${index}.json`) }));
  const pending = tool.execute('batch', { tasks }, undefined, undefined, f.ctx).then(() => 'unexpected success', String);
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { await Promise.all(tasks.slice(0, 4).map((task) => readFile(task.task))); break; } catch { await delay(10); }
    }
    assert.equal(leases.length, 4);
    await Promise.all(tasks.slice(0, 4).map((task) => readFile(task.task)));
    distrust = true;
    await delay(200);
    assert.ok(leases.every((lease) => lease.signal.aborted), 'Uncertainty must broadcast before the three-second cleanup wait');
    assert.match(await pending, /quarantined/);
    assert.equal(leases.length, 4);
    await assert.rejects(tool.execute('later', tasks[0], undefined, undefined, f.ctx), /quarantined/);
    for (const task of tasks.slice(0, 4)) {
      const capture = JSON.parse(await readFile(task.task, 'utf8'));
      assert.throws(() => process.kill(capture.pid, 0), { code: 'ESRCH' });
      await assert.rejects(readFile(capture.promptFile), { code: 'ENOENT' });
    }
  } finally { await shutdown(); await pending; }
});

test('cleanup uncertainty makes every later call fail closed', async (t) => {
  const f = await runtime(t);
  const { tool, shutdown } = registration((args) => runChild({ ...args, invocation: f.invocation, backend: {
    ...processBackend, table: () => { throw new Error('PRIVATE_PROCESS_DATA'); },
  } }));
  await assert.rejects(tool.execute('one', { agent: 'general-purpose', task: 'PRIVATE_TASK' }, undefined, undefined, f.ctx), /quarantined/);
  await assert.rejects(tool.execute('two', { agent: 'general-purpose', task: 'task' }, undefined, undefined, f.ctx), /quarantined/);
  await shutdown();
});
