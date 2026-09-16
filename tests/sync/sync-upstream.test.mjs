import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncUpstream } from '../../scripts/sync-upstream.mjs';
import { fixture, snapshot } from './fixture.mjs';

const script = fileURLToPath(new URL('../../scripts/sync-upstream.mjs', import.meta.url));

test('check reports missing output without creating files, and sync is idempotent', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.outputRoot);
  const roots = await readdir(f.outputRoot);
  const missing = await syncUpstream({ ...f.options, mode: 'check' });
  assert.equal(missing.clean, false);
  assert.equal(missing.differences.length, 4);
  assert.ok(missing.differences.every((difference) => difference.kind === 'missing'));
  assert.deepEqual(await snapshot(f.outputRoot), before);
  assert.deepEqual(await readdir(f.outputRoot), roots);
  await syncUpstream({ ...f.options, mode: 'sync' });
  const first = await snapshot(f.outputRoot);
  const stats = await Promise.all([...f.expected.keys()].map((name) => lstat(path.join(f.outputRoot, name))));
  assert.deepEqual(await syncUpstream({ ...f.options, mode: 'sync' }), { clean: true, differences: [] });
  assert.deepEqual(await snapshot(f.outputRoot), first);
  const rerunStats = await Promise.all([...f.expected.keys()].map((name) => lstat(path.join(f.outputRoot, name))));
  assert.deepEqual(rerunStats.map(({ ino, mtimeMs, mode }) => ({ ino, mtimeMs, mode })), stats.map(({ ino, mtimeMs, mode }) => ({ ino, mtimeMs, mode })));
  for (const [name, bytes] of Object.entries(before)) assert.equal(first[name], bytes);
});

test('check reports edits, extra files, missing files, and exact mode drift; sync repairs them', async (t) => {
  const f = await fixture(t);
  await syncUpstream({ ...f.options, mode: 'sync' });
  const pristine = await snapshot(f.outputRoot);
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'local edit');
  await chmod(path.join(f.outputRoot, 'agents/shared/run.sh'), 0o644);
  await chmod(path.join(f.outputRoot, 'skills/shared/transform.md'), 0o600);
  await rm(path.join(f.outputRoot, 'agents/shared/policy.md'));
  await writeFile(path.join(f.outputRoot, 'skills/shared/extra'), 'extra');
  const dirty = await snapshot(f.outputRoot);
  const result = await syncUpstream({ ...f.options, mode: 'check' });
  assert.deepEqual(result.differences, [
    { path: 'agents/shared/policy.md', kind: 'missing' },
    { path: 'agents/shared/run.sh', kind: 'mode-mismatched' },
    { path: 'skills/shared/copy.bin', kind: 'changed' },
    { path: 'skills/shared/extra', kind: 'extra' },
    { path: 'skills/shared/transform.md', kind: 'mode-mismatched' },
  ]);
  assert.deepEqual(await snapshot(f.outputRoot), dirty);
  await syncUpstream({ ...f.options, mode: 'sync' });
  assert.deepEqual(await snapshot(f.outputRoot), pristine);
  assert.equal((await lstat(path.join(f.outputRoot, 'agents/shared/run.sh'))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(f.outputRoot, 'skills/shared/transform.md'))).mode & 0o777, 0o644);
  assert.equal((await syncUpstream({ ...f.options, mode: 'check' })).clean, true);
});

test('a late validation failure preserves both managed roots and native sentinel', async (t) => {
  const f = await fixture(t);
  await syncUpstream({ ...f.options, mode: 'sync' });
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'prior output');
  const before = await snapshot(f.outputRoot);
  const output = f.lock.files.at(-1)?.output;
  assert.ok(output);
  output.sha256 = 'f'.repeat(64);
  await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /Output hash drift/u);
  assert.deepEqual(await snapshot(f.outputRoot), before);
  assert.ok(!(await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
});

test('staging validation rejects corrupt bytes before any root promotion', async (t) => {
  const f = await fixture(t);
  await syncUpstream({ ...f.options, mode: 'sync' });
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'prior output');
  const before = await snapshot(f.outputRoot);
  const originalWrite = fs.writeFile;
  /** @type {typeof fs.writeFile} */
  const corruptStage = async (filename, data, options) => originalWrite(filename,
    String(filename).includes('/content/agents/shared/run.sh') ? 'corrupt staged bytes' : data, options);
  const mocked = t.mock.method(fs, 'writeFile', corruptStage);
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /Staging validation failed/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await snapshot(f.outputRoot), before);
  assert.ok(!(await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
});

test('abort during staging leaves prior output and native files unchanged', async (t) => {
  const f = await fixture(t);
  await syncUpstream({ ...f.options, mode: 'sync' });
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'prior output');
  const before = await snapshot(f.outputRoot);
  const controller = new AbortController();
  const originalWrite = fs.writeFile;
  /** @type {typeof fs.writeFile} */
  const abortAfterStage = async (filename, data, options) => {
    const written = await originalWrite(filename, data, options);
    if (String(filename).includes('/content/')) controller.abort(new Error('fixture interruption'));
    return written;
  };
  const mocked = t.mock.method(fs, 'writeFile', abortAfterStage);
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncUpstream({ ...f.options, mode: 'sync', signal: controller.signal }), /fixture interruption/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await snapshot(f.outputRoot), before);
  assert.ok(!(await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
});

test('promotion failure rolls back earlier roots', async (t) => {
  const f = await fixture(t);
  await syncUpstream({ ...f.options, mode: 'sync' });
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'prior skill');
  await writeFile(path.join(f.outputRoot, 'agents/shared/policy.md'), 'prior agent');
  const before = await snapshot(f.outputRoot);
  const originalRename = fs.rename;
  /** @type {typeof fs.rename} */
  const failPromotion = async (source, destination) => {
    if (String(source).includes('/content/agents/shared')) throw new Error('fixture rename failure');
    return originalRename(source, destination);
  };
  const mocked = t.mock.method(fs, 'rename', failPromotion);
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /fixture rename failure/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await snapshot(f.outputRoot), before);
  assert.ok(!(await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
});

test('native path collisions and symlinked managed roots fail closed', async (t) => {
  const f = await fixture(t);
  await rename(path.join(f.outputRoot, 'skills'), path.join(f.outputRoot, 'Skills'));
  await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /Native-path collision/u);
  await rename(path.join(f.outputRoot, 'Skills'), path.join(f.outputRoot, 'skills'));
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'outside');
  await symlink(outside, path.join(f.outputRoot, 'skills/shared'));
  for (const mode of /** @type {const} */ (['sync', 'check'])) {
    await assert.rejects(syncUpstream({ ...f.options, mode }), /Symlink path/u);
    assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'outside');
  }
});

test('symlinked replacements and managed files cannot escape roots', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.replacementRoot, 'policy.md'));
  await symlink(path.join(f.outputRoot, 'package.json'), path.join(f.replacementRoot, 'policy.md'));
  await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /Symlink path/u);
  await rm(path.join(f.replacementRoot, 'policy.md'));
  await writeFile(path.join(f.replacementRoot, 'policy.md'), 'reviewed Pi policy\n');
  await syncUpstream({ ...f.options, mode: 'sync' });
  await symlink(path.join(f.outputRoot, 'package.json'), path.join(f.outputRoot, 'skills/shared/escape'));
  await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /Symlink path/u);
  assert.equal(await readFile(path.join(f.outputRoot, 'package.json'), 'utf8'), 'native package\n');
});

test('CLI rejects an invalid review reason before writes', async (t) => {
  const f = await fixture(t);
  const manifestPath = path.join(f.root, 'manifest.json');
  const lockPath = path.join(f.root, 'lock.json');
  await writeFile(lockPath, JSON.stringify(f.lock));
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  const valid = spawnSync(process.execPath, [script, 'sync', 'git', f.repositoryPath, f.outputRoot, manifestPath, lockPath, f.replacementRoot], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  const before = await snapshot(f.outputRoot);
  const omit = f.manifest.files.find((file) => file.kind === 'omit');
  assert.ok(omit);
  await writeFile(manifestPath, JSON.stringify({
    ...f.manifest,
    files: f.manifest.files.map((file) => file.kind === 'omit' ? { ...omit, reason: '' } : file),
  }));
  for (const mode of ['sync', 'check']) {
    const result = spawnSync(process.execPath, [script, mode, 'git', f.repositoryPath, f.outputRoot, manifestPath, lockPath, f.replacementRoot], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, /nonempty review reason/u);
    assert.equal(result.stdout, '');
    assert.deepEqual(await snapshot(f.outputRoot), before);
  }
});

test('CLI sync and check share the API contract and exit codes', async (t) => {
  const f = await fixture(t);
  const manifestPath = path.join(f.root, 'manifest.json');
  const lockPath = path.join(f.root, 'lock.json');
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  await writeFile(lockPath, JSON.stringify(f.lock));
  /** @param {string} mode */
  const cli = (mode) => spawnSync(process.execPath, [script, mode, 'git', f.repositoryPath, f.outputRoot, manifestPath, lockPath, f.replacementRoot], { encoding: 'utf8' });
  const missing = cli('check');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /missing skills\/shared\/copy.bin/u);
  const synced = cli('sync');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(cli('check').status, 0);
  assert.equal(cli('sync').stdout, '');
  const beforeReasonEdit = await snapshot(f.outputRoot);
  const lockedHashes = await readFile(lockPath, 'utf8');
  for (const file of f.manifest.files) {
    if (file.kind !== 'copy') file.reason = `Reviewed again. ${file.reason}`;
  }
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  for (const mode of ['check', 'sync']) {
    const unchanged = cli(mode);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.stdout, '');
  }
  assert.deepEqual(await snapshot(f.outputRoot), beforeReasonEdit);
  assert.equal(await readFile(lockPath, 'utf8'), lockedHashes);
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'changed');
  assert.match(cli('check').stdout, /changed skills\/shared\/copy.bin/u);
  assert.equal(cli('unknown').status, 1);
});
