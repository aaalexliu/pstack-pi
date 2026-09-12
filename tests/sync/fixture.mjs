import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, transformDigest } from '../../scripts/sync-upstream.mjs';

/** @typedef {import('../../scripts/sync-upstream.mjs').Manifest} Manifest */
/** @typedef {import('../../scripts/sync-upstream.mjs').Lock} Lock */
/** @param {string} cwd @param {string[]} args */
export function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

/** @param {import('node:test').TestContext} t @param {'sha1' | 'sha256'} [objectFormat] */
export async function fixture(t, objectFormat = 'sha1') {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, 'repo');
  const outputRoot = path.join(root, 'out');
  const replacementRoot = path.join(root, 'replacements');
  await mkdir(path.join(repositoryPath, 'plugin'), { recursive: true });
  await mkdir(outputRoot);
  await mkdir(replacementRoot);
  git(repositoryPath, ['init', '-q', `--object-format=${objectFormat}`]);
  git(repositoryPath, ['config', 'user.name', 'Sync Test']);
  git(repositoryPath, ['config', 'user.email', 'sync@example.invalid']);
  git(repositoryPath, ['config', 'core.fileMode', 'true']);
  git(repositoryPath, ['remote', 'add', 'origin', 'https://example.invalid/upstream.git']);
  const original = new Map([
    ['copy.bin', Buffer.from([0, 255, 13, 10])],
    ['transform.md', Buffer.from('\uFEFFCursor Cursor\r\n')],
    ['replace.md', Buffer.from('upstream policy\n')],
    ['omit.md', Buffer.from('not for Pi\n')],
    ['run.sh', Buffer.from('#!/bin/sh\necho pinned\n')],
  ]);
  for (const [name, bytes] of original) await writeFile(path.join(repositoryPath, 'plugin', name), bytes);
  await chmod(path.join(repositoryPath, 'plugin/run.sh'), 0o755);
  git(repositoryPath, ['add', '.']);
  git(repositoryPath, ['commit', '-qm', 'fixture']);
  const commit = git(repositoryPath, ['rev-parse', 'HEAD']);
  /** @param {string} source */
  const blob = (source) => git(repositoryPath, ['rev-parse', `${commit}:plugin/${source}`]);
  const transforms = [{ find: 'Cursor', replace: 'Pi', count: 2 }, { find: 'Pi Pi', replace: 'Pi host', count: 1 }];
  const replacement = Buffer.from('reviewed Pi policy\n');
  await writeFile(path.join(replacementRoot, 'policy.md'), replacement);
  /** @type {Manifest} */
  const manifest = {
    version: 2, additions: [], repository: 'https://example.invalid/upstream.git', sourceRoot: 'plugin', managedRoots: ['skills/shared', 'agents/shared'],
    files: [
      { kind: 'copy', source: 'copy.bin', destination: 'skills/shared/copy.bin' },
      { kind: 'transform', source: 'transform.md', destination: 'skills/shared/transform.md', expectedBlob: blob('transform.md'), transforms, reason: 'Use Pi host names instead of Cursor names.' },
      { kind: 'replace', source: 'replace.md', destination: 'agents/shared/policy.md', expectedBlob: blob('replace.md'), replacement: 'policy.md', reason: 'Replace upstream policy with the reviewed Pi policy.' },
      { kind: 'omit', source: 'omit.md', reason: 'This file only applies to the upstream host.' },
      { kind: 'copy', source: 'run.sh', destination: 'agents/shared/run.sh' },
    ],
  };
  const expected = new Map([
    ['skills/shared/copy.bin', original.get('copy.bin') ?? Buffer.alloc(0)],
    ['skills/shared/transform.md', Buffer.from('\uFEFFPi host\r\n')],
    ['agents/shared/policy.md', replacement],
    ['agents/shared/run.sh', original.get('run.sh') ?? Buffer.alloc(0)],
  ]);
  /** @type {Lock} */
  const lock = {
    version: 2, additions: [], repository: manifest.repository, commit, sourceRoot: 'plugin', sourceTree: git(repositoryPath, ['rev-parse', `${commit}:plugin`]),
    files: manifest.files.map((file) => ({
      source: file.source, blob: blob(file.source), mode: file.source === 'run.sh' ? '100755' : '100644',
      adaptationSha256: file.kind === 'transform' ? transformDigest(transforms) : file.kind === 'replace' ? sha256(replacement) : null,
      output: file.kind === 'omit' ? null : { destination: file.destination, sha256: sha256(expected.get(file.destination) ?? Buffer.alloc(0)), mode: file.source === 'run.sh' ? '100755' : '100644' },
    })),
  };
  await mkdir(path.join(outputRoot, 'skills/native'), { recursive: true });
  await writeFile(path.join(outputRoot, 'skills/native/sentinel'), Buffer.from([0, 42, 255]));
  await writeFile(path.join(outputRoot, 'package.json'), 'native package\n');
  const options = { source: { kind: /** @type {const} */ ('git'), repositoryPath }, outputRoot, replacementRoot, manifest, lock };
  /** @param {string} message */
  function advance(message) {
    git(repositoryPath, ['add', '-A']);
    git(repositoryPath, ['commit', '-qm', message]);
    lock.commit = git(repositoryPath, ['rev-parse', 'HEAD']);
    lock.sourceTree = git(repositoryPath, ['rev-parse', `${lock.commit}:plugin`]);
  }
  return { ...options, repositoryPath, root, expected, options, advance };
}

/** @param {string} root @returns {Promise<Record<string, string>>} */
export async function snapshot(root) {
  /** @type {Record<string, string>} */
  const result = {};
  /** @param {string} relative */
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else result[name] = (await readFile(path.join(root, name))).toString('hex');
    }
  }
  await walk('');
  return result;
}
