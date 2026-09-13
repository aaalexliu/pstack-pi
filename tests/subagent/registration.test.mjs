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
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['agent', 'cwd', 'limits', 'model', 'role', 'task']);
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

test('cleanup uncertainty makes every later call fail closed', async (t) => {
  const f = await runtime(t);
  const { tool, shutdown } = registration((args) => runChild({ ...args, invocation: f.invocation, backend: {
    ...processBackend, table: () => { throw new Error('PRIVATE_PROCESS_DATA'); },
  } }));
  await assert.rejects(tool.execute('one', { agent: 'general-purpose', task: 'PRIVATE_TASK' }, undefined, undefined, f.ctx), /quarantined/);
  await assert.rejects(tool.execute('two', { agent: 'general-purpose', task: 'task' }, undefined, undefined, f.ctx), /quarantined/);
  await shutdown();
});
