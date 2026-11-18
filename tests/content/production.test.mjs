import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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
  assert.equal(inventory.byDestination.size, 135);
  assert.equal(inventory.byAgentName.size, 5);
  assert.deepEqual(inventory.byAgentName.get('comment-sicko')?.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(inventory.byAgentName.get('general-purpose')?.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(inventory.byAgentName.get('pr-reviewer')?.tools, ['read', 'grep', 'find', 'ls', 'bash']);
  assert.deepEqual(inventory.byAgentName.get('sub-lead')?.tools, ['read', 'bash', 'edit', 'write']);
  assert.deepEqual(inventory.byAgentName.get('poteto-agent')?.tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
  assert.equal(inventory.bySkillName.size, 59);
  assert.deepEqual([...inventory.byDestination].filter(([, record]) => record.disposition.kind === 'addition').map(([destination]) => destination).sort(), [
    'additions/agents/general-purpose.md',
    'additions/agents/pr-reviewer.md',
    'additions/agents/sub-lead.md',
    'additions/skills/deeper/SKILL.md',
    'additions/skills/intake/SKILL.md',
    'additions/skills/list-writing/SKILL.md',
    'additions/skills/principles/SKILL.md',
    'additions/skills/show-me/SKILL.md',
    'additions/skills/show-me/references/humanlayer-license.md',
  ]);
  for (const name of ['deeper', 'intake', 'list-writing', 'principles', 'show-me']) assert.equal(inventory.bySkillName.get(name)?.destination, `additions/skills/${name}/SKILL.md`);
  const upstreamEntrypoints = manifest.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.source));
  assert.equal(upstreamEntrypoints.length, 58);
  const omittedSkills = ['skills/ketchup-video/SKILL.md', 'skills/poteto-help/SKILL.md', 'skills/recall/SKILL.md', 'skills/sharpen/SKILL.md'];
  assert.deepEqual(upstreamEntrypoints.filter((file) => file.kind === 'omit').map((file) => file.source), omittedSkills);
  assert.ok(upstreamEntrypoints.every((file) => file.kind === 'omit' || file.destination === file.source));
  assert.equal(manifest.files.filter((file) => file.kind === 'copy').length, 73);
  assert.equal(manifest.files.filter((file) => file.kind === 'transform').length, 53);
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
  ].includes(source));
  assert.deepEqual(existingTransforms.map(({ source, expectedBlob, transforms }) => ({ source, expectedBlob, transforms })), [
    { source: 'skills/technical-writing/SKILL.md', expectedBlob: '6f53776d935064370738bebe79f9fc8f39987ade', transforms: [
      { find: '/technical-writing', replace: '/skill:technical-writing', count: 1 },
      { find: 'Do not paste swarm logs, SHA lists, or metric tables. Link them.', replace: 'Paste short real proof, under about 10 lines. Link swarm logs, SHA lists, metric tables, and other long output.', count: 1 },
    ] },
    { source: 'skills/typescript-best-practices/SKILL.md', expectedBlob: 'e1e5aa7c97ed39c425d60d933a96424a3f14539e', transforms: [{ find: 'paths: ["**/*.ts", "**/*.tsx"]\n', replace: '', count: 1 }] },
  ]);
  for (const [destination, record] of inventory.byDestination) {
    if (!('locked' in record)) continue;
    const { disposition, locked } = record;
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
  assert.deepEqual([...inventory.bySkillName.values()].filter((skill) => !skill.disabled).map((skill) => skill.name).sort(), ['intake', 'list-writing', 'principles', 'show-me']);
});

test('principles index lists every principle skill and only those', async () => {
  const principles = (await readdir(path.join(root, 'skills'))).filter((name) => name.startsWith('principle-')).sort();
  const index = await readFile(path.join(root, 'additions/skills/principles/SKILL.md'), 'utf8');
  const listed = [...index.matchAll(/^- `(principle-[a-z-]+)`: .+ Read `skills\/\1\/SKILL\.md`\.$/gmu)].map((match) => match[1]).sort();
  assert.equal(principles.length, 24);
  assert.deepEqual(listed, principles);
});
