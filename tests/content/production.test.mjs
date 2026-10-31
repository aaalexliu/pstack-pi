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
  assert.equal(lock.commit, 'c742dd61706fbacc1b95f1a20b7b988cf096ce6c');
  assert.equal(inventory.bySource.size, 573);
  assert.equal(inventory.byDestination.size, 130);
  assert.equal(inventory.byAgentName.size, 3);
  assert.deepEqual(inventory.byAgentName.get('comment-sicko')?.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(inventory.byAgentName.get('general-purpose')?.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(inventory.byAgentName.get('poteto-agent')?.tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
  assert.equal(inventory.bySkillName.size, 56);
  assert.equal(manifest.additions.length, 4);
  assert.ok(inventory.bySkillName.has('deeper'));
  assert.equal(inventory.byDestination.get('skills/deeper/SKILL.md')?.disposition.kind, 'addition');
  assert.ok(inventory.bySkillName.has('alex-show-me'));
  assert.equal(inventory.byDestination.get('skills/alex-show-me/SKILL.md')?.disposition.kind, 'addition');
  assert.equal(inventory.byDestination.get('skills/alex-show-me/references/humanlayer-license.md')?.disposition.kind, 'addition');
  const upstreamEntrypoints = manifest.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.source));
  assert.equal(upstreamEntrypoints.length, 58);
  const omittedSkills = ['skills/ketchup-video/SKILL.md', 'skills/ketchup/SKILL.md', 'skills/poteto-help/SKILL.md', 'skills/sharpen/SKILL.md'];
  assert.deepEqual(upstreamEntrypoints.filter((file) => file.kind === 'omit').map((file) => file.source), omittedSkills);
  assert.ok(upstreamEntrypoints.every((file) => file.kind === 'omit' || file.destination === file.source));
  assert.equal(manifest.files.filter((file) => file.kind === 'copy').length, 75);
  assert.equal(manifest.files.filter((file) => file.kind === 'transform').length, 51);
  assert.equal(manifest.files.filter((file) => file.kind === 'replace').length, 0);
  assert.equal(manifest.files.filter((file) => file.kind === 'omit').length, 447);
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
    { source: 'skills/technical-writing/SKILL.md', expectedBlob: '3e6d26109376cd66439c87ed48b4033df8d78a3a', transforms: [{ find: '/technical-writing', replace: '/skill:technical-writing', count: 1 }] },
    { source: 'skills/typescript-best-practices/SKILL.md', expectedBlob: 'e1e5aa7c97ed39c425d60d933a96424a3f14539e', transforms: [{ find: 'paths: ["**/*.ts", "**/*.tsx"]\n', replace: '', count: 1 }] },
    { source: 'skills/why/references/synthesizer-prompt.md', expectedBlob: '287a350c925c28b44f0e0dc687bb09a843e11100', transforms: [
      { find: '[PR #123](url)', replace: 'PR #123 at {URL}', count: 1 },
      { find: '`references/epistemics.md`', replace: '`epistemics.md`', count: 1 },
      { find: 'check it by reading the codebase or calling MCP tools.', replace: 'check it by reading the codebase, or return it to the parent to check with external tools.', count: 1 },
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
