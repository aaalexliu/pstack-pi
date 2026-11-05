import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  exportProfile,
  launchProfile,
  loadProfileConfig,
  parseProfileConfig,
  profileConfigPath,
  profileVariable,
  selectProfile,
} from '../../extensions/profiles/config.ts';

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'pstack-profiles-'));
  for (const dir of ['clients/client-a/repo', 'clients/client-a-old', 'clients/client-b', 'elsewhere']) await mkdir(join(root, dir), { recursive: true });
  return root;
}

/** @param {string} root */
function config(root) {
  return parseProfileConfig(JSON.stringify({
    profiles: {
      clients: { dirs: [join(root, 'clients')], providers: ['openai'] },
      'client-a': { dirs: [join(root, 'clients/client-a')], providers: ['anthropic', 'anthropic'] },
    },
  }));
}

test('the deepest configured folder wins, matched on real paths and whole segments', async () => {
  const root = await tree();
  const profiles = config(root);
  assert.equal(profiles.error, undefined);
  assert.deepEqual(profiles.profiles.find((profile) => profile.name === 'client-a')?.providers, ['anthropic']);
  const canonicalRoot = await realpath(root);
  const pick = (/** @type {string} */ cwd) => selectProfile(profiles, cwd, undefined);
  assert.equal(pick(join(canonicalRoot, 'clients/client-a/repo')).profile?.name, 'client-a');
  assert.equal(pick(join(root, 'clients/client-a')).source, 'directory');
  assert.equal(pick(join(root, 'clients/client-a-old')).profile?.name, 'clients');
  assert.equal(pick(join(root, 'clients/client-b')).profile?.name, 'clients');
  assert.deepEqual(pick(join(root, 'elsewhere')), { profile: undefined, source: 'none' });
});

test('a profile inherited from a parent Pi beats the folder', async () => {
  const root = await tree();
  const profiles = config(root);
  assert.equal(selectProfile(profiles, join(root, 'elsewhere'), 'client-a').profile?.name, 'client-a');
  assert.deepEqual(selectProfile(profiles, join(root, 'clients/client-a/repo'), 'default'), { profile: undefined, source: 'inherited' });
  const unknown = selectProfile(profiles, join(root, 'clients/client-a/repo'), 'ghost');
  assert.equal(unknown.profile, undefined);
  assert.match(unknown.warning ?? '', /PI_AUTH_PROFILE=ghost/u);
});

test('bad config disables every profile and says why', () => {
  for (const [text, pattern] of [
    ['{', /invalid JSON/u],
    ['{"profiles": []}', /expected/u],
    ['{"profiles": {"default": {"dirs": [], "providers": ["anthropic"]}}}', /slug/u],
    ['{"profiles": {"Work": {"dirs": [], "providers": ["anthropic"]}}}', /slug/u],
    ['{"profiles": {"work": {"dirs": ["relative/dir"], "providers": ["anthropic"]}}}', /absolute/u],
    ['{"profiles": {"work": {"dirs": ["/x"], "providers": []}}}', /providers/u],
  ]) {
    const parsed = parseProfileConfig(/** @type {string} */ (text));
    assert.deepEqual(parsed.profiles, []);
    assert.match(parsed.error ?? '', /** @type {RegExp} */ (pattern));
  }
});

test('home-relative dirs expand and a missing file means no profiles', async () => {
  const home = await tree();
  const parsed = parseProfileConfig('{"profiles": {"client-a": {"dirs": ["~/clients/client-a"], "providers": ["anthropic"]}}}', home);
  assert.equal(selectProfile(parsed, join(home, 'clients/client-a/repo'), undefined).profile?.name, 'client-a');
  const agentDir = await mkdtemp(join(tmpdir(), 'pstack-profiles-agent-'));
  assert.deepEqual(loadProfileConfig(agentDir), { profiles: [] });
  await mkdir(join(agentDir, 'pstack-pi'));
  await writeFile(profileConfigPath(agentDir), '{"profiles": {"client-a": {"dirs": ["~/clients/client-a"], "providers": ["anthropic"]}}}');
  assert.equal(loadProfileConfig(agentDir, home).profiles[0]?.name, 'client-a');
});

test('the launch profile is read once, before this process exports its own', () => {
  const holder = {};
  const env = { [profileVariable]: 'client-a' };
  assert.equal(launchProfile(env, holder), 'client-a');
  exportProfile({ profile: undefined, source: 'none' }, env);
  assert.equal(env[profileVariable], 'default');
  assert.equal(launchProfile(env, holder), 'client-a');
  assert.equal(launchProfile({}, {}), undefined);
});
