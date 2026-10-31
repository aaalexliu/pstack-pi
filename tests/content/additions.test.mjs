import assert from 'node:assert/strict';
import { chmod, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertPackInventory, checkContent, checkPackedContent, expectedPackFiles } from '../../scripts/check-content.mjs';
import { contentFixture, skillText } from './fixture.mjs';

/** @param {import('node:test').TestContext} t */
async function added(t) {
  const f = await contentFixture(t);
  const skill = 'additions/skills/owned/SKILL.md';
  const notes = 'additions/skills/owned/references/notes.md';
  await f.put(skill, skillText('owned', 'OWNED_MARKER\nSee [notes](references/notes.md).'));
  await f.put(notes, 'Owned notes.\n');
  f.pkg.files.push(skill, notes);
  f.pkg.files.sort();
  f.pkg.pi.skills.push(skill);
  f.pkg.pi.skills.sort();
  await f.put('package.json', JSON.stringify(f.pkg));
  return { ...f, skill, notes };
}

test('Pi-owned files ship from additions/ without manifest or lock entries', async (t) => {
  const f = await added(t);
  const inventory = await checkContent(f);
  assert.equal(inventory.bySource.size, 4);
  assert.equal(inventory.byDestination.get(f.skill)?.disposition.kind, 'addition');
  assert.equal(inventory.byDestination.get(f.notes)?.disposition.kind, 'addition');
  assert.equal(inventory.bySkillName.get('owned')?.destination, f.skill);
  assert.ok(expectedPackFiles(inventory).includes(f.notes));
  await checkPackedContent(f.root, inventory);
  assert.throws(() => assertPackInventory(f.pkg.files.filter((name) => name !== f.notes), inventory), /membership/);
});

test('an unlisted addition fails the package exposure check', async (t) => {
  const f = await added(t);
  await f.put('package.json', JSON.stringify({ ...f.pkg, files: f.pkg.files.filter((name) => name !== f.notes) }));
  await assert.rejects(checkContent(f), /membership/);
});

for (const [mutation, error] of /** @type {const} */ ([
  ['loose file', /Unsupported addition path: additions\/notes\.md/],
  ['script', /Unsupported addition path: additions\/skills\/owned\/scripts\/run/],
  ['mode', /Unexpected file mode: additions\/skills\/owned\/SKILL\.md/],
  ['symlink', /Symlink: additions\/skills\/owned\/references\/notes\.md/],
  ['upstream skill name', /Duplicate skill name: copied/],
  ['support file without a skill', /Support file has no skill: additions\/skills\/orphan\/references\/notes\.md/],
  ['agent file name', /Agent name differs from destination/],
])) {
  test(`content rejects an addition with a ${mutation}`, async (t) => {
    const f = await added(t);
    if (mutation === 'loose file') await f.put('additions/notes.md', 'Loose.\n');
    if (mutation === 'script') await f.put('additions/skills/owned/scripts/run', '#!/bin/sh\n');
    if (mutation === 'mode') await chmod(path.join(f.root, f.skill), 0o755);
    if (mutation === 'symlink') {
      await rm(path.join(f.root, f.notes));
      await symlink(path.join(f.root, 'README.md'), path.join(f.root, f.notes));
    }
    if (mutation === 'upstream skill name') await f.put('additions/skills/shadow/SKILL.md', skillText('copied', 'SHADOW'));
    if (mutation === 'support file without a skill') await f.put('additions/skills/orphan/references/notes.md', 'Orphan.\n');
    if (mutation === 'agent file name') await f.put('additions/agents/wrong.md', '---\nname: right\ndescription: Fixture agent.\n---\nPrompt.\n');
    await assert.rejects(checkContent(f), error);
  });
}
