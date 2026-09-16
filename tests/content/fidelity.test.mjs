import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseManifest } from '../../scripts/sync-upstream.mjs';

/** @param {string} path */
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const manifest = parseManifest(JSON.parse(await read('sync/manifest.json')));
/** @type {Record<string, {upstream: Record<string, string>, pi: Record<string, string>}>} */
const contracts = JSON.parse(await read('tests/content/workflow-contracts.json'));
const earlierTransforms = [
  'skills/architect/references/runner-prompt.md',
  'skills/create-verification-skill/references/feature-map-example/search.md',
  'skills/interrogate/SKILL.md',
  'skills/technical-writing/SKILL.md',
  'skills/typescript-best-practices/SKILL.md',
  'skills/why/references/synthesizer-prompt.md',
];

// These checks protect reviewed instructions, not model compliance.
test('production uses no full-file replacements and covers every converted workflow', () => {
  assert.ok(manifest.files.every(({ kind }) => kind !== 'replace'), 'Do not replace upstream skills with rewritten copies');
  const converted = manifest.files.filter((file) =>
    (file.kind === 'transform' && !earlierTransforms.includes(file.source)) ||
    file.source === 'skills/poteto-mode/playbooks/investigation.md');
  assert.equal(converted.length, 40);
  assert.deepEqual(Object.keys(contracts).sort(), converted.map(({ source }) => source).sort());
});

for (const [destination, groups] of Object.entries(contracts)) {
  test(`${destination}: preserved upstream contracts and Pi boundaries`, async (t) => {
    const upstream = await read(`vendor/cursor-pstack/${destination}`);
    const output = await read(destination);
    assert.deepEqual(Object.keys(groups).sort(), ['pi', 'upstream']);
    assert.ok(Object.keys(groups.upstream).length > 0, 'Every converted file must keep upstream behavior verbatim');
    for (const [group, clauses] of Object.entries(groups)) {
      for (const [behavior, quote] of Object.entries(clauses)) {
        await t.test(`${group}: ${behavior}`, () => {
          assert.ok(typeof quote === 'string' && quote.trim());
          if (group === 'upstream') assert.ok(upstream.includes(quote), 'Protected prose must come from the pinned source, not the old rewrite');
          assert.ok(output.includes(quote), `${destination}: ${behavior}`);
          const removed = output.replaceAll(quote, '');
          assert.notEqual(removed, output);
          assert.ok(!removed.includes(quote), 'Clause removal must fail the same preservation check');
        });
      }
    }
  });
}

test('command edits do not rewrite scratch paths or principle names', async () => {
  const arena = await read('skills/arena/SKILL.md');
  assert.ok(arena.includes('Use for /skill:arena,'));
  assert.ok(arena.includes('/tmp/arena-<slug>/candidate-<n>/'));
  assert.ok(!arena.includes('/tmp/skill:'));
  for (const name of ['architect', 'arena']) {
    const source = await read(`vendor/cursor-pstack/skills/${name}/SKILL.md`);
    const output = await read(`skills/${name}/SKILL.md`);
    const principles = [...source.matchAll(/\*\*([a-z-]+)\*\*(?=[^.\n]*principle skill)/gu)];
    assert.ok(principles.length > 0);
    for (const [label] of principles) assert.ok(output.includes(label), `Keep the upstream principle reference ${label}`);
  }
});

/** @param {string} text @param {string} from @param {string} [to] */
function section(text, from, to) {
  const start = text.indexOf(from);
  const end = to === undefined ? text.length : text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `section ${from}`);
  return text.slice(start, end);
}

test('interrogate preserves upstream bytes outside Step 3 and claim verification', async () => {
  const destination = 'skills/interrogate/SKILL.md';
  const upstream = await read(`vendor/cursor-pstack/${destination}`);
  const actual = await read(destination);
  const entry = manifest.files.find((file) => file.kind !== 'omit' && file.destination === destination);
  assert.ok(entry?.kind === 'transform');
  assert.equal(entry.transforms.length, 2);
  const step3 = '## Step 3, Spawn Reviewers';
  const step4 = '## Step 4, Synthesize';
  const step5 = '## Step 5, Lead Judgment';
  const output = '## Output Format';
  const [panel, verification] = entry.transforms;
  assert.equal(panel.find, section(upstream, step3, step4));
  assert.ok(panel.replace.startsWith(`${step3}\n\n`));
  assert.equal(verification.find, '1. **Parse all findings** from the reviewers');
  assert.equal(verification.replace, '1. **Parse all findings** from the reviewers. Verify each claim against the code and reachable call paths; include exact files and lines. State any test or evidence gaps. Model agreement is a signal, not proof.');
  let expected = upstream;
  for (const transform of entry.transforms) {
    assert.equal(transform.count, 1);
    assert.equal(expected.split(transform.find).length - 1, 1);
    expected = expected.replace(transform.find, transform.replace);
  }
  assert.equal(actual, expected, 'only the two reviewed transform regions change');
  for (const [from, to] of [
    ['---\n', '## Step 1, Determine Scope'],
    ['## Step 1, Determine Scope', '## Step 2, State the Intent'],
    ['## Step 2, State the Intent', step3],
    [step5, output],
    [output, undefined],
  ]) {
    assert.ok(from);
    assert.equal(section(actual, from, to), section(upstream, from, to), from);
  }
  assert.equal(section(actual, step4, step5).replace(verification.replace, verification.find), section(upstream, step4, step5));
  assert.deepEqual([...section(actual, step5, output).matchAll(/^- \*\*([^*]+)\*\*/gmu)].map((match) => match[1]), ['Act on', 'Consider', 'Noted', 'Dismissed']);
  assert.deepEqual([...section(actual, output).matchAll(/^### (.+)$/gmu)].map((match) => match[1]), ['Intent', 'Reviewers', 'Act On', 'Consider', 'Noted', 'Dismissed', 'Agreement Map']);
  for (const clause of [
    "Use the `interrogate-reviewer` role's configured model pool, one reviewer per entry.",
    'the exact configured entry, including `inherit-parent`',
    'do not substitute assigned personas or different prompts',
    'do not silently substitute a model or edit configuration',
    'label inherited or unresolved identities as unknown, not a guessed model name',
  ]) assert.ok(actual.includes(clause), clause);
});

test('small reference repairs leave every other upstream byte intact', async () => {
  for (const [destination, before, after] of [
    ['skills/architect/references/runner-prompt.md',
      'You are one of several runners, each on a different model.',
      'You are one of several independent runners. The parent selects configured models and reports any limits on model diversity.'],
    ['skills/create-verification-skill/references/feature-map-example/search.md',
      '- **Proof.** Capture the populated result state.',
      '- **Proof.** Restore the populated result state after the clear-query and CLI checks. Run `control-notes browser fill --role searchbox --name "Search notes" --value "quarterly"` and wait for the `Search results` list to contain `Quarterly plan`. Capture this state.'],
  ]) {
    const source = await read(`vendor/cursor-pstack/${destination}`);
    assert.equal(source.split(before).length - 1, 1);
    assert.equal(await read(destination), source.replace(before, after), destination);
    const entry = manifest.files.find((file) => file.kind !== 'omit' && file.destination === destination);
    assert.ok(entry?.kind === 'transform');
    assert.deepEqual(entry.transforms, [{ find: before, replace: after, count: 1 }]);
  }
});
