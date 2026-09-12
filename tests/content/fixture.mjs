import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, transformDigest } from '../../scripts/sync-upstream.mjs';

/** @param {string} name @param {string} body */
export const skillText = (name, body = 'Fixture instructions.') => `---\nname: ${name}\ndescription: Use ${name} for fixture checks.\ndisable-model-invocation: true\n---\n\n${body}\n`;

/** @param {import('node:test').TestContext} t */
export async function contentFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pstack-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new Map([
    ['skills/copied/SKILL.md', skillText('copied', 'COPIED_MARKER\nSee [notes](references/notes.md).')],
    ['skills/copied/references/notes.md', 'Support notes.\n'],
    ['skills/transformed/SKILL.md', skillText('transformed', 'TRANSFORMED_MARKER\nUse /transformed.')],
    ['skills/omitted/SKILL.md', skillText('omitted')],
  ]);
  const transforms = [{ find: '/transformed', replace: '/skill:transformed', count: 1 }];
  /** @param {string} text */
  const blob = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
  /** @type {import('../../scripts/sync-upstream.mjs').Manifest} */
  const manifest = {
    version: 2, additions: [], repository: 'https://example.invalid/upstream.git', sourceRoot: 'pstack', managedRoots: ['skills', 'agents'],
    files: [...source].map(([name, text]) => name.includes('/omitted/')
      ? { kind: 'omit', source: name, reason: 'Fixture deferred workflow.' }
      : name.includes('/transformed/')
        ? { kind: 'transform', source: name, destination: name, expectedBlob: blob(text), transforms, reason: 'Use Pi skill syntax.' }
        : { kind: 'copy', source: name, destination: name }),
  };
  const output = new Map([...source].filter(([name]) => !name.includes('/omitted/')).map(([name, text]) => [name, name.includes('/transformed/') ? text.replace('/transformed', '/skill:transformed') : text]));
  /** @type {import('../../scripts/sync-upstream.mjs').Lock} */
  const lock = {
    version: 2, additions: [], repository: manifest.repository, sourceRoot: manifest.sourceRoot, commit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    files: manifest.files.map((file) => ({ source: file.source, blob: blob(source.get(file.source) ?? ''), mode: '100644',
      adaptationSha256: file.kind === 'transform' ? transformDigest(transforms) : null,
      output: file.kind === 'omit' ? null : { destination: file.destination, sha256: sha256(output.get(file.destination) ?? ''), mode: '100644' },
    })),
  };
  const pkg = {
    name: '@aaalexliu/pstack-pi', version: '0.0.0', license: 'MIT',
    pi: { extensions: [], skills: [...output.keys()].filter((name) => name.endsWith('/SKILL.md')).sort(), prompts: [], themes: [] },
    files: ['LICENSE', 'README.md', 'package.json', ...output.keys()].sort(),
  };
  /** @param {string} name @param {string | Buffer} text */
  async function put(name, text) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
    await chmod(path.join(root, name), 0o644);
  }
  /** @param {string} name @param {string | Buffer} text */
  async function rewrite(name, text) {
    await put(name, text);
    const entry = lock.files.find((file) => file.output?.destination === name);
    if (entry?.output) entry.output.sha256 = sha256(text);
  }
  for (const [name, text] of output) await put(name, text);
  await put('LICENSE', 'Fixture license.\n');
  await put('README.md', 'Fixture package.\n');
  await put('package.json', JSON.stringify(pkg));
  return { root, manifest, lock, pkg, source, output, put, rewrite };
}
