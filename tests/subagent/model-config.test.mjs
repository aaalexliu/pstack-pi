import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatModelChoice, loadModelConfig, modelConfigPath, ModelRouter, parseModelChoice, parseModelConfig, roles } from '../../extensions/subagent/model-config.ts';

/** @param {unknown} value */
const choice = (value) => parseModelChoice(value);

test('model choices are inherit-parent or provider/model-id', () => {
  assert.deepEqual(parseModelChoice('inherit-parent'), { kind: 'inheritParent' });
  assert.deepEqual(parseModelChoice('openai-codex/gpt-5.6-sol'), { kind: 'pinned', provider: 'openai-codex', id: 'gpt-5.6-sol' });
  assert.deepEqual(parseModelChoice('fixture/org/model:tag'), { kind: 'pinned', provider: 'fixture', id: 'org/model:tag' });
  for (const bad of ['', 'gpt-4o', '/model', 'provider/', 'a b/c', 42]) assert.throws(() => choice(bad), /Invalid model choice/);
  assert.equal(formatModelChoice(parseModelChoice('a/b')), 'a/b');
  assert.equal(formatModelChoice({ kind: 'inheritParent' }), 'inherit-parent');
});

test('role config parses singles and pools and rejects unknown roles or shapes', () => {
  const config = parseModelConfig(JSON.stringify({ version: 1, roles: { feature: 'inherit-parent', review: ['a/one', 'b/two'] } }));
  assert.deepEqual(config.get('feature'), { kind: 'single', choice: { kind: 'inheritParent' } });
  assert.equal(config.get('review')?.kind, 'pool');
  assert.equal(parseModelConfig('{"version":1,"roles":{}}').size, 0);
  for (const bad of ['{"version":2,"roles":{}}', '{"version":1,"roles":{"unknown-role":"a/b"}}', '{"version":1,"roles":{"feature":[]}}', '{"version":1,"roles":{"feature":"not-a-model"}}', '{"version":1}']) {
    assert.throws(() => parseModelConfig(bad), /Invalid pstack-pi\/models.json|Invalid model choice/);
  }
  assert.throws(() => parseModelConfig('not json'), SyntaxError);
  assert.ok(roles.includes('feature') && roles.includes('swarm-worker'));
});

test('loadModelConfig treats a missing file as no roles and surfaces malformed files', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'model-config-'));
  assert.equal((await loadModelConfig(agentDir)).size, 0);
  await mkdir(path.dirname(modelConfigPath(agentDir)), { recursive: true });
  await writeFile(modelConfigPath(agentDir), JSON.stringify({ version: 1, roles: { 'bug-fix': 'fixture/fixer' } }));
  assert.deepEqual((await loadModelConfig(agentDir)).get('bug-fix'), { kind: 'single', choice: { kind: 'pinned', provider: 'fixture', id: 'fixer' } });
  await writeFile(modelConfigPath(agentDir), '{"version":1,"roles":{"feature":"nope"}}');
  await assert.rejects(loadModelConfig(agentDir), /Invalid pstack-pi\/models.json/);
  t.diagnostic(modelConfigPath(agentDir));
});

test('router precedence is explicit, role, agent, then parent; pools rotate per role', () => {
  const config = parseModelConfig(JSON.stringify({ version: 1, roles: { feature: ['a/one', 'b/two'], review: 'c/three' } }));
  const router = new ModelRouter();
  /** @param {{role?: import('../../extensions/subagent/model-config.ts').Role, model?: string, agentModel?: string}} input */
  const pick = (input) => { const s = router.select({ config, ...input }); return `${s.source}:${formatModelChoice(s.choice)}`; };
  assert.equal(pick({ model: 'x/explicit', role: 'review', agentModel: 'y/agent' }), 'explicit:x/explicit');
  assert.equal(pick({ role: 'review', agentModel: 'y/agent' }), 'role:c/three');
  assert.equal(pick({ agentModel: 'y/agent' }), 'agent:y/agent');
  assert.equal(pick({}), 'parent:inherit-parent');
  assert.equal(pick({ role: 'test' }), 'parent:inherit-parent', 'An unconfigured role falls through');
  assert.deepEqual([pick({ role: 'feature' }), pick({ role: 'feature' }), pick({ role: 'feature' })], ['role:a/one', 'role:b/two', 'role:a/one']);
  assert.equal(pick({ role: 'review' }), 'role:c/three', 'Another role does not disturb the pool cursor');
  assert.equal(pick({ role: 'feature' }), 'role:b/two');
  assert.throws(() => router.select({ config, model: 'bad' }), /Invalid model choice/);
});
