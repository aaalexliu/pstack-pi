import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkContent } from '../../scripts/check-content.mjs';
import { parseLock, parseManifest } from '../../scripts/sync-upstream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('production contains exactly the reviewed copied and adapted workflow set', async () => {
  const manifest = parseManifest(JSON.parse(await readFile(path.join(root, 'sync/manifest.json'), 'utf8')));
  const lock = parseLock(JSON.parse(await readFile(path.join(root, 'sync/upstream.lock.json'), 'utf8')));
  const inventory = await checkContent({ root, manifest, lock });
  assert.equal(lock.commit, 'f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d');
  assert.equal(inventory.bySource.size, 158);
  assert.equal(inventory.byDestination.size, 102);
  assert.equal(inventory.byAgentName.size, 3);
  assert.deepEqual(inventory.byAgentName.get('comment-sicko')?.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(inventory.byAgentName.get('general-purpose')?.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(inventory.byAgentName.get('poteto-agent')?.tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
  assert.equal(inventory.bySkillName.size, 47);
  const upstreamEntrypoints = manifest.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.source));
  assert.equal(upstreamEntrypoints.length, 47);
  assert.ok(upstreamEntrypoints.every((file) => file.kind !== 'omit' && file.destination === file.source));
  assert.equal(manifest.files.filter((file) => file.kind === 'copy').length, 51);
  assert.equal(manifest.files.filter((file) => file.kind === 'transform').length, 50);
  assert.equal(manifest.files.filter((file) => file.kind === 'replace').length, 0);
  assert.equal(manifest.files.filter((file) => file.kind === 'omit').length, 57);
  assert.ok(manifest.files.every((file) => file.kind !== 'omit' || !file.reason.includes('reviewed Pi adaptation phase')));
  const adaptationText = await readFile(path.join(root, 'ADAPTATIONS.md'), 'utf8');
  const documentedTransforms = [...adaptationText.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]).sort();
  const transforms = manifest.files.filter((file) => file.kind === 'transform');
  assert.deepEqual(documentedTransforms, transforms.map((file) => file.source).sort());
  const existingTransforms = transforms.filter(({ source }) => [
    'skills/technical-writing/SKILL.md',
    'skills/typescript-best-practices/SKILL.md',
    'skills/why/references/synthesizer-prompt.md',
  ].includes(source));
  assert.deepEqual(existingTransforms.map(({ source, expectedBlob, transforms }) => ({ source, expectedBlob, transforms })), [
    { source: 'skills/technical-writing/SKILL.md', expectedBlob: '70a477e42fc5f37c35bf602d86ff89c0f5258ecf', transforms: [{ find: '/technical-writing', replace: '/skill:technical-writing', count: 1 }] },
    { source: 'skills/typescript-best-practices/SKILL.md', expectedBlob: '2c0279d9a5f800192605e47b55cae4e75a17ec27', transforms: [{ find: 'paths: ["**/*.ts", "**/*.tsx"]\n', replace: '', count: 1 }] },
    { source: 'skills/why/references/synthesizer-prompt.md', expectedBlob: '9707dfcc2fc57ea126484a433c5cd9ee4d400ef3', transforms: [
      { find: '[PR #123](url)', replace: 'PR #123 at {URL}', count: 1 },
      { find: '`references/epistemics.md`', replace: '`epistemics.md`', count: 1 },
    ] },
  ]);
  for (const [destination, { disposition, locked }] of inventory.byDestination) {
    if (disposition.kind === 'addition') {
      assert.deepEqual(await readFile(path.join(root, destination)), await readFile(path.join(root, disposition.source)));
      continue;
    }
    assert.ok('blob' in locked);
    const original = await readFile(path.join(root, 'vendor/cursor-pstack', disposition.source));
    const actual = await readFile(path.join(root, destination));
    assert.equal(createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex'), locked.blob, `Source blob: ${destination}`);
    if (disposition.kind === 'copy') assert.deepEqual(actual, original, `Copy bytes: ${destination}`);
    else if (disposition.kind === 'replace') {
      assert.deepEqual(actual, await readFile(path.join(root, disposition.replacement)), `Replacement bytes: ${destination}`);
    } else {
      assert.equal(disposition.kind, 'transform');
      let expected = original.toString('utf8');
      for (const step of disposition.transforms) {
        assert.equal(expected.split(step.find).length - 1, step.count);
        expected = expected.replaceAll(step.find, step.replace);
      }
      assert.deepEqual(actual, Buffer.from(expected), `Transform bytes: ${destination}`);
    }
    if (destination.endsWith('/SKILL.md')) {
      assert.match(actual.toString('utf8'), /^disable-model-invocation: true$/mu);
    }
  }
  assert.ok([...inventory.bySkillName.values()].every((skill) => skill.disabled));
});
