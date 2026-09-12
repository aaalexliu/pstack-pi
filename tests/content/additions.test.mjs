import assert from 'node:assert/strict';
import { chmod, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { checkContent, assertPackInventory, contentInventory, expectedPackFiles } from '../../scripts/check-content.mjs';
import { sha256 } from '../../scripts/sync-upstream.mjs';
import { contentFixture, skillText } from './fixture.mjs';

/** @param {import('node:test').TestContext} t */
async function added(t) {
  const f = await contentFixture(t);
  const source = 'sync/additions/skills/owned/SKILL.md';
  const destination = 'skills/owned/SKILL.md';
  const bytes = skillText('owned');
  f.manifest.additions.push({ source, destination, mode: '100644', reason: 'Pi-owned skill fixture.' });
  f.lock.additions.push({ source, output: { destination, mode: '100644', sha256: sha256(bytes) } });
  await f.put(source, bytes);
  await f.put(destination, bytes);
  f.pkg.files.push(destination);
  f.pkg.pi.skills.push(destination);
  f.pkg.pi.skills.sort();
  await f.put('package.json', JSON.stringify(f.pkg));
  return { ...f, source, destination };
}

test('content and pack inventory combine locked upstream and authored outputs', async (t) => {
  const f = await added(t);
  const inventory = await checkContent(f);
  assert.equal(inventory.bySource.size, 4);
  assert.equal(inventory.byDestination.size, 4);
  assert.equal(inventory.bySkillName.size, 3);
  assertPackInventory(f.pkg.files, inventory);
  assert.ok(!expectedPackFiles(inventory).some((name) => name.startsWith('sync/')));
  assert.throws(() => contentInventory(f.manifest, { ...f.lock, additions: [] }), /membership/);
  assert.throws(() => assertPackInventory(f.pkg.files.filter((name) => name !== f.destination), inventory), /membership/);
});

for (const mutation of ['extra input', 'missing input', 'changed input', 'mode', 'symlink', 'output']) {
  test(`content rejects authored ${mutation}`, async (t) => {
    const f = await added(t);
    if (mutation === 'extra input') await f.put('sync/additions/extra', 'extra');
    if (mutation === 'missing input') await rm(path.join(f.root, f.source));
    if (mutation === 'changed input') await f.put(f.source, 'changed');
    if (mutation === 'mode') await chmod(path.join(f.root, f.source), 0o755);
    if (mutation === 'symlink') {
      await rm(path.join(f.root, f.source));
      await symlink(path.join(f.root, f.destination), path.join(f.root, f.source));
    }
    if (mutation === 'output') await f.put(f.destination, 'changed');
    await assert.rejects(checkContent(f));
  });
}
