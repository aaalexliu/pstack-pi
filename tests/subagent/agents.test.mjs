import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverAgents, parseAgent } from '../../extensions/subagent/agents.ts';
import { parseRequest } from '../../extensions/subagent/domain.ts';

/** @param {string} name @param {string} [tools] */
export const agentText = (name, tools = '[read, grep, find, ls]') => `---\nname: ${name}\ndescription: Read fixture files.\ntools: ${tools}\n---\nDo not delegate.\n`;

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledDir = path.join(root, 'bundled');
  const userDir = path.join(root, 'user');
  await mkdir(bundledDir);
  await mkdir(userDir);
  await writeFile(path.join(bundledDir, 'general-purpose.md'), agentText('general-purpose'));
  return { root, bundledDir, userDir };
}

test('catalog has deterministic selection, user precedence, shadow records, and byte provenance', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bundledDir, 'z-last.md'), agentText('z-last'));
  await writeFile(path.join(f.userDir, 'general-purpose.md'), agentText('general-purpose', '[]'));
  await writeFile(path.join(f.userDir, 'a-first.md'), agentText('a-first'));
  const catalog = await discoverAgents(f);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual([...catalog.selected.keys()], ['a-first', 'general-purpose', 'z-last']);
  assert.equal(catalog.selected.get('general-purpose')?.provenance.kind, 'user');
  assert.deepEqual(catalog.selected.get('general-purpose')?.tools, []);
  assert.equal(catalog.shadowed.length, 1);
  assert.equal(catalog.shadowed[0].agent.provenance.kind, 'bundled');
  assert.deepEqual(catalog.shadowed[0].replacedBy, catalog.selected.get('general-purpose')?.provenance);
  assert.match(catalog.shadowed[0].agent.provenance.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await discoverAgents(f), catalog);
});

for (const text of [
  'No frontmatter', agentText('bad--name'), agentText('Good'), agentText('a'.repeat(65)),
  agentText('good').replace('description: Read fixture files.', 'description: "  "'),
  agentText('good').replace('name: good', 'name: good\nname: duplicate'),
  agentText('good').replace('name: good', 'name: [broken'),
  agentText('good').replace('name: good', 'name: !custom good'),
  agentText('good').replace('name: good', 'name: &n good').replace('Read fixture files.', '*n'),
  agentText('good').replace('tools: [read, grep, find, ls]\n', ''),
  ...['null', 'false', 'read, grep', '[read, read]', '[read, subagent]', '[unknown]', '["*"]', '[1]'].map((tools) => agentText('good', tools)),
  ...['model', 'cwd', 'trust', 'agentScope', 'extra'].map((field) => agentText('good').replace('name: good', `name: good\n${field}: x`)),
  agentText('good').replace('Do not delegate.\n', ''),
  agentText('good') + 'x'.repeat(65536),
]) {
  test(`agent parser rejects ${JSON.stringify(text.slice(0, 100))}`, () => assert.throws(() => parseAgent(text)));
}

test('agent parser accepts CRLF and explicit empty tools', () => {
  assert.deepEqual(parseAgent(agentText('none', '[]').replaceAll('\n', '\r\n')).tools, []);
});

for (const mutation of ['duplicate', 'malformed', 'symlink file', 'symlink directory', 'fifo', 'nested', 'invalid UTF-8', 'oversized']) {
  test(`catalog reports ${mutation} without silently accepting it`, async (t) => {
    const f = await fixture(t);
    const filename = path.join(f.userDir, 'other.md');
    if (mutation === 'duplicate') {
      await writeFile(filename, agentText('same'));
      await writeFile(path.join(f.userDir, 'second.md'), agentText('same'));
    }
    if (mutation === 'malformed') await writeFile(filename, 'bad');
    if (mutation === 'symlink file') await symlink(path.join(f.bundledDir, 'general-purpose.md'), filename);
    if (mutation === 'symlink directory') {
      await rm(f.userDir, { recursive: true });
      await symlink(f.bundledDir, f.userDir);
    }
    if (mutation === 'fifo') execFileSync('mkfifo', [filename]);
    if (mutation === 'nested') await mkdir(filename);
    if (mutation === 'invalid UTF-8') await writeFile(filename, Buffer.from([255]));
    if (mutation === 'oversized') await writeFile(filename, 'x'.repeat(65537));
    const catalog = await discoverAgents(f);
    assert.ok(catalog.diagnostics.length > 0);
  });
}

test('catalog permits an absent user directory and never scans project agents', async (t) => {
  const f = await fixture(t);
  await rm(f.userDir, { recursive: true });
  await mkdir(path.join(f.root, '.pi/agents'), { recursive: true });
  await writeFile(path.join(f.root, '.pi/agents/project.md'), agentText('project'));
  const catalog = await discoverAgents(f);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual([...catalog.selected.keys()], ['general-purpose']);
});

test('single requests reject unknown fields, modes, blank tasks, and trust arguments', () => {
  const valid = { agent: 'general-purpose', task: 'Read a file.' };
  assert.deepEqual(parseRequest(valid), { kind: 'single', task: valid });
  for (const input of [null, [], {}, { ...valid, kind: 'single' }, { tasks: [valid] }, { ...valid, task: ' ' }, { ...valid, task: 'x'.repeat(32769) }, { ...valid, cwd: '' }, { ...valid, cwd: '\0' }, { ...valid, agentScope: 'project' }, { ...valid, confirmProjectAgents: false }]) {
    assert.throws(() => parseRequest(input));
  }
});
