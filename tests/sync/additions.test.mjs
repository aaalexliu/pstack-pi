import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { importUpstream, parseLock, parseManifest, relockUpstream, serializeLock, sha256, syncUpstream } from '../../scripts/sync-upstream.mjs';
import { fixture, snapshot, validAddition, validLock, validLockedAddition, validManifest } from './fixture.mjs';

/** @param {import('node:test').TestContext} t */
async function addedFixture(t) {
  const f = await fixture(t);
  const source = 'sync/additions/owned.bin';
  const destination = 'skills/shared/owned.bin';
  const bytes = Buffer.from([239, 187, 191, 255, 0, 13, 10]);
  await mkdir(path.join(f.outputRoot, 'sync/additions'), { recursive: true });
  await writeFile(path.join(f.outputRoot, source), bytes);
  f.manifest.additions.push({ source, destination, mode: '100644', reason: 'Pi-owned fixture.' });
  f.lock.additions.push({ source, output: { destination, mode: '100644', sha256: sha256(bytes) } });
  return { ...f, sourcePath: path.join(f.outputRoot, source), destination, bytes };
}

test('version 2 requires additions arrays and rejects all legacy shapes', () => {
  for (const { parse, value } of [{ parse: parseManifest, value: validManifest() }, { parse: parseLock, value: validLock() }]) {
    const { additions, ...missing } = value;
    assert.deepEqual(additions, []);
    assert.throws(() => parse(missing), /fields/);
    for (const version of [1, 3, '2']) assert.throws(() => parse({ ...value, version }), /version/);
    for (const additions of [null, {}, false]) assert.throws(() => parse({ ...value, additions }), /array/);
  }
});

test('manifest and lock accept a valid addition before rejecting malformed rows', () => {
  const manifest = validManifest();
  const lock = validLock();
  const addition = validAddition();
  const locked = validLockedAddition();
  assert.deepEqual(parseManifest({ ...manifest, additions: [addition] }), { ...manifest, additions: [addition] });
  assert.deepEqual(parseLock({ ...lock, additions: [locked] }), { ...lock, additions: [locked] });
});

test('additions validate source, destination, mode, reason, fields, and combined collisions', () => {
  const manifest = validManifest();
  const lock = validLock();
  const addition = validAddition();
  for (const patch of [
    { source: 'sync/additions' }, { source: 'sync/replacements/x' }, { source: 'sync/additions/../x' },
    { source: 'sync/additions/CON' }, { source: 'sync/additions/X.' }, { source: 'sync/additions/a\\b' },
    { destination: 'extensions/x' }, { destination: 'skills/native/x' }, { destination: 'skills/shared/copy.bin' },
    { destination: 'skills/shared/COPY.bin' }, { destination: 'skills/shared/copy.bin/child' },
    { mode: '120000' }, { reason: ' ' }, { extra: true },
  ]) assert.throws(() => parseManifest({ ...manifest, additions: [{ ...addition, ...patch }] }));
  for (const source of [addition.source, 'sync/additions/OWNED.bin']) {
    assert.throws(() => parseManifest({ ...manifest, additions: [addition, { ...addition, source, destination: 'agents/shared/other' }] }), /collision/);
  }
  const locked = validLockedAddition();
  for (const patch of [{ sha256: 'bad' }, { mode: '120000' }, { destination: 'skills/shared/copy.bin' }, { destination: 'extensions/x' }]) {
    assert.throws(() => parseLock({ ...lock, additions: [{ ...locked, output: { ...locked.output, ...patch } }] }));
  }
  assert.throws(() => parseLock({ ...lock, additions: [{ ...locked, reason: 'extra' }] }), /fields/);
});

for (const mutation of ['extra', 'empty directory', 'missing', 'bytes', 'mode', 'symlink', 'directory symlink', 'fifo', 'native collision']) {
  test(`addition inputs reject ${mutation} before changing output`, async (t) => {
    const f = await addedFixture(t);
    await syncUpstream({ ...f.options, mode: 'sync' });
    const generated = await snapshot(path.join(f.outputRoot, 'skills'));
    if (mutation === 'extra') await writeFile(`${f.sourcePath}.extra`, 'extra');
    if (mutation === 'empty directory') await mkdir(`${f.sourcePath}.empty`);
    if (mutation === 'missing') await rm(f.sourcePath);
    if (mutation === 'bytes') await writeFile(f.sourcePath, 'drift');
    if (mutation === 'mode') await chmod(f.sourcePath, 0o755);
    if (mutation === 'symlink' || mutation === 'fifo') {
      await rm(f.sourcePath);
      if (mutation === 'symlink') await symlink(path.join(f.outputRoot, f.destination), f.sourcePath);
      else execFileSync('mkfifo', [f.sourcePath]);
    }
    if (mutation === 'directory symlink') {
      await rm(path.dirname(f.sourcePath), { recursive: true });
      await symlink(f.replacementRoot, path.dirname(f.sourcePath));
    }
    if (mutation === 'native collision') {
      await fs.rename(f.sourcePath, path.join(path.dirname(f.sourcePath), 'OWNED.bin'));
    }
    for (const mode of /** @type {const} */ (['check', 'sync'])) {
      await assert.rejects(syncUpstream({ ...f.options, mode }));
      assert.deepEqual(await snapshot(path.join(f.outputRoot, 'skills')), generated);
      assert.ok(!(await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync')));
    }
  });
}

test('additions preserve raw bytes and explicit executable modes through relock and clean offline copies', async (t) => {
  const f = await addedFixture(t);
  await chmod(f.sourcePath, 0o755);
  f.manifest.additions[0].mode = '100755';
  const imported = await importUpstream({ source: f.source, commit: f.lock.commit, manifest: f.manifest, projectRoot: f.outputRoot, replacementRoot: f.replacementRoot });
  const options = { ...f.options, lock: imported, source: { kind: /** @type {const} */ ('snapshot'), snapshotRoot: path.join(f.outputRoot, 'vendor/cursor-pstack') } };
  await syncUpstream({ ...options, mode: 'sync' });
  assert.deepEqual(await readFile(path.join(f.outputRoot, f.destination)), f.bytes);
  assert.equal((await lstat(path.join(f.outputRoot, f.destination))).mode & 0o777, 0o755);
  await writeFile(f.sourcePath, Buffer.from([0, 255, 10]));
  await assert.rejects(syncUpstream({ ...options, mode: 'check' }), /addition drift/);
  const lock = await relockUpstream({ projectRoot: f.outputRoot, manifest: f.manifest, replacementRoot: f.replacementRoot });
  assert.deepEqual(lock.files, imported.files);
  await syncUpstream({ ...options, lock, mode: 'sync' });
  const copy = path.join(f.root, 'clean');
  await cp(f.outputRoot, copy, { recursive: true });
  assert.equal((await syncUpstream({ ...options, outputRoot: copy, lock, source: { kind: 'snapshot', snapshotRoot: path.join(copy, 'vendor/cursor-pstack') }, mode: 'check' })).clean, true);
  assert.equal(serializeLock(lock), serializeLock({ ...lock, files: [...lock.files].reverse(), additions: [...lock.additions].reverse() }));
  for (const changed of [{ ...lock, additions: [] }, { ...lock, additions: [{ ...lock.additions[0], output: { ...lock.additions[0].output, mode: /** @type {const} */ ('100644') } }] }]) {
    await assert.rejects(syncUpstream({ ...options, lock: changed, mode: 'check' }), /addition drift/);
  }
});

for (const failure of ['staged bytes', 'late promotion']) {
  test(`addition ${failure} failure rolls back upstream and authored output together`, async (t) => {
    const f = await addedFixture(t);
    await syncUpstream({ ...f.options, mode: 'sync' });
    await writeFile(path.join(f.outputRoot, f.destination), 'old addition');
    await writeFile(path.join(f.outputRoot, 'agents/shared/policy.md'), 'old upstream');
    const before = await snapshot(f.outputRoot);
    const originalWrite = fs.writeFile;
    const originalRename = fs.rename;
    const mock = failure === 'staged bytes'
      ? t.mock.method(fs, 'writeFile', /** @type {typeof fs.writeFile} */ (async (name, data, options) => originalWrite(name, String(name).includes('/content/skills/shared/owned.bin') ? 'bad stage' : data, options)))
      : t.mock.method(fs, 'rename', /** @type {typeof fs.rename} */ (async (source, destination) => {
        if (String(source).includes('/content/agents/shared')) throw new Error('late promotion failure');
        return originalRename(source, destination);
      }));
    syncBuiltinESMExports();
    try { await assert.rejects(syncUpstream({ ...f.options, mode: 'sync' }), /Staging validation|late promotion/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(await snapshot(f.outputRoot), before);
  });
}
