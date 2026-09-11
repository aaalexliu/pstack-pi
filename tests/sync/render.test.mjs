import assert from 'node:assert/strict';
import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { syncUpstream } from '../../scripts/sync-upstream.mjs';
import { fixture, git, snapshot } from './fixture.mjs';

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {RegExp} message */
async function rejectsWithoutWrites(f, message) {
  const before = await snapshot(f.outputRoot);
  for (const mode of /** @type {const} */ (['sync', 'check'])) {
    await assert.rejects(syncUpstream({ ...f.options, mode }), message);
    assert.deepEqual(await snapshot(f.outputRoot), before);
  }
}

test('copy, ordered transform, replacement, and omission use locked Git objects', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repositoryPath, 'plugin/copy.bin'), 'branch-tip change');
  git(f.repositoryPath, ['add', '.']);
  git(f.repositoryPath, ['commit', '-qm', 'unlocked tip']);
  await writeFile(path.join(f.repositoryPath, 'plugin/transform.md'), 'dirty checkout');
  await syncUpstream({ ...f.options, mode: 'sync' });
  const actual = await snapshot(f.outputRoot);
  for (const [name, bytes] of f.expected) assert.equal(actual[name], bytes.toString('hex'));
  assert.equal(Object.keys(actual).length, f.expected.size + 2);
  assert.equal((await syncUpstream({ ...f.options, mode: 'check' })).clean, true);
});

test('new pinned upstream additions fail exhaustive classification', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repositoryPath, 'plugin/new.md'), 'new');
  f.advance('addition');
  await rejectsWithoutWrites(f, /Unclassified source: new.md/u);
});

test('new pinned upstream deletions fail classified coverage', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.repositoryPath, 'plugin/copy.bin'));
  f.advance('deletion');
  await rejectsWithoutWrites(f, /Missing classified source: copy.bin/u);
});

test('source tree, source blob, and source mode drift fail before writes', async (t) => {
  const f = await fixture(t);
  const tree = f.lock.sourceTree;
  f.lock.sourceTree = 'a'.repeat(40);
  await rejectsWithoutWrites(f, /Source tree drift/u);
  f.lock.sourceTree = tree;
  await writeFile(path.join(f.repositoryPath, 'plugin/copy.bin'), 'changed');
  f.advance('blob drift');
  await rejectsWithoutWrites(f, /Source blob drift/u);
  f.lock.files[0].blob = git(f.repositoryPath, ['rev-parse', `${f.lock.commit}:plugin/copy.bin`]);
  await chmod(path.join(f.repositoryPath, 'plugin/copy.bin'), 0o755);
  f.advance('mode drift');
  await rejectsWithoutWrites(f, /Source mode drift/u);
});

test('changed transform preimages and wrong ordered counts fail', async (t) => {
  const f = await fixture(t);
  const transform = f.manifest.files.find((file) => file.kind === 'transform');
  assert.ok(transform);
  transform.transforms[0].count = 1;
  await rejectsWithoutWrites(f, /Wrong transform count/u);
  transform.transforms[0].count = 2;
  transform.transforms.reverse();
  await rejectsWithoutWrites(f, /Wrong transform count/u);
  transform.transforms.reverse();
  await writeFile(path.join(f.repositoryPath, 'plugin/transform.md'), 'Cursor Cursor changed');
  f.advance('preimage drift');
  const locked = f.lock.files.find((file) => file.source === 'transform.md');
  assert.ok(locked);
  locked.blob = git(f.repositoryPath, ['rev-parse', `${f.lock.commit}:plugin/transform.md`]);
  await rejectsWithoutWrites(f, /Stale reviewed preimage/u);
});

test('replacement review becomes stale when upstream changes or replacement bytes change', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.replacementRoot, 'policy.md'), 'unreviewed replacement');
  await rejectsWithoutWrites(f, /Adaptation digest drift/u);
  await writeFile(path.join(f.replacementRoot, 'policy.md'), 'reviewed Pi policy\n');
  await writeFile(path.join(f.repositoryPath, 'plugin/replace.md'), 'new policy');
  f.advance('policy changed');
  const locked = f.lock.files.find((file) => file.source === 'replace.md');
  assert.ok(locked);
  locked.blob = git(f.repositoryPath, ['rev-parse', `${f.lock.commit}:plugin/replace.md`]);
  await rejectsWithoutWrites(f, /Stale reviewed preimage/u);
});

test('lock binds transform digests, output hashes, output modes, and destinations', async (t) => {
  const f = await fixture(t);
  const transform = f.manifest.files.find((file) => file.kind === 'transform');
  assert.ok(transform);
  transform.transforms[1].replace = 'Pi runtime';
  await rejectsWithoutWrites(f, /Adaptation digest drift/u);
  transform.transforms[1].replace = 'Pi host';
  const output = f.lock.files[0].output;
  assert.ok(output);
  const hash = output.sha256;
  output.sha256 = 'a'.repeat(64);
  await rejectsWithoutWrites(f, /Output hash drift/u);
  output.sha256 = hash;
  output.mode = '100755';
  await rejectsWithoutWrites(f, /Output mode drift/u);
  output.mode = '100644';
  output.destination = 'skills/shared/wrong';
  await rejectsWithoutWrites(f, /Locked destination differs/u);
});

test('repository identity and lock coverage must match', async (t) => {
  const f = await fixture(t);
  git(f.repositoryPath, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git']);
  await rejectsWithoutWrites(f, /Repository identity mismatch/u);
  git(f.repositoryPath, ['remote', 'set-url', 'origin', f.manifest.repository]);
  f.lock.files.pop();
  await rejectsWithoutWrites(f, /Lock coverage differs/u);
});
