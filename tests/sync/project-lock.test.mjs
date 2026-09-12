import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs, { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { importUpstream, relockUpstream, syncUpstream } from '../../scripts/sync-upstream.mjs';
import { fixture, snapshot } from './fixture.mjs';

const script = fileURLToPath(new URL('../../scripts/sync-upstream.mjs', import.meta.url));
const worker = fileURLToPath(new URL('./lock-worker.mjs', import.meta.url));
const lockName = '.pstack-sync.lock';

/** @param {import('node:test').TestContext} t */
async function setup(t) {
  const f = await fixture(t);
  const importOptions = { source: f.source, commit: f.lock.commit, projectRoot: f.outputRoot, manifest: f.manifest, replacementRoot: f.replacementRoot };
  await importUpstream(importOptions);
  const manifestPath = path.join(f.root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  const args = {
    import: ['import', f.repositoryPath, f.lock.commit, f.outputRoot, manifestPath, f.replacementRoot],
    relock: ['relock', f.outputRoot, manifestPath, f.replacementRoot],
    sync: ['sync', 'snapshot', path.join(f.outputRoot, 'vendor/cursor-pstack'), f.outputRoot, manifestPath, path.join(f.outputRoot, 'sync/upstream.lock.json'), f.replacementRoot],
    check: ['check', 'snapshot', path.join(f.outputRoot, 'vendor/cursor-pstack'), f.outputRoot, manifestPath, path.join(f.outputRoot, 'sync/upstream.lock.json'), f.replacementRoot],
  };
  return { ...f, importOptions, manifestPath, args };
}

/** @param {string[]} args */
function cli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
}

/** @param {import('node:test').TestContext} t @param {string[]} args @param {string} kind @param {string} suffix */
async function pausedChild(t, args, kind, suffix) {
  const child = fork(worker, [JSON.stringify(args), kind, suffix], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const message = await Promise.race([
    once(child, 'message'),
    exited.then(() => { throw new Error(`Worker exited before pause: ${stderr}`); }),
  ]);
  assert.equal(message[0], 'paused');
  return { child, exited, stderr: () => stderr };
}

for (const first of ['import', 'relock']) {
  test(`${first} excludes the other operations until final cleanup`, { timeout: 20000 }, async (t) => {
    const f = await setup(t);
    await writeFile(path.join(f.repositoryPath, 'plugin/omit.md'), 'new source generation');
    f.advance('next generation');
    f.args.import[2] = f.lock.commit;
    const held = await pausedChild(t, first === 'import' ? f.args.import : f.args.relock,
      first === 'import' ? 'rename' : 'read', first === 'import' ? '/content/sync/upstream.lock.json' : '/sync/upstream.lock.json');
    const before = await snapshot(f.outputRoot);
    for (const args of Object.values(f.args)) {
      const result = cli(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Project is locked/u);
    }
    assert.deepEqual(await snapshot(f.outputRoot), before);
    held.child.send('resume');
    assert.deepEqual(await held.exited, [0, null], held.stderr());
    await assert.rejects(lstat(path.join(f.outputRoot, lockName)), { code: 'ENOENT' });
    const second = cli(first === 'import' ? f.args.relock : f.args.import);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(await readFile(path.join(f.outputRoot, 'sync/upstream.lock.json'), 'utf8')).commit, f.lock.commit);
    assert.equal(cli(f.args.sync).status, 0);
    assert.equal(cli(f.args.check).status, 0);
  });
}

for (const mode of /** @type {const} */ (['import', 'relock', 'sync', 'check'])) {
  test(`${mode} CLI locks before reading the manifest`, { timeout: 20000 }, async (t) => {
    const f = await setup(t);
    assert.equal(cli(f.args.sync).status, 0);
    const held = await pausedChild(t, f.args[mode], 'read', '/manifest.json');
    assert.equal((await lstat(path.join(f.outputRoot, lockName))).isFile(), true);
    assert.match(cli(f.args.import).stderr, /Project is locked/u);
    held.child.send('resume');
    assert.deepEqual(await held.exited, [0, null], held.stderr());
  });
}

test('the lock covers final cleanup and aliases of the same project root', { timeout: 20000 }, async (t) => {
  const f = await setup(t);
  const held = await pausedChild(t, f.args.import, 'cleanup', '');
  const alias = path.join(f.root, 'alias');
  await symlink(f.root, alias);
  const args = [...f.args.relock];
  args[1] = path.join(alias, 'out', '.');
  assert.match(cli(args).stderr, /Project is locked/u);
  const otherRoot = path.join(f.root, 'independent');
  await mkdir(otherRoot);
  await importUpstream({ ...f.importOptions, projectRoot: otherRoot });
  held.child.send('resume');
  assert.deepEqual(await held.exited, [0, null], held.stderr());
  assert.equal(cli(args).status, 0);
  await assert.rejects(lstat(path.join(f.outputRoot, lockName)), { code: 'ENOENT' });
});

test('a symlinked project root cannot redirect lock creation', async (t) => {
  const f = await setup(t);
  const alias = path.join(f.root, 'alias');
  await symlink(f.outputRoot, alias);
  await assert.rejects(importUpstream({ ...f.importOptions, projectRoot: alias }), /Project root must be a real directory/u);
  await assert.rejects(lstat(path.join(f.outputRoot, lockName)), { code: 'ENOENT' });
});

for (const failure of ['rollback', 'cleanup']) {
  test(`${failure} failure preserves the project lock for manual recovery`, async (t) => {
    const f = await setup(t);
    const originalRename = fs.rename;
    const originalRm = fs.rm;
    /** @type {typeof fs.rename} */
    const failRollback = async (source, destination) => {
      if (String(source).includes('/content/sync/') || String(source).includes('/previous/')) throw new Error('fixture rename failure');
      return originalRename(source, destination);
    };
    /** @type {typeof fs.rm} */
    const failCleanup = async (filename, options) => {
      if (path.basename(String(filename)).startsWith('.pstack-sync-')) throw new Error('fixture cleanup failure');
      return originalRm(filename, options);
    };
    const mocked = failure === 'rollback' ? t.mock.method(fs, 'rename', failRollback) : t.mock.method(fs, 'rm', failCleanup);
    syncBuiltinESMExports();
    try {
      await assert.rejects(importUpstream(f.importOptions), /failed.*manually remove/su);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await lstat(path.join(f.outputRoot, lockName))).isFile(), true);
    assert.ok((await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
    assert.match(cli(f.args.relock).stderr, /Project is locked/u);
  });
}

test('a hard kill during import leaves a stale lock and a manual recovery path', { timeout: 20000 }, async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.repositoryPath, 'plugin/omit.md'), 'interrupted generation');
  f.advance('interrupted import');
  f.args.import[2] = f.lock.commit;
  const held = await pausedChild(t, f.args.import, 'rename', '/content/sync/upstream.lock.json');
  held.child.kill('SIGKILL');
  assert.deepEqual(await held.exited, [null, 'SIGKILL']);
  const before = await snapshot(f.outputRoot);
  assert.ok((await readdir(f.outputRoot)).some((name) => name.startsWith('.pstack-sync-')));
  for (const args of Object.values(f.args)) {
    const result = cli(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Project is locked/u);
    assert.match(result.stderr, /verify.*no sync process.*running/iu);
    assert.match(result.stderr, /restore.*snapshot.*lock/iu);
    assert.match(result.stderr, /manually remove/iu);
    assert.ok(result.stderr.includes(path.join(f.outputRoot, lockName)));
  }
  assert.deepEqual(await snapshot(f.outputRoot), before);
  await writeFile(path.join(f.outputRoot, 'vendor/cursor-pstack/omit.md'), 'not for Pi\n');
  const stage = (await readdir(f.outputRoot)).find((name) => name.startsWith('.pstack-sync-'));
  assert.ok(stage);
  await writeFile(path.join(f.outputRoot, 'sync/upstream.lock.json'), await readFile(path.join(f.outputRoot, stage, 'previous/sync/upstream.lock.json')));
  await rm(path.join(f.outputRoot, stage), { recursive: true });
  await rm(path.join(f.outputRoot, lockName));
  assert.equal(cli(f.args.relock).status, 0);
});

for (const artifact of ['unknown owner', 'empty file', 'directory', 'symlink', 'dangling symlink']) {
  test(`all public APIs reject a project lock with ${artifact} without changing it`, async (t) => {
    const f = await setup(t);
    const lockPath = path.join(f.outputRoot, lockName);
    const outside = path.join(f.root, 'outside');
    await writeFile(outside, 'untouched');
    if (artifact === 'directory') await mkdir(lockPath);
    else if (artifact === 'symlink' || artifact === 'dangling symlink') await symlink(artifact === 'symlink' ? outside : `${outside}-missing`, lockPath);
    else await writeFile(lockPath, artifact === 'empty file' ? '' : '{"pid":99999999}');
    const before = await lstat(lockPath);
    const operations = [
      () => importUpstream(f.importOptions),
      () => relockUpstream({ projectRoot: f.outputRoot, manifest: f.manifest, replacementRoot: f.replacementRoot }),
      ...(['sync', 'check']).map((mode) => () => syncUpstream({ ...f.options, mode: /** @type {'sync' | 'check'} */ (mode) })),
    ];
    for (const operation of operations) await assert.rejects(operation(), /Project is locked.*manually remove/su);
    assert.equal((await lstat(lockPath)).ino, before.ino);
    assert.equal(await readFile(outside, 'utf8'), 'untouched');
    if (before.isFile()) assert.equal(await readFile(lockPath, 'utf8'), artifact === 'empty file' ? '' : '{"pid":99999999}');
  });
}
