import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModelConfig, ModelRouter, parseModelChoice, parseModelConfig, parseRole, roles } from '../../extensions/subagent/model-config.ts';

const config = (roles = {}) => parseModelConfig(Buffer.from(JSON.stringify({ version: 1, roles })));
/** @param {string} id */
const pinned = (id) => ({ kind: 'pinned', provider: 'fixture', id });

test('role registry is closed, stable, and covers planned workflow choices', () => {
  assert.deepEqual(roles, [
    'feature', 'refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment', 'prose', 'hardest',
    'how-explorer', 'how-explainer', 'how-critics', 'why-investigator', 'why-synthesizer',
    'reflect-tooling', 'reflect-judgment', 'reflect-divergent', 'reflect-synthesizer',
    'arena-runner', 'arena-cross-judge', 'swarm-worker', 'architect-runner', 'interrogate-reviewer',
    'no-comments', 'review', 'test', 'verify',
  ]);
  for (const role of roles) assert.equal(parseRole(role), role);
  for (const role of ['Feature', 'auto', '__proto__', 'feature\n', '', null]) assert.throws(() => parseRole(role));
});

test('exact bounded ASCII model grammar splits only the first slash', () => {
  assert.deepEqual(parseModelChoice('inherit-parent'), { kind: 'inheritParent' });
  assert.deepEqual(parseModelChoice('fixture/org/Model:tag+1'), pinned('org/Model:tag+1'));
  assert.deepEqual(parseModelChoice('fixture/@cf/model'), pinned('@cf/model'));
  assert.ok(parseModelChoice(`${'a'.repeat(64)}/${'b'.repeat(256)}`));
  for (const value of ['auto', 'parent', 'model', 'Fixture/model', 'fixture/', '/model', ' fixture/model', 'fixture/model\n', 'fixture/*', 'fixture/model?x', 'fixture/mödel', 'fixture/--flag', 'fixture/a b', 'fixture/a\\b', 'fixture/a\0', `${'a'.repeat(65)}/b`, `a/${'b'.repeat(257)}`, [], {}, null]) {
    assert.throws(() => parseModelChoice(value), JSON.stringify(value));
  }
});

test('strict JSON rejects duplicates, malformed encoding, trailing data, schema drift, and excessive input', () => {
  assert.equal(config().size, 0);
  assert.equal(config({ feature: ['fixture/a', 'inherit-parent', 'fixture/a'] }).get('feature')?.kind, 'pool');
  for (const text of [
    '', '{}', '{"version":2,"roles":{}}', '{"version":1,"roles":{},"path":"/tmp"}',
    '{"version":1,"version":1,"roles":{}}', '{"version":1,"roles":{"feature":"fixture/a","featur\\u0065":"fixture/b"}}',
    '{"version":1,"roles":{}} true', '{"version":1,"roles":{},}', '\ufeff{"version":1,"roles":{}}',
    '{"version":1,"roles":{"unknown":"inherit-parent"}}', '{"version":1,"roles":{"__proto__":"inherit-parent"}}',
    '{"version":1,"roles":{"feature":[]}}', '{"version":1,"roles":{"feature":{"model":"fixture/a"}}}',
    '{"version":1,"roles":{"feature":"auto"}}', '{"version":1,"roles":null}',
    JSON.stringify({ version: 1, roles: { feature: Array(65).fill('inherit-parent') } }),
    '['.repeat(33) + '0' + ']'.repeat(33), ' '.repeat(65537),
  ]) assert.throws(() => parseModelConfig(Buffer.from(text)), text.slice(0, 100));
  assert.throws(() => parseModelConfig(Buffer.from([0xff])));
});

test('bounded no-follow loading rejects unsafe directories, modes, links, special files, and oversized files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'routing-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await loadModelConfig(root)).size, 0);
  const directory = path.join(root, 'pstack-pi');
  const file = path.join(directory, 'models.json');
  await mkdir(directory, { mode: 0o700 });
  assert.equal((await loadModelConfig(root)).size, 0);
  const good = '{"version":1,"roles":{"feature":"inherit-parent"}}';
  await writeFile(file, good, { mode: 0o600 });
  assert.equal((await loadModelConfig(root)).size, 1);
  for (const mode of [0o666, 0o620, 0o4600]) {
    await chmod(file, mode); await assert.rejects(loadModelConfig(root), /Unsafe/);
  }
  await chmod(file, 0o600);
  await chmod(directory, 0o777); await assert.rejects(loadModelConfig(root), /Unsafe/);
  await chmod(directory, 0o700);
  await writeFile(file, ' '.repeat(65537)); await assert.rejects(loadModelConfig(root), /byte limit/);
  await rm(file); await symlink('../elsewhere', file); await assert.rejects(loadModelConfig(root));
  await rm(file); await mkdir(file); await assert.rejects(loadModelConfig(root));
  await rm(file, { recursive: true }); execFileSync('mkfifo', [file]); await assert.rejects(loadModelConfig(root));
  await rm(directory, { recursive: true }); await symlink(root, directory); await assert.rejects(loadModelConfig(root), /Unsafe/);
});

test('precedence, rejected preparation, explicit overrides, and per-role admission counters', () => {
  const router = new ModelRouter();
  const cfg = config({ feature: ['fixture/a', 'inherit-parent', 'fixture/a', 'fixture/b'], review: ['fixture/c', 'fixture/d'] });
  const prepare = (extra = {}) => router.prepare({ config: cfg, role: 'feature', agentModel: 'fixture/default', ...extra });
  assert.throws(() => prepare({ role: 'typo', model: 'fixture/explicit' }), /Unknown/);
  assert.throws(() => prepare({ model: 'auto' }));
  assert.deepEqual(prepare().selection.choice, pinned('a'));
  assert.deepEqual(prepare().selection.choice, pinned('a'), 'uncommitted preparation consumes nothing');
  const explicit = prepare({ model: 'fixture/explicit' }); explicit.commit();
  assert.deepEqual(explicit.selection, { source: 'explicit', choice: pinned('explicit') });
  const first = prepare(); first.commit(); assert.throws(() => first.commit());
  assert.deepEqual(prepare().selection.choice, { kind: 'inheritParent' });
  const other = prepare({ role: 'review' }); other.commit(); assert.deepEqual(other.selection.choice, pinned('c'));
  const second = prepare(); second.commit();
  const third = prepare(); third.commit(); assert.deepEqual(third.selection.choice, pinned('a'), 'duplicates stay in pools');
  assert.deepEqual(prepare().selection.choice, pinned('b'));
  assert.deepEqual(prepare({ role: 'test' }).selection, { source: 'agent', choice: pinned('default') });
  assert.deepEqual(prepare({ role: 'test', agentModel: undefined }).selection, { source: 'parent', choice: { kind: 'inheritParent' } });
  assert.deepEqual(prepare({ role: 'test', agentModel: 'inherit-parent' }).selection, { source: 'agent', choice: { kind: 'inheritParent' } });
  assert.deepEqual(prepare({ model: 'inherit-parent' }).selection, { source: 'explicit', choice: { kind: 'inheritParent' } });
});

test('only changed normalized assignments reset counters', () => {
  const router = new ModelRouter();
  /** @param {import('../../extensions/subagent/model-config.ts').RoleConfig} cfg */
  const prepare = (cfg, role = 'feature') => router.prepare({ config: cfg, role });
  const a = { feature: ['fixture/a', 'fixture/b'], review: ['fixture/c', 'fixture/d'] };
  prepare(config(a)).commit(); prepare(config(a), 'review').commit();
  assert.deepEqual(prepare(config({ review: a.review, feature: a.feature })).selection.choice, pinned('b'));
  const changed = { ...a, review: ['fixture/x', 'fixture/y'] };
  assert.deepEqual(prepare(config(changed)).selection.choice, pinned('b'));
  assert.deepEqual(prepare(config(changed), 'review').selection.choice, pinned('x'));
  prepare(config({ review: a.review }));
  assert.deepEqual(prepare(config(a)).selection.choice, pinned('a'));
});
