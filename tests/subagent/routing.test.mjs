import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import extension from '../../extensions/subagent/index.ts';
import { subagentParameters } from '../../extensions/subagent/domain.ts';
import { PiInvocation, processBackend } from '../../extensions/subagent/process.ts';
import { runChild } from '../../extensions/subagent/runner.ts';

test('single execute captures parent before await and routes admission without consuming rejected or cancelled preparation', async (t) => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'routing-single-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'pstack-pi'));
  await writeFile(path.join(root, 'pstack-pi/models.json'), JSON.stringify({ version: 1, roles: { feature: ['fixture/first', 'inherit-parent', 'fixture/last'] } }));
  await writeFile(path.join(root, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture-key', models: [{ id: 'parent', reasoning: true }, { id: 'first' }, { id: 'last' }, { id: 'explicit' }],
  } } }));
  const runtime = await ModelRuntime.create();
  const context = () => /** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({ cwd: root, model: runtime.getModel('fixture', 'parent'), thinkingLevel: 'high', modelRegistry: new ModelRegistry(runtime) });
  const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof subagentParameters> | undefined} */
  let tool;
  const api = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), {
    get(_target, name) {
      if (name === 'on') return () => {};
      assert.equal(name, 'registerTool');
      return (/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof subagentParameters>} */ value) => { tool = value; };
    },
  });
  let denyPin = false;
  let spawns = 0;
  extension(api, { pin: async () => { if (denyPin) throw new Error('Unsupported Pi invocation'); return invocation; }, run: (args) => runChild({ ...args, invocation, backend: { ...processBackend, spawn: (_invocation, argv, options) => { spawns++; return spawn(process.execPath, [fileURLToPath(new URL('./child-fixture.mjs', import.meta.url)), 'success', ...argv], options); } } }) });
  assert.ok(tool);
  const execute = tool.execute;
  const request = { agent: 'general-purpose', task: 'task', role: /** @type {const} */ ('feature') };
  for (const injected of [{ model: 'fixture/missing' }, { role: 'typo', model: 'fixture/explicit' }, { model: 'auto' }, { configPath: '/tmp/models.json' }, { provider: 'fixture' }, { trust: true }]) {
    await assert.rejects(execute('reject', JSON.parse(JSON.stringify({ ...request, ...injected })),  undefined, undefined, context()));
  }
  const controller = new AbortController();
  const cancelled = new Proxy(context(), { get(target, name) { if (name === 'cwd') controller.abort(); return Reflect.get(target, name); } });
  await assert.rejects(execute('cancel', request, controller.signal, undefined, cancelled), /cancelled/);
  denyPin = true;
  await assert.rejects(execute('bad-invocation', { tasks: [request, request] }, undefined, undefined, context()), /Unsupported Pi/);
  denyPin = false;
  assert.equal(spawns, 0, 'Rejection, cancellation, and invocation validation stay spawn-free');
  const explicit = await execute('explicit', { ...request, model: 'fixture/explicit' }, undefined, undefined, context());
  assert.ok(JSON.stringify(explicit.details).includes('"id":"explicit","thinkingLevel":"off"'));
  const first = await execute('first', request, undefined, undefined, context());
  assert.ok(JSON.stringify(first.details).includes('"id":"first","thinkingLevel":"off"'));
  const changed = context();
  const captured = new Proxy(changed, { get(target, name) { if (name === 'cwd') { target.model = undefined; target.thinkingLevel = 'off'; } return Reflect.get(target, name); } });
  const inherited = await execute('inherited', request, undefined, undefined, captured);
  assert.ok(JSON.stringify(inherited.details).includes('"id":"parent","thinkingLevel":"high"'));
  assert.ok(JSON.stringify(inherited.details).includes('"observed":{"provider":"fixture","id":"parent"}'));
  const last = await execute('last', request, undefined, undefined, context());
  assert.ok(JSON.stringify(last.details).includes('"id":"last","thinkingLevel":"off"'));
});
