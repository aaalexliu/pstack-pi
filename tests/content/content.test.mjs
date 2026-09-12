import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, readFile, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertPackageExposure, assertPackInventory, checkContent, checkPackedContent, contentInventory, expectedPackFiles, parseSkill } from '../../scripts/check-content.mjs';
import { contentFixture, skillText } from './fixture.mjs';

const entrypoint = 'skills/copied/SKILL.md';

test('read-only validator derives indexes from the manifest and lock', async (t) => {
  const f = await contentFixture(t);
  const before = await lstat(path.join(f.root, entrypoint));
  const inventory = await checkContent(f);
  assert.equal(inventory.bySource.size, 4);
  assert.equal(inventory.byDestination.size, 3);
  assert.deepEqual([...inventory.bySkillName.keys()], ['copied', 'transformed']);
  assert.equal(inventory.bySource.get(entrypoint), inventory.byDestination.get(entrypoint));
  assert.equal(inventory.bySkillName.get('copied')?.disabled, true);
  assert.equal((await lstat(path.join(f.root, entrypoint))).mtimeMs, before.mtimeMs);
  await checkPackedContent(f.root, inventory);
});

for (const [name, yaml] of [
  ['duplicate name key', 'name: copied\nname: other\ndescription: text'],
  ['duplicate nested key', 'name: copied\ndescription: text\nmetadata: {a: one, a: two}'],
  ['malformed YAML', 'name: [broken\ndescription: text'],
  ['unknown tag', 'name: copied\ndescription: !custom text'],
  ['alias', 'name: &name copied\ndescription: *name'],
  ['non-map YAML', '[one, two]'],
  ['missing description', 'name: copied'],
  ['blank description', 'name: copied\ndescription: "  "'],
  ['long description', `name: copied\ndescription: ${'x'.repeat(1025)}`],
  ['non-string description', 'name: copied\ndescription: true'],
  ['long name', `name: ${'x'.repeat(65)}\ndescription: text`],
  ...['Bad', '-bad', 'bad-', 'bad--name', 'bad_name', 'true'].map((name) => [`bad name ${name}`, `name: ${name}\ndescription: text`]),
  ['string invocation flag', 'name: copied\ndescription: text\ndisable-model-invocation: "true"'],
  ['null invocation flag', 'name: copied\ndescription: text\ndisable-model-invocation: null'],
  ...['paths', 'alwaysApply', 'model', 'tools', 'user-invocable'].map((key) => [`unsupported ${key}`, `name: copied\ndescription: text\n${key}: true`]),
]) {
  test(`frontmatter rejects ${name}`, () => {
    assert.throws(() => parseSkill(`---\n${yaml}\n---\nBody`, entrypoint));
  });
}

test('frontmatter accepts folded descriptions, CRLF, metadata, and false or absent flags', () => {
  const skill = parseSkill('---\r\nname: copied\r\ndescription: >-\r\n  A folded\r\n  description.\r\ndisable-model-invocation: false\r\nmetadata: {owner: team}\r\n---\r\nBody\r\n', entrypoint);
  assert.equal(skill.description, 'A folded description.');
  assert.equal(skill.disabled, false);
  assert.equal(skill.body, 'Body');
  assert.equal(parseSkill('---\nname: copied\ndescription: text\n---\nBody', entrypoint).disabled, false);
  assert.throws(() => parseSkill('No frontmatter', entrypoint), /frontmatter/);
});

for (const mutation of ['missing', 'extra', 'bytes', 'mode', 'symlink', 'directory symlink', 'fifo', 'invalid UTF-8']) {
  test(`generated output rejects ${mutation}`, async (t) => {
    const f = await contentFixture(t);
    const filename = path.join(f.root, entrypoint);
    if (mutation === 'missing') await rm(filename);
    if (mutation === 'extra') await f.put('skills/copied/extra.md', 'extra');
    if (mutation === 'bytes') await f.put(entrypoint, 'changed');
    if (mutation === 'mode') await chmod(filename, 0o755);
    if (mutation === 'symlink' || mutation === 'fifo') {
      await rm(filename);
      if (mutation === 'symlink') await symlink('../../README.md', filename);
      else execFileSync('mkfifo', [filename]);
    }
    if (mutation === 'directory symlink') {
      await rename(path.join(f.root, 'skills'), path.join(f.root, 'outside'));
      await symlink('outside', path.join(f.root, 'skills'));
    }
    if (mutation === 'invalid UTF-8') await f.rewrite(entrypoint, Buffer.from([255]));
    await assert.rejects(checkContent(f));
  });
}

test('rejects duplicate skill names and descriptions', async (t) => {
  const f = await contentFixture(t);
  await f.rewrite('skills/transformed/SKILL.md', skillText('copied'));
  await assert.rejects(checkContent(f), /Duplicate skill name/);
  await f.rewrite('skills/transformed/SKILL.md', skillText('transformed').replace('Use transformed', 'Use copied'));
  await assert.rejects(checkContent(f), /Duplicate skill description/);
});

for (const body of [
  'Use /skill:omitted.', 'Use /copied.', 'Apply the **omitted** skill.',
  'Apply the **missing** principle skill.',
  'See [notes](references/missing.md).', 'Read `scripts/missing.sh`.',
  'See [notes][ref].\n\n[ref]: references/missing.md',
  'Read [file](../../../outside.md).', 'Read [file](/tmp/file.md).',
  'Read [file](file:///tmp/file.md).', 'Read [file](references/%2e%2e/%2e%2e/missing.md).',
  'Use subagent_type: generalPurpose.', 'Set run_in_background: true.',
  'Spawn a Task subagent.', 'Use the `Task` tool.', 'Set `readonly`: `true`.',
  'Write ~/.cursor/rules/settings.mdc.', 'Use AskQuestion.', 'Run cursor-agent.',
  'Call pstack_todo.', 'Register pi.on("tool_call", handler).',
  'Install a command-approval gate.', 'Read `../omitted/SKILL.md`.',
]) {
  test(`rejects unresolved or unsupported instruction ${body}`, async (t) => {
    const f = await contentFixture(t);
    await f.rewrite(entrypoint, skillText('copied', body));
    await assert.rejects(checkContent(f), /dependency|mechanics|command|link/);
  });
}

test('protocol identifiers and ordinary prose are not Cursor mechanics', async (t) => {
  const f = await contentFixture(t);
  await f.rewrite(entrypoint, skillText('copied', 'Review author `cursor`; environment `CURSOR_AUTOMATION_ID`.\nTypeScript uses `readonly` fields. Cursor is an editor. Task planning is ordinary prose.\nSee [web](https://example.invalid/docs), [section](#section), and [notes](references/notes.md).\nUse /skill:transformed. Apply the **transformed** skill.'));
  await checkContent(f);
});

test('support files also require dependency closure', async (t) => {
  const f = await contentFixture(t);
  await f.rewrite('skills/copied/references/notes.md', 'Apply the **omitted** skill.');
  await assert.rejects(checkContent(f), /Missing named skill/);
});

test('manifest and lock must agree on every source, output, and adaptation', async (t) => {
  const f = await contentFixture(t);
  for (const mutate of [
    /** @param {import('../../scripts/sync-upstream.mjs').Lock} lock */ (lock) => { lock.files.pop(); },
    /** @param {import('../../scripts/sync-upstream.mjs').Lock} lock */ (lock) => { lock.repository = 'https://example.invalid/other'; },
    /** @param {import('../../scripts/sync-upstream.mjs').Lock} lock */ (lock) => { lock.files[0].output = null; },
    /** @param {import('../../scripts/sync-upstream.mjs').Lock} lock */ (lock) => { lock.files[0].adaptationSha256 = 'a'.repeat(64); },
    /** @param {import('../../scripts/sync-upstream.mjs').Lock} lock */ (lock) => { lock.files[2].blob = 'b'.repeat(40); },
    /** @param {import('../../scripts/sync-upstream.mjs').Lock} lock */ (lock) => { lock.files[2].adaptationSha256 = 'c'.repeat(64); },
  ]) {
    const lock = structuredClone(f.lock);
    mutate(lock);
    assert.throws(() => contentInventory(f.manifest, lock));
  }
});

test('package has no implicit resources, agents, runtime dependencies, or approval hooks', async (t) => {
  const f = await contentFixture(t);
  const inventory = await checkContent(f);
  for (const pkg of [
    { ...f.pkg, pi: undefined },
    { ...f.pkg, pi: { ...f.pkg.pi, extensions: ['extensions/gate.ts'] } },
    { ...f.pkg, pi: { ...f.pkg.pi, hooks: ['gate'] } },
    { ...f.pkg, pi: { ...f.pkg.pi, prompts: ['prompts'] } },
    { ...f.pkg, pi: { ...f.pkg.pi, themes: ['themes'] } },
    { ...f.pkg, pi: { ...f.pkg.pi, skills: ['skills'] } },
    { ...f.pkg, files: [...f.pkg.files, 'agents/agent.md'] },
    { ...f.pkg, files: ['skills'] },
    { ...f.pkg, dependencies: { gate: '*' } },
    { ...f.pkg, bin: 'gate.js' },
    { ...f.pkg, scripts: { postinstall: 'node gate.js' } },
  ]) assert.throws(() => assertPackageExposure(pkg, inventory));
  const agentManifest = structuredClone(f.manifest);
  const first = agentManifest.files[0];
  assert.ok(first.kind === 'copy');
  first.destination = 'agents/agent.md';
  assert.throws(() => contentInventory(agentManifest, f.lock), /zero agents/);
  await f.put('agents/agent.md', 'agent');
  await assert.rejects(checkContent(f), /membership/);
});

test('pack inventory rejects extras, omissions, duplicates, and tar path escapes', async (t) => {
  const f = await contentFixture(t);
  const inventory = await checkContent(f);
  const expected = expectedPackFiles(inventory);
  for (const actual of [expected.slice(1), [...expected, 'vendor/source'], [...expected, expected[0]], [...expected, '../escape']]) {
    assert.throws(() => assertPackInventory(actual, inventory), /membership/);
  }
  await f.put('hidden.js', 'extension');
  await assert.rejects(checkPackedContent(f.root, inventory), /membership/);
  await rm(path.join(f.root, 'hidden.js'));
  await f.put(entrypoint, `${await readFile(path.join(f.root, entrypoint), 'utf8')}changed`);
  await assert.rejects(checkPackedContent(f.root, inventory), /Packed bytes/);
});
