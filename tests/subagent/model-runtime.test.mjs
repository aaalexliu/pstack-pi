import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { captureParent, qualifyModel } from '../../extensions/subagent/model-runtime.ts';
import { parseModelChoice } from '../../extensions/subagent/model-config.ts';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'model-runtime-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const modelsPath = path.join(agentDir, 'models.json');
  const authPath = path.join(agentDir, 'auth.json');
  const providers = { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture-key', models: [
    { id: 'parent', reasoning: true }, { id: 'pinned', reasoning: true }, { id: 'org/model:tag' },
    { id: 'fixture/pinned' }, { id: 'Case' }, { id: 'case' },
    { id: 'always-thinking', reasoning: true, thinkingLevelMap: { off: null } },
  ] } };
  await writeFile(modelsPath, JSON.stringify({ providers }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({ modelsPath, authPath });
  const parent = { model: { provider: 'fixture', id: 'parent' }, thinkingLevel: /** @type {const} */ ('high') };
  /** @param {string} choice @param {Partial<import('../../extensions/subagent/model-runtime.ts').ParentSnapshot>} [override] */
  const qualify = (choice, override = {}) => qualifyModel({
    selection: { source: 'explicit', choice: parseModelChoice(choice) }, parent: { ...parent, ...override }, agentDir, signal: new AbortController().signal,
  });
  return { agentDir, modelsPath, authPath, providers, runtime, parent, qualify };
}

test('standalone exact models use off when pinned and preserve inherited thinking', async (t) => {
  const f = await fixture(t);
  const files = await readdir(f.agentDir);
  const before = await Promise.all(files.map((name) => readFile(path.join(f.agentDir, name))));
  assert.deepEqual(await f.qualify('inherit-parent'), { provider: 'fixture', id: 'parent', thinkingLevel: 'high' });
  assert.deepEqual(await readdir(f.agentDir), files);
  assert.deepEqual(await Promise.all(files.map((name) => readFile(path.join(f.agentDir, name)))), before);
  assert.deepEqual(await f.qualify('fixture/pinned'), { provider: 'fixture', id: 'pinned', thinkingLevel: 'off' });
  assert.deepEqual(await f.qualify('fixture/org/model:tag'), { provider: 'fixture', id: 'org/model:tag', thinkingLevel: 'off' });
  assert.deepEqual(await f.qualify('fixture/pinned', { model: undefined }), { provider: 'fixture', id: 'pinned', thinkingLevel: 'off' });
  await assert.rejects(f.qualify('inherit-parent', { model: undefined }), /active parent/);
  await assert.rejects(f.qualify('inherit-parent', { thinkingLevel: undefined }), /thinking level/);
  await assert.rejects(f.qualify('fixture/always-thinking'), /thinking level/);
});

test('CLI prefix stripping and case-folded ambiguity fail closed after exact catalog lookup', async (t) => {
  const f = await fixture(t);
  for (const choice of ['fixture/par', 'fixture/PARENT', 'missing/parent']) await assert.rejects(f.qualify(choice), /Exact model/);
  for (const choice of ['fixture/fixture/pinned', 'fixture/case']) await assert.rejects(f.qualify(choice), /CLI cannot select/);
});

test('extension-registered parent providers qualify through the standalone registry alone', async (t) => {
  const f = await fixture(t);
  const registry = new ModelRegistry(f.runtime);
  registry.registerProvider('fixture', { baseUrl: 'https://wrapped-by-extension.invalid/v1', api: 'openai-completions', apiKey: 'extension-private', models: [{ id: 'parent', name: 'Parent', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }] });
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({ model: registry.find('fixture', 'parent'), thinkingLevel: 'high', modelRegistry: registry });
  const parent = captureParent(ctx);
  assert.deepEqual(parent, { model: { provider: 'fixture', id: 'parent' }, thinkingLevel: 'high' });
  const child = await qualifyModel({ selection: { source: 'parent', choice: { kind: 'inheritParent' } }, parent, agentDir: f.agentDir, signal: new AbortController().signal });
  assert.deepEqual(child, { provider: 'fixture', id: 'parent', thinkingLevel: 'high' });
  assert.ok(!JSON.stringify(child).includes('extension-private'));
  registry.registerProvider('only-extension', { baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'private', models: [{ id: 'ghost', name: 'Ghost', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }] });
  await assert.rejects(qualifyModel({ selection: { source: 'parent', choice: { kind: 'inheritParent' } }, parent: { model: { provider: 'only-extension', id: 'ghost' }, thinkingLevel: 'off' }, agentDir: f.agentDir, signal: new AbortController().signal }), /Exact model/);
});

test('runtime keys and extension-only providers do not leak into leaf qualification', async (t) => {
  const f = await fixture(t);
  assert.ok(f.parent.model);
  await assert.rejects(f.qualify('inherit-parent', { model: { ...f.parent.model, provider: 'fixture/nested' } }), /Invalid exact model identity/);
  await writeFile(f.modelsPath, JSON.stringify({ providers: { fixture: { ...f.providers.fixture, apiKey: undefined } } }));
  await f.runtime.setRuntimeApiKey('fixture', 'parent-runtime-secret');
  await assert.rejects(f.qualify('fixture/pinned'), /standalone stored/);
  const registry = new ModelRegistry(f.runtime);
  registry.registerProvider('only-parent', { baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'private', models: [] });
  await assert.rejects(f.qualify('only-parent/pinned'), /Exact model/);
});

test('stored and config environment auth remain standard and credentials never enter the resolved model', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.modelsPath);
  await writeFile(f.modelsPath, JSON.stringify({ providers: { fixture: { ...f.providers.fixture, apiKey: undefined } } }));
  await writeFile(f.authPath, JSON.stringify({ fixture: { type: 'api_key', key: 'stored-private-value' } }), { mode: 0o600 });
  assert.deepEqual(await f.qualify('fixture/pinned'), { provider: 'fixture', id: 'pinned', thinkingLevel: 'off' });
  await rm(f.authPath);
  await assert.rejects(f.qualify('fixture/pinned'), /auth file is missing/);
  await assert.rejects(readFile(f.authPath), { code: 'ENOENT' });
  await writeFile(f.authPath, '{}', { mode: 0o600 });
  const key = 'MODEL_RUNTIME_TEST_KEY';
  process.env[key] = 'environment-private-value';
  t.after(() => { delete process.env[key]; });
  await writeFile(f.modelsPath, JSON.stringify({ providers: { fixture: { ...f.providers.fixture, apiKey: `$${key}` } } }));
  assert.ok(!JSON.stringify(await f.qualify('fixture/pinned')).includes('private'));
  delete process.env[key];
  await assert.rejects(f.qualify('fixture/pinned'), /standalone stored/);
  await writeFile(f.modelsPath, before);
});

for (const location of ['apiKey', 'headers', 'auth', 'cache', 'unused provider']) {
  test(`command config in ${location} fails without executing it`, async (t) => {
    const f = await fixture(t);
    const marker = path.join(f.agentDir, 'executed');
    const command = `!touch ${marker}`;
    if (location === 'auth') await writeFile(f.authPath, JSON.stringify({ fixture: { type: 'api_key', key: command } }), { mode: 0o600 });
    else if (location === 'cache') await writeFile(path.join(f.agentDir, 'models-store.json'), JSON.stringify({ ignored: command }));
    else {
      const provider = location === 'apiKey' ? { ...f.providers.fixture, apiKey: command } : { ...f.providers.fixture, headers: { secret: command } };
      await writeFile(f.modelsPath, JSON.stringify({ providers: location === 'unused provider' ? { ...f.providers, unused: provider } : { fixture: provider } }));
    }
    await assert.rejects(f.qualify('fixture/pinned'), /Command-backed/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
}

test('invalid standard config, unsupported APIs, missing env auth, and pre-abort fail closed', async (t) => {
  const f = await fixture(t);
  await writeFile(f.modelsPath, 'PRIVATE_BROKEN_CONFIG');
  await assert.rejects(f.qualify('fixture/pinned'), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Invalid standalone Pi config JSON');
    return true;
  });
  await writeFile(f.modelsPath, JSON.stringify({ providers: { fixture: { ...f.providers.fixture, apiKey: '$PSTACK_PRIVATE_KEY' } } }));
  await assert.rejects(f.qualify('fixture/pinned'), /child-filtered/);
  await writeFile(f.modelsPath, JSON.stringify({ providers: { fixture: { ...f.providers.fixture, api: 'extension-only-api' } } }));
  await assert.rejects(f.qualify('fixture/pinned'), /not supported|Invalid standalone/);
  for (const api of ['bedrock-converse-stream', 'google-vertex']) {
    await writeFile(f.modelsPath, JSON.stringify({ providers: { fixture: { ...f.providers.fixture, api } } }));
    await assert.rejects(f.qualify('fixture/pinned'), /not supported|Invalid standalone/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(qualifyModel({ selection: { source: 'parent', choice: { kind: 'inheritParent' } }, parent: f.parent, agentDir: '/never-read-this', signal: controller.signal }));
});

test('parent snapshot reads model and thinking once and keeps only the model identity', async (t) => {
  const f = await fixture(t);
  const active = f.runtime.getModel('fixture', 'parent');
  assert.ok(active);
  let modelReads = 0; let thinkingReads = 0;
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({
    get model() { modelReads++; return active; },
    get thinkingLevel() { thinkingReads++; return 'high'; },
    modelRegistry: new ModelRegistry(f.runtime),
  });
  const snapshot = captureParent(ctx);
  assert.deepEqual(snapshot, { model: { provider: 'fixture', id: 'parent' }, thinkingLevel: 'high' });
  assert.ok(!('baseUrl' in (snapshot.model ?? {})) && !('headers' in (snapshot.model ?? {})));
  assert.equal(modelReads, 1); assert.equal(thinkingReads, 1);
});
