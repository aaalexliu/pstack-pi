import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseProfileConfig, profileVariable } from '../../extensions/profiles/config.ts';
import virtualProfiles, { aliasProvider, routeModel, virtualModels } from '../../extensions/profiles/virtual.ts';

const clientA = { name: 'client-a', dirs: ['/work/client-a'], providers: ['anthropic'] };

/** @param {Record<string, boolean>} signedIn */
function registry(signedIn) {
  return {
    find: (/** @type {string} */ provider, /** @type {string} */ id) => (provider in signedIn ? /** @type {any} */ ({ provider, id }) : undefined),
    hasConfiguredAuth: (/** @type {any} */ model) => signedIn[model.provider] === true,
  };
}

test('a virtual model routes to the profile login and falls back to the default login', () => {
  const both = registry({ anthropic: true, 'anthropic-client-a': true, xai: true, 'xai-client-a': true });
  assert.equal(routeModel(both, 'anthropic', 'claude-opus-5-5', clientA).provider, 'anthropic-client-a');
  assert.equal(routeModel(both, 'anthropic', 'claude-opus-5-5', undefined).provider, 'anthropic');
  assert.equal(routeModel(both, 'xai', 'grok-4.5', clientA).provider, 'xai');
  const notSignedIn = registry({ anthropic: true, 'anthropic-client-a': false });
  assert.equal(routeModel(notSignedIn, 'anthropic', 'claude-opus-5-5', clientA).provider, 'anthropic');
  assert.throws(() => routeModel(registry({}), 'anthropic', 'claude-opus-5-5', clientA), /not in the model catalog/u);
});

test('an alias reuses the composed provider under its own name and signs in only with its own login', async () => {
  const oauth = { name: 'Anthropic (Claude Pro/Max)', login: async () => ({}) };
  const streamSimple = () => {};
  const source = /** @type {any} */ ({
    id: 'anthropic',
    name: 'Anthropic',
    auth: {
      oauth,
      apiKey: { name: 'Anthropic API key', resolve: async (/** @type {any} */ input) => ({ auth: { apiKey: input.credential?.key ?? 'from-env' } }) },
    },
    getModels: () => [{ provider: 'anthropic', id: 'claude-opus-5-5' }],
    getAllModels: () => [{ provider: 'anthropic', id: 'claude-opus-5-5' }, { provider: 'anthropic', id: 'classifier' }],
    refreshModels: async () => {},
    stream: () => {},
    streamSimple,
  });
  const alias = /** @type {any} */ (aliasProvider(source, 'anthropic-client-a', 'Anthropic (clientA)'));
  assert.equal(alias.id, 'anthropic-client-a');
  assert.deepEqual(alias.getModels(), [{ provider: 'anthropic-client-a', id: 'claude-opus-5-5' }]);
  assert.equal(alias.getAllModels().length, 2);
  assert.equal(alias.streamSimple, streamSimple);
  assert.equal(alias.auth.oauth, oauth);
  assert.equal('refreshModels' in alias, false);
  assert.equal(await alias.auth.apiKey.check({}), undefined);
  assert.equal(await alias.auth.apiKey.resolve({}), undefined);
  assert.deepEqual(await alias.auth.apiKey.resolve({ credential: { type: 'api_key', key: 'k' } }), { auth: { apiKey: 'k' } });
});

test('virtual models cover each routed base provider catalog once', () => {
  const config = parseProfileConfig(JSON.stringify({ profiles: { 'client-a': { dirs: ['/work/client-a'], providers: ['anthropic', 'not-a-provider'] } } }));
  const models = virtualModels(config);
  assert.ok(models.size > 0);
  for (const [id, { base, model }] of models) {
    assert.equal(base, 'anthropic');
    assert.equal(model.id, id);
  }
});

test('session_start registers an alias for every profile and routes by the selected profile', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pstack-profiles-agent-'));
  const work = join(agentDir, 'work');
  await mkdir(join(work, 'client-a/repo'), { recursive: true });
  await mkdir(join(agentDir, 'pstack-pi'));
  await writeFile(join(agentDir, 'pstack-pi/profiles.json'), JSON.stringify({ profiles: { 'client-a': { dirs: [join(work, 'client-a')], providers: ['anthropic'] } } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  /** @type {Map<string, any>} */
  const handlers = new Map();
  /** @type {any[]} */
  const virtual = [];
  /** @type {any[]} */
  const registered = [];
  /** @type {string[]} */
  const removed = [];
  virtualProfiles(/** @type {any} */ ({
    on: (/** @type {string} */ name, /** @type {any} */ handler) => handlers.set(name, handler),
    registerVirtualModel: (/** @type {any} */ model) => virtual.push(model),
    unregisterVirtualModel: (/** @type {string} */ _provider, /** @type {string} */ id) => removed.push(id),
    registerProvider: (/** @type {any} */ provider) => registered.push(provider),
    unregisterProvider: (/** @type {string} */ id) => removed.push(id),
  }));
  assert.ok(virtual.length > 0);
  assert.ok(virtual.every((model) => model.provider === 'virtual'));

  const signedIn = registry({ anthropic: true, 'anthropic-client-a': true });
  /** @type {Array<string | undefined>} */
  const statuses = [];
  let aliasLoggedIn = false;
  const ctx = {
    cwd: join(work, 'client-a/repo'),
    model: { provider: 'virtual', id: virtual[0].id },
    hasUI: true,
    ui: { notify() {}, setStatus: (/** @type {string} */ _key, /** @type {string | undefined} */ text) => statuses.push(text) },
    modelRegistry: {
      ...signedIn,
      getProvider: (/** @type {string} */ id) => (id === 'anthropic' ? { id, name: 'Anthropic', auth: {}, getModels: () => [] } : undefined),
      getProviderAuthStatus: () => ({ configured: aliasLoggedIn }),
    },
  };
  await handlers.get('session_start')({}, ctx);
  assert.deepEqual(registered.map((provider) => provider.id), ['anthropic-client-a']);
  assert.equal(process.env[profileVariable], 'client-a');
  assert.equal(statuses.at(-1), 'profile: client-a (anthropic: default login)');
  const [first] = virtual;
  assert.equal(first.route({ model: first, thinkingLevel: 'high' }, ctx).model.provider, 'anthropic-client-a');
  aliasLoggedIn = true;
  handlers.get('turn_start')({}, ctx);
  assert.equal(statuses.at(-1), 'profile: client-a');
  handlers.get('model_select')({ model: { provider: 'openai', id: 'gpt-6-astra' } }, ctx);
  assert.equal(statuses.at(-1), 'profile: client-a (openai: default login)');
  handlers.get('model_select')({ model: { provider: 'anthropic-client-a', id: 'claude-opus-5-5' } }, ctx);
  assert.equal(statuses.at(-1), 'profile: client-a');

  handlers.get('session_shutdown')();
  assert.ok(removed.includes('anthropic-client-a'));
  assert.equal(removed.length, virtual.length + 1);
});
