import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { profileVariable } from '../../extensions/profiles/config.ts';
import storeSwapProfiles, { baseStore, profileFile, routeCredentials } from '../../extensions/profiles/store-swap.ts';

class MemoryStore {
  /** @type {string[]} */
  static created = [];
  /** @param {string} path */
  static create(path) {
    MemoryStore.created.push(path);
    return new MemoryStore();
  }
  /** @param {Record<string, any>} data */
  constructor(data = {}) {
    this.data = { ...data };
  }
  /** @param {string} id */
  async read(id) { return this.data[id]; }
  async list() { return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type })); }
  /** @param {string} id @param {(current: any) => Promise<any>} fn */
  async modify(id, fn) {
    const next = await fn(this.data[id]);
    if (next === undefined) return this.data[id];
    this.data[id] = next;
    return next;
  }
  /** @param {string} id */
  async delete(id) { delete this.data[id]; }
}

const personal = { type: 'oauth', access: 'personal', refresh: 'r1', expires: 1 };
const clientA = { type: 'oauth', access: 'client-a', refresh: 'r2', expires: 1 };
const owned = new Set(['anthropic']);

/** @param {MemoryStore | undefined} existing */
function file(existing) {
  let store = existing;
  return { existing: () => store, open: () => (store ??= new MemoryStore()), get: () => store };
}

/** Pi's OAuth refresh: only an existing OAuth entry is refreshed; anything else declines. */
const refresh = async (/** @type {any} */ current) => (current?.type === 'oauth' ? { ...current, access: `${current.access}+` } : undefined);

test('owned providers read the profile file, others and missing logins read the default file', async () => {
  const base = new MemoryStore({ anthropic: personal, xai: { type: 'oauth', access: 'grok' } });
  const routed = routeCredentials(base, file(new MemoryStore({ anthropic: clientA, xai: { type: 'oauth', access: 'ignored' } })), owned);
  assert.equal((await routed.read('anthropic'))?.access, 'client-a');
  assert.equal((await routed.read('xai'))?.access, 'grok');
  const borrowed = routeCredentials(base, file(undefined), owned);
  assert.equal((await borrowed.read('anthropic'))?.access, 'personal');
  assert.deepEqual((await routed.list()).map((entry) => entry.providerId).sort(), ['anthropic', 'xai']);
});

test('a login inside the profile lands in the profile file and leaves the default login alone', async () => {
  const base = new MemoryStore({ anthropic: personal });
  const profile = file(undefined);
  const routed = routeCredentials(base, profile, owned);
  await routed.modify('anthropic', async () => clientA);
  assert.equal(profile.get()?.data.anthropic, clientA);
  assert.equal(base.data.anthropic, personal);
});

test('refreshes go back to the file the credential came from', async () => {
  const base = new MemoryStore({ anthropic: personal });
  const empty = file(undefined);
  await routeCredentials(base, empty, owned).modify('anthropic', refresh);
  assert.equal(base.data.anthropic.access, 'personal+');
  assert.equal(empty.get()?.data.anthropic, undefined);

  const own = new MemoryStore({ anthropic: clientA });
  await routeCredentials(base, file(own), owned).modify('anthropic', refresh);
  assert.equal(own.data.anthropic.access, 'client-a+');
  assert.equal(base.data.anthropic.access, 'personal+');
});

test('logout inside the profile removes only the profile login', async () => {
  const base = new MemoryStore({ anthropic: personal });
  const own = new MemoryStore({ anthropic: clientA });
  await routeCredentials(base, file(own), owned).delete('anthropic');
  assert.equal(own.data.anthropic, undefined);
  assert.equal(base.data.anthropic, personal);
});

test('reading never creates the profile file; logging in does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-profiles-file-'));
  MemoryStore.created = [];
  const missing = profileFile(join(dir, 'auth.json'), MemoryStore);
  assert.equal(missing.existing(), undefined);
  assert.deepEqual(MemoryStore.created, []);
  missing.open();
  assert.deepEqual(MemoryStore.created, [join(dir, 'auth.json')]);
  await writeFile(join(dir, 'present.json'), '{}');
  assert.ok(profileFile(join(dir, 'present.json'), MemoryStore).existing());
});

test('session_start swaps the store inside the profile, exports it, and shutdown restores the original', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pstack-profiles-agent-'));
  const work = join(agentDir, 'work');
  await mkdir(join(work, 'client-a/repo'), { recursive: true });
  await mkdir(join(agentDir, 'pstack-pi'));
  await writeFile(join(agentDir, 'pstack-pi/profiles.json'), JSON.stringify({ profiles: { 'client-a': { dirs: [join(work, 'client-a')], providers: ['anthropic'] } } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  /** @type {Map<string, any>} */
  const handlers = new Map();
  storeSwapProfiles(/** @type {any} */ ({ on: (/** @type {string} */ name, /** @type {any} */ handler) => handlers.set(name, handler) }));
  const original = new MemoryStore({ anthropic: personal });
  const credentials = { store: /** @type {any} */ (original) };
  /** @type {any[]} */
  const refreshed = [];
  /** @type {Array<string | undefined>} */
  const statuses = [];
  const ctx = (/** @type {string} */ cwd) => ({
    cwd,
    hasUI: true,
    ui: { notify() {}, setStatus: (/** @type {string} */ _key, /** @type {string | undefined} */ text) => statuses.push(text) },
    modelRegistry: { runtime: { credentials }, refresh: async (/** @type {any} */ options) => { refreshed.push(options); } },
  });

  await handlers.get('session_start')({}, ctx(join(work, 'client-a/repo')));
  assert.notEqual(credentials.store, original);
  assert.equal(baseStore(credentials.store), original);
  assert.equal(process.env[profileVariable], 'client-a');
  assert.deepEqual(refreshed, [{ allowNetwork: false, providers: ['anthropic'] }]);
  assert.equal(statuses.at(-1), 'profile: client-a (default login: anthropic)');
  assert.equal(existsSync(join(agentDir, 'pstack-pi/profiles/client-a/auth.json')), false);

  handlers.get('session_shutdown')();
  assert.equal(credentials.store, original);
  await handlers.get('session_start')({}, ctx(work));
  assert.equal(credentials.store, original);
  assert.equal(process.env[profileVariable], 'default');
});
