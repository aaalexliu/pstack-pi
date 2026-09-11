import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs, { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { importUpstream, relockUpstream, serializeLock, syncUpstream } from '../../scripts/sync-upstream.mjs';
import { fixture, git, snapshot } from './fixture.mjs';

const script = fileURLToPath(new URL('../../scripts/sync-upstream.mjs', import.meta.url));

/** @param {import('node:test').TestContext} t */
async function snapshotFixture(t) {
  const f = await fixture(t);
  const snapshotRoot = path.join(f.root, 'snapshot');
  await cp(path.join(f.repositoryPath, 'plugin'), snapshotRoot, { recursive: true });
  const options = { ...f.options, source: { kind: /** @type {const} */ ('snapshot'), snapshotRoot } };
  return { ...f, snapshotRoot, snapshotOptions: options };
}

/** @param {Awaited<ReturnType<typeof fixture>>} f */
const importOptions = (f) => ({ source: f.source, commit: f.lock.commit, manifest: f.manifest, projectRoot: f.outputRoot, replacementRoot: f.replacementRoot });

/** @param {Awaited<ReturnType<typeof fixture>>} f */
const relockOptions = (f) => ({ projectRoot: f.outputRoot, manifest: f.manifest, replacementRoot: f.replacementRoot });

/** @param {Awaited<ReturnType<typeof snapshotFixture>>} f @param {RegExp} message */
async function rejectsSnapshot(f, message) {
  const before = await snapshot(f.outputRoot);
  for (const mode of /** @type {const} */ (['check', 'sync'])) {
    await assert.rejects(syncUpstream({ ...f.snapshotOptions, mode }), message);
    assert.deepEqual(await snapshot(f.outputRoot), before);
  }
}

test('Git and independently copied snapshot adapters produce identical outputs and differences', async (t) => {
  const f = await snapshotFixture(t);
  assert.deepEqual(await syncUpstream({ ...f.snapshotOptions, mode: 'check' }), await syncUpstream({ ...f.options, mode: 'check' }));
  await syncUpstream({ ...f.options, mode: 'sync' });
  const expected = await snapshot(f.outputRoot);
  assert.deepEqual(await syncUpstream({ ...f.snapshotOptions, mode: 'check' }), { clean: true, differences: [] });
  await writeFile(path.join(f.outputRoot, 'skills/shared/copy.bin'), 'drift');
  assert.deepEqual(await syncUpstream({ ...f.snapshotOptions, mode: 'check' }), await syncUpstream({ ...f.options, mode: 'check' }));
  await syncUpstream({ ...f.snapshotOptions, mode: 'sync' });
  assert.deepEqual(await snapshot(f.outputRoot), expected);
  assert.equal((await lstat(path.join(f.outputRoot, 'agents/shared/run.sh'))).mode & 0o777, 0o755);
});

test('snapshot mode uses no Git process, even for omitted bytes or relock', async (t) => {
  const f = await snapshotFixture(t);
  await importUpstream(importOptions(f));
  await rename(f.repositoryPath, `${f.repositoryPath}-unavailable`);
  const mocked = t.mock.method(childProcess, 'execFileSync', () => { throw new Error('Git must not run'); });
  syncBuiltinESMExports();
  try {
    await syncUpstream({ ...f.snapshotOptions, mode: 'sync' });
    assert.equal((await syncUpstream({ ...f.snapshotOptions, mode: 'check' })).clean, true);
    await relockUpstream(relockOptions(f));
    await writeFile(path.join(f.snapshotRoot, 'omit.md'), 'changed omitted file');
    await rejectsSnapshot(f, /Source tree drift/u);
    assert.equal(mocked.mock.callCount(), 0);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const name of ['copy.bin', 'omit.md']) {
  test(`snapshot rejects raw byte edits in ${name}`, async (t) => {
    const f = await snapshotFixture(t);
    await writeFile(path.join(f.snapshotRoot, name), Buffer.from([0, 255, 10, 13]));
    await rejectsSnapshot(f, /Source tree drift/u);
  });
}

test('snapshot rejects additions and deletions even when a manifest tries to conceal them', async (t) => {
  const f = await snapshotFixture(t);
  await writeFile(path.join(f.snapshotRoot, 'extra'), 'extra');
  await rejectsSnapshot(f, /Unclassified source/u);
  f.manifest.files.push({ kind: 'omit', source: 'extra', reason: 'Fixture addition.' });
  await rejectsSnapshot(f, /Source tree drift/u);
  await rm(path.join(f.snapshotRoot, 'extra'));
  f.manifest.files.pop();
  await rm(path.join(f.snapshotRoot, 'omit.md'));
  await rejectsSnapshot(f, /Missing classified source/u);
  f.manifest.files = f.manifest.files.filter((file) => file.source !== 'omit.md');
  await rejectsSnapshot(f, /Source tree drift/u);
});

test('snapshot normalizes permissions but rejects executable-bit changes', async (t) => {
  const f = await snapshotFixture(t);
  await chmod(path.join(f.snapshotRoot, 'copy.bin'), 0o600);
  await chmod(path.join(f.snapshotRoot, 'run.sh'), 0o710);
  await syncUpstream({ ...f.snapshotOptions, mode: 'sync' });
  await chmod(path.join(f.snapshotRoot, 'omit.md'), 0o755);
  await rejectsSnapshot(f, /Source tree drift/u);
  await chmod(path.join(f.snapshotRoot, 'omit.md'), 0o644);
  await chmod(path.join(f.snapshotRoot, 'run.sh'), 0o644);
  await rejectsSnapshot(f, /Source tree drift/u);
});

test('snapshot rejects symlinked files, directories, and roots', async (t) => {
  const f = await snapshotFixture(t);
  await rm(path.join(f.snapshotRoot, 'omit.md'));
  await symlink(path.join(f.repositoryPath, 'plugin/omit.md'), path.join(f.snapshotRoot, 'omit.md'));
  await rejectsSnapshot(f, /Symlink path/u);
  await rm(path.join(f.snapshotRoot, 'omit.md'));
  await cp(path.join(f.repositoryPath, 'plugin/omit.md'), path.join(f.snapshotRoot, 'omit.md'));
  await symlink(f.repositoryPath, path.join(f.snapshotRoot, 'escape'));
  await rejectsSnapshot(f, /Symlink path/u);
  await rm(path.join(f.snapshotRoot, 'escape'));
  await rename(f.snapshotRoot, `${f.snapshotRoot}-real`);
  await symlink(`${f.snapshotRoot}-real`, f.snapshotRoot);
  await rejectsSnapshot(f, /Snapshot root must be a real directory/u);
});

test('snapshot rejects special files without reading them', async (t) => {
  const f = await snapshotFixture(t);
  execFileSync('mkfifo', [path.join(f.snapshotRoot, 'fifo')]);
  await rejectsSnapshot(f, /Non-regular snapshot file/u);
});

test('snapshot rejects empty directories and native collisions, including empty siblings', async (t) => {
  const f = await snapshotFixture(t);
  await mkdir(path.join(f.snapshotRoot, 'empty'));
  await rejectsSnapshot(f, /Empty snapshot directory/u);
  await rm(path.join(f.snapshotRoot, 'empty'), { recursive: true });
  const originalRead = fs.readdir;
  /** @param {Parameters<typeof fs.readdir>} args */
  async function collision(...args) {
    if (args[0] === f.snapshotRoot) return [Buffer.from('Dir'), Buffer.from('dir')];
    return Reflect.apply(originalRead, fs, args);
  }
  const mocked = t.mock.method(fs, 'readdir', collision);
  syncBuiltinESMExports();
  try {
    await rejectsSnapshot(f, /native-path collision/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('snapshot checks the locked tree as well as every locked blob and mode', async (t) => {
  const f = await snapshotFixture(t);
  const tree = f.lock.sourceTree;
  f.lock.sourceTree = 'a'.repeat(40);
  await rejectsSnapshot(f, /Source tree drift/u);
  f.lock.sourceTree = tree;
  const omitted = f.lock.files.find((file) => file.source === 'omit.md');
  assert.ok(omitted);
  const blob = omitted.blob;
  omitted.blob = 'a'.repeat(40);
  await rejectsSnapshot(f, /Source blob drift/u);
  omitted.blob = blob;
  omitted.mode = '100755';
  await rejectsSnapshot(f, /Source mode drift/u);
});

test('import generates the independent fixture lock, exact bytes, and modes without activating output', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.outputRoot);
  const imported = await importUpstream(importOptions(f));
  assert.deepEqual(imported, { ...f.lock, files: [...f.lock.files].sort((a, b) => Buffer.compare(Buffer.from(a.source), Buffer.from(b.source))) });
  const bytes = await readFile(path.join(f.outputRoot, 'sync/upstream.lock.json'), 'utf8');
  assert.equal(bytes, serializeLock(f.lock));
  assert.ok(bytes.endsWith('\n') && !bytes.endsWith('\n\n'));
  assert.ok(!bytes.includes(f.root));
  assert.deepEqual(await snapshot(path.join(f.outputRoot, 'vendor/cursor-pstack')), await snapshot(path.join(f.repositoryPath, 'plugin')));
  for (const file of f.lock.files) {
    assert.equal((await lstat(path.join(f.outputRoot, 'vendor/cursor-pstack', file.source))).mode & 0o777, file.mode === '100755' ? 0o755 : 0o644);
  }
  for (const [name, content] of Object.entries(before)) assert.equal((await snapshot(f.outputRoot))[name], content);
  assert.deepEqual(await readdir(path.join(f.outputRoot, 'skills')), ['native']);
  f.manifest.files.reverse();
  await importUpstream(importOptions(f));
  assert.equal(await readFile(path.join(f.outputRoot, 'sync/upstream.lock.json'), 'utf8'), bytes);
});

test('Git tree reconstruction handles nested directories, UTF-8 names, and Git sort order', async (t) => {
  const f = await fixture(t);
  for (const name of ['dir/a', 'dir.c', 'dir0', 'é/file', 'z/deep/binary']) {
    const filename = path.join(f.repositoryPath, 'plugin', name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, Buffer.from([255, 0, 13, 10]));
    f.manifest.files.push({ kind: 'omit', source: name, reason: 'Tree fixture.' });
  }
  f.advance('nested fixture');
  const imported = await importUpstream(importOptions(f));
  assert.equal(imported.sourceTree, git(f.repositoryPath, ['rev-parse', 'HEAD:plugin']));
  for (const file of imported.files) assert.equal(file.blob, git(f.repositoryPath, ['rev-parse', `HEAD:plugin/${file.source}`]));
  await syncUpstream({ ...f.options, lock: imported, source: { kind: 'snapshot', snapshotRoot: path.join(f.outputRoot, 'vendor/cursor-pstack') }, mode: 'sync' });
});

test('import requires full commit identity, reviewed coverage, and regular Git blobs', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.outputRoot);
  await assert.rejects(importUpstream({ ...importOptions(f), commit: f.lock.commit.slice(0, 8) }), /full Git object ID/u);
  await writeFile(path.join(f.repositoryPath, 'plugin/extra'), 'extra');
  f.advance('extra');
  await assert.rejects(importUpstream(importOptions(f)), /Unclassified source/u);
  await symlink('omit.md', path.join(f.repositoryPath, 'plugin/link'));
  f.advance('symlink');
  await assert.rejects(importUpstream(importOptions(f)), /Unsupported file mode/u);
  assert.deepEqual(await snapshot(f.outputRoot), before);
});

for (const existing of [false, true]) {
  test(`import rolls back vendor and lock after a late promotion failure, existing=${existing}`, async (t) => {
    const f = await fixture(t);
    if (existing) await importUpstream(importOptions(f));
    const before = await snapshot(f.outputRoot);
    const originalRename = fs.rename;
    /** @type {typeof fs.rename} */
    const failPromotion = async (source, destination) => {
      if (String(source).includes('/content/sync/upstream.lock.json')) throw new Error('fixture lock promotion failure');
      return originalRename(source, destination);
    };
    const mocked = t.mock.method(fs, 'rename', failPromotion);
    syncBuiltinESMExports();
    try {
      await assert.rejects(importUpstream(importOptions(f)), /fixture lock promotion failure/u);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await snapshot(f.outputRoot), before);
    assert.ok(!(await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
    if (existing) assert.equal((await lstat(path.join(f.outputRoot, 'vendor/cursor-pstack/run.sh'))).mode & 0o777, 0o755);
    else await assert.rejects(lstat(path.join(f.outputRoot, 'vendor/cursor-pstack')), { code: 'ENOENT' });
  });
}

test('import validates staged omitted bytes and lock bytes before promotion', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.outputRoot);
  for (const suffix of ['/vendor/cursor-pstack/omit.md', '/sync/upstream.lock.json']) {
    const originalWrite = fs.writeFile;
    /** @type {typeof fs.writeFile} */
    const corruptStage = async (filename, data, options) => originalWrite(filename,
      String(filename).includes('/content/') && String(filename).endsWith(suffix) ? 'corrupt stage' : data, options);
    const mocked = t.mock.method(fs, 'writeFile', corruptStage);
    syncBuiltinESMExports();
    try {
      await assert.rejects(importUpstream(importOptions(f)), /Source tree drift|Staged lock validation failed/u);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await snapshot(f.outputRoot), before);
  }
});

test('offline relock updates only reviewed adaptations after verifying the existing source lock', async (t) => {
  const f = await fixture(t);
  await importUpstream(importOptions(f));
  const vendor = await snapshot(path.join(f.outputRoot, 'vendor/cursor-pstack'));
  const transform = f.manifest.files.find((file) => file.kind === 'transform');
  assert.ok(transform);
  transform.transforms[1].replace = 'Pi runtime';
  await writeFile(path.join(f.replacementRoot, 'policy.md'), 'new reviewed replacement\n');
  const updated = await relockUpstream(relockOptions(f));
  assert.notDeepEqual(updated, f.lock);
  assert.deepEqual(updated.files.map(({ source, blob, mode }) => ({ source, blob, mode })), [...f.lock.files].sort((a, b) => a.source.localeCompare(b.source)).map(({ source, blob, mode }) => ({ source, blob, mode })));
  assert.equal(updated.commit, f.lock.commit);
  assert.equal(updated.sourceTree, f.lock.sourceTree);
  assert.deepEqual(await snapshot(path.join(f.outputRoot, 'vendor/cursor-pstack')), vendor);
  const options = { ...f.options, source: { kind: /** @type {const} */ ('snapshot'), snapshotRoot: path.join(f.outputRoot, 'vendor/cursor-pstack') }, lock: updated };
  await syncUpstream({ ...options, mode: 'sync' });
  assert.equal(await readFile(path.join(f.outputRoot, 'skills/shared/transform.md'), 'utf8'), '\uFEFFPi runtime\r\n');
  assert.equal(await readFile(path.join(f.outputRoot, 'agents/shared/policy.md'), 'utf8'), 'new reviewed replacement\n');
  assert.equal(serializeLock(await relockUpstream(relockOptions(f))), serializeLock(updated));
});

for (const mutation of ['bytes', 'addition', 'deletion', 'mode', 'tree']) {
  test(`offline relock cannot bless source ${mutation} changes`, async (t) => {
    const f = await fixture(t);
    await importUpstream(importOptions(f));
    const root = path.join(f.outputRoot, 'vendor/cursor-pstack');
    if (mutation === 'bytes') await writeFile(path.join(root, 'omit.md'), 'changed');
    if (mutation === 'addition') await writeFile(path.join(root, 'extra'), 'new');
    if (mutation === 'deletion') await rm(path.join(root, 'omit.md'));
    if (mutation === 'mode') await chmod(path.join(root, 'omit.md'), 0o755);
    if (mutation === 'tree') {
      await writeFile(path.join(f.outputRoot, 'sync/upstream.lock.json'), serializeLock({ ...f.lock, sourceTree: 'a'.repeat(40) }));
    }
    const before = await snapshot(f.outputRoot);
    await assert.rejects(relockUpstream(relockOptions(f)), /Source tree drift/u);
    assert.deepEqual(await snapshot(f.outputRoot), before);
  });
}

test('SHA-256 Git repositories retain exact object identities offline', async (t) => {
  const f = await fixture(t, 'sha256');
  const lock = await importUpstream(importOptions(f));
  assert.equal(lock.commit.length, 64);
  assert.equal(lock.sourceTree, f.lock.sourceTree);
  assert.equal(serializeLock(lock), serializeLock(f.lock));
  await syncUpstream({ ...f.options, source: { kind: 'snapshot', snapshotRoot: path.join(f.outputRoot, 'vendor/cursor-pstack') }, mode: 'sync' });
});

test('import rejects symlinked and wrong-type targets without replacing native files', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'untouched');
  await symlink(outside, path.join(f.outputRoot, 'vendor'));
  await assert.rejects(importUpstream(importOptions(f)), /Symlink path/u);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
  await rm(path.join(f.outputRoot, 'vendor'));
  await mkdir(path.join(f.outputRoot, 'sync/upstream.lock.json'), { recursive: true });
  const before = await snapshot(f.outputRoot);
  await assert.rejects(importUpstream(importOptions(f)), /Promotion target has wrong type/u);
  assert.deepEqual(await snapshot(f.outputRoot), before);
});

test('import abort during staging preserves the previous snapshot and lock', async (t) => {
  const f = await fixture(t);
  await importUpstream(importOptions(f));
  const before = await snapshot(f.outputRoot);
  const controller = new AbortController();
  const originalWrite = fs.writeFile;
  /** @type {typeof fs.writeFile} */
  const abortStage = async (filename, data, options) => {
    await originalWrite(filename, data, options);
    if (String(filename).includes('/content/vendor/')) controller.abort(new Error('fixture import interruption'));
  };
  const mocked = t.mock.method(fs, 'writeFile', abortStage);
  syncBuiltinESMExports();
  try {
    await assert.rejects(importUpstream({ ...importOptions(f), signal: controller.signal }), /fixture import interruption/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await snapshot(f.outputRoot), before);
});

test('offline relock rejects invalid adaptations and rolls back lock promotion failure', async (t) => {
  const f = await fixture(t);
  await importUpstream(importOptions(f));
  const before = await snapshot(f.outputRoot);
  const transform = f.manifest.files.find((file) => file.kind === 'transform');
  assert.ok(transform);
  transform.transforms[0].count = 99;
  await assert.rejects(relockUpstream(relockOptions(f)), /Wrong transform count/u);
  assert.deepEqual(await snapshot(f.outputRoot), before);
  transform.transforms[0].count = 2;
  const originalRename = fs.rename;
  /** @type {typeof fs.rename} */
  const failPromotion = async (source, destination) => {
    if (String(source).includes('/content/sync/')) throw new Error('fixture relock failure');
    return originalRename(source, destination);
  };
  const mocked = t.mock.method(fs, 'rename', failPromotion);
  syncBuiltinESMExports();
  try {
    await assert.rejects(relockUpstream(relockOptions(f)), /fixture relock failure/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await snapshot(f.outputRoot), before);
});

test('import and relock CLI feed the same offline sync contract', async (t) => {
  const f = await fixture(t);
  const manifestPath = path.join(f.root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  const imported = spawnSync(process.execPath, [script, 'import', f.repositoryPath, f.lock.commit, f.outputRoot, manifestPath, f.replacementRoot], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  await rename(f.repositoryPath, `${f.repositoryPath}-unavailable`);
  const env = { ...process.env, PATH: '' };
  const relocked = spawnSync(process.execPath, [script, 'relock', f.outputRoot, manifestPath, f.replacementRoot], { env, encoding: 'utf8' });
  assert.equal(relocked.status, 0, relocked.stderr);
  const args = ['snapshot', path.join(f.outputRoot, 'vendor/cursor-pstack'), f.outputRoot, manifestPath, path.join(f.outputRoot, 'sync/upstream.lock.json'), f.replacementRoot];
  const missing = spawnSync(process.execPath, [script, 'check', ...args], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /missing skills\/shared\/copy.bin/u);
  for (const mode of ['sync', 'check']) {
    const result = spawnSync(process.execPath, [script, mode, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
