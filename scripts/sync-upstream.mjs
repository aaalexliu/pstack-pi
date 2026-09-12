import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{find: string, replace: string, count: number}} Transform */
/** @typedef {{kind: 'copy', source: string, destination: string} | {kind: 'transform', source: string, destination: string, expectedBlob: string, transforms: Transform[], reason: string} | {kind: 'replace', source: string, destination: string, expectedBlob: string, replacement: string, reason: string} | {kind: 'omit', source: string, reason: string}} Disposition */
/** @typedef {{source: string, destination: string, mode: FileMode, reason: string}} Addition */
/** @typedef {{version: 2, repository: string, sourceRoot: string, managedRoots: string[], files: Disposition[], additions: Addition[]}} Manifest */
/** @typedef {'100644' | '100755'} FileMode */
/** @typedef {{destination: string, sha256: string, mode: FileMode}} LockedOutput */
/** @typedef {{source: string, blob: string, mode: FileMode, adaptationSha256: string | null, output: LockedOutput | null}} LockedFile */
/** @typedef {{source: string, output: LockedOutput}} LockedAddition */
/** @typedef {{version: 2, repository: string, commit: string, sourceRoot: string, sourceTree: string, files: LockedFile[], additions: LockedAddition[]}} Lock */
/** @typedef {{bytes: Buffer, mode: number}} Output */
/** @typedef {{path: string, kind: 'missing' | 'changed' | 'extra' | 'mode-mismatched'}} Difference */
/** @typedef {{kind: 'git', repositoryPath: string} | {kind: 'snapshot', snapshotRoot: string}} Source */
/** @typedef {{bytes: Buffer, mode: FileMode, blob: string, sha256: string}} SourceFile */
/** @typedef {{sourceTree: string, files: Map<string, SourceFile>}} SourceInventory */

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {unknown} value @param {string[]} keys @returns {asserts value is Record<string, unknown>} */
function fields(value, keys) {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected an object');
  const actual = Object.keys(value).sort();
  requireValue(JSON.stringify(actual) === JSON.stringify([...keys].sort()), `Expected fields ${keys.join(', ')}, got ${actual.join(', ')}`);
}

/** @param {unknown} value @returns {asserts value is string} */
function relativePath(value) {
  requireValue(typeof value === 'string' && value.length > 0, 'Expected a nonempty relative path');
  requireValue(!/[\\\x00-\x1f\x7f:*?"<>|]/u.test(value) && !path.posix.isAbsolute(value), `Unsafe path ${value}`);
  for (const part of value.split('/')) {
    requireValue(part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part), `Unsafe path ${value}`);
    requireValue(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) && part.toLowerCase() !== '.git', `Unsafe path ${value}`);
  }
}

/** @param {string} value */
const nativeKey = (value) => value.normalize('NFD').toLowerCase();
/** @param {unknown} value @returns {asserts value is string} */
function objectId(value) {
  requireValue(typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value), 'Expected full Git object ID');
}
/** @param {unknown} value @returns {asserts value is string} */
function digest(value) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'Expected SHA-256 digest');
}
/** @param {unknown} value @returns {asserts value is FileMode} */
function fileMode(value) {
  requireValue(value === '100644' || value === '100755', `Unsupported file mode ${value}`);
}
/** @param {unknown} value @returns {asserts value is string} */
function repositoryIdentity(value) {
  requireValue(typeof value === 'string' && /^https:\/\/[^\s/?#@]+\/[^\s?#]+$/u.test(value), 'Repository identity must be an HTTPS URL without credentials');
}

/** @param {string[]} paths @param {string} label */
function uniquePaths(paths, label) {
  /** @type {Map<string, {name: string, file: boolean}>} */
  const seen = new Map();
  for (const name of paths) {
    relativePath(name);
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = nativeKey(prefix);
      const previous = seen.get(key);
      requireValue(previous === undefined || (previous.name === prefix && i < parts.length && !previous.file), `Duplicate or native-path collision in ${label}: ${name}`);
      seen.set(key, { name: prefix, file: i === parts.length });
    }
  }
}

/** @param {unknown} value @returns {Manifest} */
export function parseManifest(value) {
  fields(value, ['version', 'repository', 'sourceRoot', 'managedRoots', 'files', 'additions']);
  requireValue(value.version === 2, 'Unsupported manifest version');
  repositoryIdentity(value.repository);
  relativePath(value.sourceRoot);
  requireValue(Array.isArray(value.managedRoots) && value.managedRoots.length > 0, 'Expected managed roots');
  for (const root of value.managedRoots) {
    relativePath(root);
    requireValue(/^(skills|agents)(\/|$)/u.test(root), `Unmanaged root ${root}`);
  }
  uniquePaths(value.managedRoots, 'managed roots');
  requireValue(Array.isArray(value.files) && value.files.length > 0, 'Expected exhaustive, nonempty file list');
  for (const file of value.files) {
    requireValue(typeof file === 'object' && file !== null, 'Expected disposition');
    switch (file.kind) {
      case 'copy': fields(file, ['kind', 'source', 'destination']); break;
      case 'omit': fields(file, ['kind', 'source', 'reason']); break;
      case 'replace':
        fields(file, ['kind', 'source', 'destination', 'expectedBlob', 'replacement', 'reason']);
        relativePath(file.replacement);
        objectId(file.expectedBlob);
        break;
      case 'transform':
        fields(file, ['kind', 'source', 'destination', 'expectedBlob', 'transforms', 'reason']);
        objectId(file.expectedBlob);
        requireValue(Array.isArray(file.transforms) && file.transforms.length > 0, 'Expected ordered transforms');
        for (const step of file.transforms) {
          fields(step, ['find', 'replace', 'count']);
          requireValue(typeof step.find === 'string' && step.find.length > 0 && typeof step.replace === 'string', 'Expected literal transform strings');
          requireValue(Number.isSafeInteger(step.count) && Number(step.count) > 0, 'Expected positive transform count');
        }
        break;
      default: throw new Error(`Unknown disposition ${file.kind}`);
    }
    if (file.kind !== 'copy') {
      requireValue(typeof file.reason === 'string' && file.reason.trim().length > 0, 'Expected a nonempty review reason');
    }
    relativePath(file.source);
    if (file.kind !== 'omit') {
      relativePath(file.destination);
      requireValue(value.managedRoots.some((root) => String(file.destination).startsWith(`${root}/`)), `Destination outside managed roots: ${file.destination}`);
    }
  }
  requireValue(Array.isArray(value.additions), 'Expected additions array');
  for (const addition of value.additions) {
    fields(addition, ['source', 'destination', 'mode', 'reason']);
    additionSource(addition.source);
    relativePath(addition.destination);
    requireValue(value.managedRoots.some((root) => String(addition.destination).startsWith(`${root}/`)), `Destination outside managed roots: ${addition.destination}`);
    fileMode(addition.mode);
    requireValue(typeof addition.reason === 'string' && addition.reason.trim().length > 0, 'Expected a nonempty review reason');
  }
  const manifest = /** @type {Manifest} */ (value);
  uniquePaths(manifest.files.map((file) => file.source), 'sources');
  uniquePaths(manifest.additions.map((file) => file.source), 'addition sources');
  uniquePaths([...manifest.files.flatMap((file) => file.kind === 'omit' ? [] : [file.destination]), ...manifest.additions.map((file) => file.destination)], 'destinations');
  return manifest;
}

/** @param {unknown} value @returns {Lock} */
export function parseLock(value) {
  fields(value, ['version', 'repository', 'commit', 'sourceRoot', 'sourceTree', 'files', 'additions']);
  requireValue(value.version === 2, 'Unsupported lock version');
  repositoryIdentity(value.repository);
  objectId(value.commit);
  objectId(value.sourceTree);
  relativePath(value.sourceRoot);
  requireValue(Array.isArray(value.files) && value.files.length > 0, 'Expected locked files');
  for (const file of value.files) {
    fields(file, ['source', 'blob', 'mode', 'adaptationSha256', 'output']);
    relativePath(file.source);
    objectId(file.blob);
    fileMode(file.mode);
    if (file.adaptationSha256 !== null) digest(file.adaptationSha256);
    if (file.output !== null) {
      fields(file.output, ['destination', 'sha256', 'mode']);
      relativePath(file.output.destination);
      digest(file.output.sha256);
      fileMode(file.output.mode);
    }
  }
  requireValue(Array.isArray(value.additions), 'Expected locked additions array');
  for (const addition of value.additions) {
    fields(addition, ['source', 'output']);
    additionSource(addition.source);
    fields(addition.output, ['destination', 'sha256', 'mode']);
    relativePath(addition.output.destination);
    requireValue(/^(skills|agents)\//u.test(addition.output.destination), 'Unmanaged addition output');
    digest(addition.output.sha256);
    fileMode(addition.output.mode);
  }
  const lock = /** @type {Lock} */ (value);
  uniquePaths(lock.files.map((file) => file.source), 'locked sources');
  uniquePaths(lock.additions.map((file) => file.source), 'locked addition sources');
  uniquePaths([...lock.files.flatMap((file) => file.output ? [file.output.destination] : []), ...lock.additions.map((file) => file.output.destination)], 'locked destinations');
  return lock;
}

/** @param {string | Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {Transform[]} transforms */
export const transformDigest = (transforms) => sha256(JSON.stringify(transforms.map(({ find, replace, count }) => ({ find, replace, count }))));

/** @param {string} repositoryPath @param {string[]} args */
function git(repositoryPath, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-replace-objects', '-C', repositoryPath, ...args], { env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} filename */
async function statOrMissing(filename) {
  try { return await lstat(filename); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** @param {string} root @param {string} relative */
async function safePath(root, relative) {
  relativePath(relative);
  let current = path.resolve(root);
  const base = await lstat(current);
  requireValue(base.isDirectory() && !base.isSymbolicLink(), 'Root must be a real directory');
  for (const part of relative.split('/')) {
    const parent = await statOrMissing(current);
    if (parent) {
      requireValue(parent.isDirectory() && !parent.isSymbolicLink(), `Not a real directory: ${current}`);
      for (const entry of await readdir(current)) {
        requireValue(nativeKey(entry) !== nativeKey(part) || entry === part, `Native-path collision: ${relative}`);
      }
    }
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    requireValue(!stat?.isSymbolicLink(), `Symlink path: ${relative}`);
  }
  return current;
}

/** @param {string} left @param {string} right */
const byteOrder = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

/** @param {'blob' | 'tree'} kind @param {Buffer} bytes @param {string} algorithm */
function gitObjectId(kind, bytes, algorithm) {
  return createHash(algorithm).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
}

/** @param {Buffer} bytes @param {FileMode} mode @param {string} algorithm @returns {SourceFile} */
function sourceFile(bytes, mode, algorithm) {
  return { bytes, mode, blob: gitObjectId('blob', bytes, algorithm), sha256: sha256(bytes) };
}

/** @param {Map<string, SourceFile>} files @param {string} algorithm */
function sourceTree(files, algorithm) {
  /** @typedef {{files: Map<string, SourceFile>, directories: Map<string, Tree>}} Tree */
  /** @returns {Tree} */
  const empty = () => ({ files: new Map(), directories: new Map() });
  const root = empty();
  for (const [name, file] of files) {
    const parts = name.split('/');
    const leaf = parts.pop();
    requireValue(leaf, 'Expected source filename');
    let tree = root;
    for (const part of parts) {
      let child = tree.directories.get(part);
      if (!child) tree.directories.set(part, child = empty());
      tree = child;
    }
    tree.files.set(leaf, file);
  }
  /** @param {Tree} tree @returns {string} */
  function hash(tree) {
    const entries = [
      ...[...tree.files].map(([name, file]) => ({ name, sort: name, mode: file.mode, oid: file.blob })),
      ...[...tree.directories].map(([name, child]) => ({ name, sort: `${name}/`, mode: '40000', oid: hash(child) })),
    ].sort((a, b) => byteOrder(a.sort, b.sort));
    const bytes = Buffer.concat(entries.flatMap(({ name, mode, oid }) => [Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]));
    return gitObjectId('tree', bytes, algorithm);
  }
  return hash(root);
}

/** @param {Source} source @param {{repository: string, commit: string, sourceRoot: string}} identity @returns {Promise<SourceInventory>} */
async function inventory(source, identity) {
  objectId(identity.commit);
  const algorithm = identity.commit.length === 40 ? 'sha1' : 'sha256';
  /** @type {Map<string, SourceFile>} */
  const files = new Map();
  if (source.kind === 'git') {
    fields(source, ['kind', 'repositoryPath']);
    const repositoryPath = source.repositoryPath;
    requireValue(git(repositoryPath, ['remote', 'get-url', 'origin']).toString().trim() === identity.repository, 'Repository identity mismatch');
    requireValue(git(repositoryPath, ['cat-file', '-t', identity.commit]).toString().trim() === 'commit', 'Locked object is not a commit');
    const tree = git(repositoryPath, ['rev-parse', `${identity.commit}:${identity.sourceRoot}`]).toString().trim();
    requireValue(git(repositoryPath, ['cat-file', '-t', tree]).toString().trim() === 'tree', 'Source root must be a tree');
    const listing = new TextDecoder('utf-8', { fatal: true }).decode(git(repositoryPath, ['ls-tree', '-r', '-z', tree]));
    for (const row of listing.split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t');
      const [mode, type, blob] = row.slice(0, tab).split(' ');
      requireValue(type === 'blob', 'Only source blobs are supported');
      fileMode(mode);
      const file = sourceFile(git(repositoryPath, ['cat-file', 'blob', blob]), mode, algorithm);
      requireValue(file.blob === blob, 'Git blob identity mismatch');
      files.set(row.slice(tab + 1), file);
    }
    uniquePaths([...files.keys()], 'Git sources');
    requireValue(sourceTree(files, algorithm) === tree, 'Git source tree cannot be reconstructed');
    return { sourceTree: tree, files };
  }
  requireValue(source.kind === 'snapshot', 'Expected git or snapshot source');
  fields(source, ['kind', 'snapshotRoot']);
  const root = path.resolve(source.snapshotRoot);
  const stat = await lstat(root);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Snapshot root must be a real directory');
  /** @param {string} relative */
  async function walk(relative) {
    const directory = relative ? await safePath(root, relative) : root;
    const children = await readdir(directory, { encoding: 'buffer' });
    requireValue(children.length > 0, `Empty snapshot directory: ${relative}`);
    const names = children.map((child) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(child));
    uniquePaths(names, 'snapshot directory');
    for (const name of names.sort(byteOrder)) {
      const child = relative ? `${relative}/${name}` : name;
      const filename = await safePath(root, child);
      const stat = await lstat(filename);
      if (stat.isDirectory()) await walk(child);
      else {
        requireValue(stat.isFile(), `Non-regular snapshot file: ${child}`);
        files.set(child, sourceFile(await readFile(filename), stat.mode & 0o111 ? '100755' : '100644', algorithm));
      }
    }
  }
  await walk('');
  uniquePaths([...files.keys()], 'snapshot sources');
  return { sourceTree: sourceTree(files, algorithm), files };
}

/** @param {SourceInventory} sources @param {Manifest} manifest */
function coverage(sources, manifest) {
  const classified = new Set(manifest.files.map((file) => file.source));
  for (const name of sources.files.keys()) requireValue(classified.has(name), `Unclassified source: ${name}`);
  for (const file of manifest.files) requireValue(sources.files.has(file.source), `Missing classified source: ${file.source}`);
}

/** @param {SourceInventory} sources @param {Lock} lock */
function verifySource(sources, lock) {
  requireValue(sources.sourceTree === lock.sourceTree, 'Source tree drift');
  requireValue(sources.files.size === lock.files.length, 'Lock coverage differs');
  for (const entry of lock.files) {
    const source = sources.files.get(entry.source);
    requireValue(source, `Missing locked source: ${entry.source}`);
    requireValue(source.blob === entry.blob, `Source blob drift: ${entry.source}`);
    requireValue(source.mode === entry.mode, `Source mode drift: ${entry.source}`);
  }
}

/** @param {unknown} value @returns {asserts value is string} */
function additionSource(value) {
  relativePath(value);
  requireValue(value.startsWith('sync/additions/'), 'Addition source must be below sync/additions/');
}

/** @param {string} root @param {Addition[]} additions */
export async function readAdditions(root, additions) {
  const inputs = await scan(root, ['sync/additions'], true);
  requireValue(inputs.size === additions.length, 'Addition input membership differs');
  for (const addition of additions) {
    const input = inputs.get(addition.source);
    requireValue(input, `Missing addition source: ${addition.source}`);
    requireValue(input.mode === (addition.mode === '100755' ? 0o755 : 0o644), `Addition input mode differs: ${addition.source}`);
  }
  return inputs;
}

/** @param {SourceInventory} sources @param {Manifest} manifest @param {string} replacementRoot @param {string} projectRoot */
async function evaluate(sources, manifest, replacementRoot, projectRoot) {
  coverage(sources, manifest);
  /** @type {Map<string, Output>} */
  const outputs = new Map();
  /** @type {LockedFile[]} */
  const files = [];
  for (const file of [...manifest.files].sort((a, b) => byteOrder(a.source, b.source))) {
    const source = sources.files.get(file.source);
    requireValue(source, `Missing classified source: ${file.source}`);
    const entry = { source: file.source, blob: source.blob, mode: source.mode };
    if (file.kind === 'omit') {
      files.push({ ...entry, adaptationSha256: null, output: null });
      continue;
    }
    let bytes = source.bytes;
    /** @type {string | null} */
    let adaptation = null;
    if (file.kind === 'transform' || file.kind === 'replace') {
      requireValue(file.expectedBlob === source.blob, `Stale reviewed preimage: ${file.source}`);
      if (file.kind === 'transform') {
        let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        for (const step of file.transforms) {
          const pieces = text.split(step.find);
          requireValue(pieces.length - 1 === step.count, `Wrong transform count: ${file.source}`);
          text = pieces.join(step.replace);
        }
        bytes = Buffer.from(text);
        adaptation = transformDigest(file.transforms);
      } else {
        const replacement = await safePath(replacementRoot, file.replacement);
        requireValue((await lstat(replacement)).isFile(), 'Replacement must be a regular file');
        bytes = await readFile(replacement);
        adaptation = sha256(bytes);
      }
    }
    files.push({ ...entry, adaptationSha256: adaptation, output: { destination: file.destination, sha256: sha256(bytes), mode: source.mode } });
    outputs.set(file.destination, { bytes, mode: source.mode === '100755' ? 0o755 : 0o644 });
  }
  const inputs = await readAdditions(projectRoot, manifest.additions);
  const additions = [...manifest.additions].sort((a, b) => byteOrder(a.source, b.source)).map((addition) => {
    const input = inputs.get(addition.source);
    requireValue(input, `Missing addition source: ${addition.source}`);
    outputs.set(addition.destination, input);
    return { source: addition.source, output: { destination: addition.destination, sha256: sha256(input.bytes), mode: addition.mode } };
  });
  return { files, additions, outputs };
}

/** @param {Manifest} manifest @param {Lock} lock */
function verifyIdentity(manifest, lock) {
  requireValue(manifest.repository === lock.repository && manifest.sourceRoot === lock.sourceRoot, 'Manifest and lock identity differ');
}

/** @param {LockedFile[]} evaluated @param {Lock} lock */
function verifyAdaptations(evaluated, lock) {
  const locked = new Map(lock.files.map((file) => [file.source, file]));
  for (const file of evaluated) {
    const entry = locked.get(file.source);
    requireValue(entry, `Missing locked source: ${file.source}`);
    if (file.output === null) {
      requireValue(entry.output === null && entry.adaptationSha256 === null, 'Omission cannot have output or adaptation');
      continue;
    }
    requireValue(file.adaptationSha256 === entry.adaptationSha256, `Adaptation digest drift: ${file.source}`);
    requireValue(entry.output !== null && entry.output.destination === file.output.destination, `Locked destination differs: ${file.source}`);
    requireValue(entry.output.sha256 === file.output.sha256, `Output hash drift: ${file.output.destination}`);
    requireValue(entry.output.mode === file.output.mode, `Output mode drift: ${file.output.destination}`);
  }
}

/** @param {Lock} lock */
export function serializeLock(lock) {
  return `${JSON.stringify({
    version: lock.version, repository: lock.repository, commit: lock.commit,
    sourceRoot: lock.sourceRoot, sourceTree: lock.sourceTree,
    files: [...lock.files].sort((a, b) => byteOrder(a.source, b.source)).map((file) => ({
      source: file.source, blob: file.blob, mode: file.mode, adaptationSha256: file.adaptationSha256,
      output: file.output === null ? null : { destination: file.output.destination, sha256: file.output.sha256, mode: file.output.mode },
    })),
    additions: [...lock.additions].sort((a, b) => byteOrder(a.source, b.source)).map(({ source, output }) => ({
      source, output: { destination: output.destination, sha256: output.sha256, mode: output.mode },
    })),
  }, null, 2)}\n`;
}

/** @param {string} root @param {string[]} managedRoots @param {boolean} [strictDirectories] */
async function scan(root, managedRoots, strictDirectories = false) {
  /** @type {Map<string, Output>} */
  const files = new Map();
  /** @param {string} relative */
  async function walk(relative) {
    const filename = await safePath(root, relative);
    const stat = await statOrMissing(filename);
    if (!stat) return;
    if (stat.isDirectory()) {
      const children = await readdir(filename);
      if (strictDirectories) {
        uniquePaths(children, 'addition directory');
        requireValue(children.length > 0 || managedRoots.includes(relative), `Empty addition directory: ${relative}`);
      }
      for (const child of children.sort()) await walk(`${relative}/${child}`);
    } else {
      requireValue(stat.isFile(), `Non-regular managed file: ${relative}`);
      requireValue(!managedRoots.includes(relative), `Managed root is not a directory: ${relative}`);
      files.set(relative, { bytes: await readFile(filename), mode: stat.mode & 0o7777 });
    }
  }
  for (const relative of managedRoots) await walk(relative);
  uniquePaths([...files.keys()], 'managed files');
  return files;
}

/** @param {Map<string, Output>} expected @param {Map<string, Output>} actual */
function compare(expected, actual) {
  /** @type {Difference[]} */
  const differences = [];
  for (const name of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const wanted = expected.get(name);
    const found = actual.get(name);
    if (!wanted) differences.push({ path: name, kind: 'extra' });
    else if (!found) differences.push({ path: name, kind: 'missing' });
    else {
      if (!wanted.bytes.equals(found.bytes)) differences.push({ path: name, kind: 'changed' });
      if (wanted.mode !== found.mode) differences.push({ path: name, kind: 'mode-mismatched' });
    }
  }
  return differences;
}

class RecoveryRequired extends Error {}

/** @template T @param {string} root @param {() => Promise<T>} operation @returns {Promise<T>} */
async function withProjectLock(root, operation) {
  const projectRoot = path.resolve(root);
  const stat = await lstat(projectRoot);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Project root must be a real directory');
  const filename = path.join(await realpath(projectRoot), '.pstack-sync.lock');
  const recovery = `Verify that no sync process is running. Inspect .pstack-sync-* backups and restore a matching snapshot and lock, and any managed outputs, before you manually remove ${filename}.`;
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ELOOP')) {
      throw new Error(`Project is locked at ${filename}. ${recovery}`, { cause: error });
    }
    throw error;
  }
  try {
    const owner = await handle.stat();
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`);
    let preserveLock = false;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RecoveryRequired) {
        preserveLock = true;
        throw new Error(`${error.message}. ${recovery}`, { cause: error });
      }
      throw error;
    } finally {
      if (!preserveLock) {
        const current = await statOrMissing(filename);
        requireValue(current?.isFile() && current.dev === owner.dev && current.ino === owner.ino, `Project lock changed at ${filename}. ${recovery}`);
        await unlink(filename);
      }
    }
  } finally {
    await handle.close();
  }
}

/** @param {Parameters<typeof syncProject>[0]} options */
export async function syncUpstream(options) {
  return withProjectLock(options.outputRoot, () => syncProject(options));
}

/**
 * @param {{source: Source, outputRoot: string, replacementRoot?: string, manifest: unknown, lock: unknown, mode: 'sync' | 'check', signal?: AbortSignal}} options
 */
async function syncProject(options) {
  requireValue(options.mode === 'sync' || options.mode === 'check', 'Expected sync or check mode');
  const manifest = parseManifest(options.manifest);
  const lock = parseLock(options.lock);
  const outputRoot = path.resolve(options.outputRoot);
  options.signal?.throwIfAborted();
  verifyIdentity(manifest, lock);
  const sources = await inventory(options.source, lock);
  coverage(sources, manifest);
  verifySource(sources, lock);
  const { files, additions, outputs } = await evaluate(sources, manifest, options.replacementRoot ?? outputRoot, outputRoot);
  verifyAdaptations(files, lock);
  requireValue(serializeLock({ ...lock, additions }) === serializeLock(lock), 'Locked addition drift');
  const actual = await scan(outputRoot, manifest.managedRoots);
  const differences = compare(outputs, actual);
  if (options.mode === 'check') return { clean: differences.length === 0, differences };
  await stagedPromotion(outputRoot, async (content) => {
    for (const root of manifest.managedRoots) await mkdir(path.join(content, root), { recursive: true });
    await writeOutputs(content, outputs);
    requireValue(compare(outputs, await scan(content, manifest.managedRoots)).length === 0, 'Staging validation failed');
    return manifest.managedRoots.filter((root) => differences.some((difference) => difference.path.startsWith(`${root}/`)));
  }, options.signal);
  return { clean: true, differences };
}

/** @param {string} root @param {Map<string, Output>} outputs */
async function writeOutputs(root, outputs) {
  for (const [name, output] of outputs) {
    const filename = path.join(root, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, output.bytes);
    await chmod(filename, output.mode);
  }
}

/** @param {string} outputRoot @param {(content: string) => Promise<string[]>} prepare @param {AbortSignal} [signal] */
async function stagedPromotion(outputRoot, prepare, signal) {
  const stat = await lstat(outputRoot);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Project root must be a real directory');
  const stage = await mkdtemp(path.join(outputRoot, '.pstack-sync-'));
  const content = path.join(stage, 'content');
  let preserveBackup = false;
  try {
    await mkdir(content);
    const changedRoots = await prepare(content);
    signal?.throwIfAborted();
    /** @type {{target: string, backup: string, next: string, existed: boolean, promoted: boolean}[]} */
    const promotions = [];
    try {
      for (const root of changedRoots) {
        const target = await safePath(outputRoot, root);
        const next = path.join(content, root);
        const current = await statOrMissing(target);
        const staged = await lstat(next);
        requireValue(!current || (staged.isDirectory() ? current.isDirectory() : current.isFile()), `Promotion target has wrong type: ${root}`);
        await mkdir(path.dirname(target), { recursive: true });
        const backup = path.join(stage, 'previous', root);
        await mkdir(path.dirname(backup), { recursive: true });
        promotions.push({ target, backup, next, existed: false, promoted: false });
      }
      signal?.throwIfAborted();
      for (const promotion of promotions) {
        if (await statOrMissing(promotion.target)) {
          await rename(promotion.target, promotion.backup);
          promotion.existed = true;
        }
        await rename(promotion.next, promotion.target);
        promotion.promoted = true;
      }
    } catch (error) {
      const failures = [error];
      for (const promotion of [...promotions].reverse()) {
        try {
          if (promotion.promoted) await rm(promotion.target, { recursive: true, force: true });
          if (promotion.existed) await rename(promotion.backup, promotion.target);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length > 1) {
        preserveBackup = true;
        throw new RecoveryRequired(`Rollback failed; backups remain at ${stage}`, { cause: new AggregateError(failures) });
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) {
      try { await rm(stage, { recursive: true, force: true }); }
      catch (error) { throw new RecoveryRequired(`Cleanup failed at ${stage}`, { cause: error }); }
    }
  }
}

/** @param {string} content @param {Lock} lock */
async function stageLock(content, lock) {
  const filename = path.join(content, 'sync/upstream.lock.json');
  await mkdir(path.dirname(filename), { recursive: true });
  const bytes = serializeLock(lock);
  await writeFile(filename, bytes);
  await chmod(filename, 0o644);
  requireValue(await readFile(filename, 'utf8') === bytes, 'Staged lock validation failed');
}

/** @param {Parameters<typeof importProject>[0]} options */
export async function importUpstream(options) {
  return withProjectLock(options.projectRoot, () => importProject(options));
}

/** @param {{source: {kind: 'git', repositoryPath: string}, commit: string, manifest: unknown, projectRoot: string, replacementRoot?: string, signal?: AbortSignal}} options */
async function importProject(options) {
  requireValue(options.source.kind === 'git', 'Import requires a Git source');
  objectId(options.commit);
  const manifest = parseManifest(options.manifest);
  const projectRoot = path.resolve(options.projectRoot);
  options.signal?.throwIfAborted();
  const identity = { version: /** @type {const} */ (2), repository: manifest.repository, commit: options.commit, sourceRoot: manifest.sourceRoot };
  const sources = await inventory(options.source, identity);
  const { files, additions } = await evaluate(sources, manifest, options.replacementRoot ?? projectRoot, projectRoot);
  const lock = parseLock({ ...identity, sourceTree: sources.sourceTree, files, additions });
  await stagedPromotion(projectRoot, async (content) => {
    const snapshotRoot = path.join(content, 'vendor/cursor-pstack');
    await mkdir(snapshotRoot, { recursive: true });
    await writeOutputs(snapshotRoot, new Map([...sources.files].map(([name, file]) => [name, { bytes: file.bytes, mode: file.mode === '100755' ? 0o755 : 0o644 }])));
    verifySource(await inventory({ kind: 'snapshot', snapshotRoot }, lock), lock);
    await stageLock(content, lock);
    return ['vendor/cursor-pstack', 'sync/upstream.lock.json'];
  }, options.signal);
  return lock;
}

/** @param {Parameters<typeof relockProject>[0]} options */
export async function relockUpstream(options) {
  return withProjectLock(options.projectRoot, () => relockProject(options));
}

/** @param {{projectRoot: string, manifest: unknown, replacementRoot?: string, signal?: AbortSignal}} options */
async function relockProject(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const manifest = parseManifest(options.manifest);
  options.signal?.throwIfAborted();
  const lockPath = await safePath(projectRoot, 'sync/upstream.lock.json');
  requireValue((await lstat(lockPath)).isFile(), 'Lock must be a regular file');
  const previous = parseLock(JSON.parse(await readFile(lockPath, 'utf8')));
  verifyIdentity(manifest, previous);
  const snapshotRoot = await safePath(projectRoot, 'vendor/cursor-pstack');
  const sources = await inventory({ kind: 'snapshot', snapshotRoot }, previous);
  verifySource(sources, previous);
  const { files, additions } = await evaluate(sources, manifest, options.replacementRoot ?? projectRoot, projectRoot);
  const lock = { ...previous, files, additions };
  await stagedPromotion(projectRoot, async (content) => {
    await stageLock(content, lock);
    return ['sync/upstream.lock.json'];
  }, options.signal);
  return lock;
}

/** @param {string[]} args */
async function main(args) {
  const [mode, ...rest] = args;
  if (mode === 'import') {
    const [repositoryPath, commit, projectRoot, manifestPath, replacementRoot] = rest;
    requireValue(rest.length === 4 || rest.length === 5, 'Usage: node scripts/sync-upstream.mjs import <repository> <full-commit> <project-root> <manifest.json> [replacement-root]');
    await withProjectLock(projectRoot, async () => importProject({ source: { kind: 'git', repositoryPath }, commit, projectRoot, manifest: JSON.parse(await readFile(manifestPath, 'utf8')), replacementRoot }));
    return;
  }
  if (mode === 'relock') {
    const [projectRoot, manifestPath, replacementRoot] = rest;
    requireValue(rest.length === 2 || rest.length === 3, 'Usage: node scripts/sync-upstream.mjs relock <project-root> <manifest.json> [replacement-root]');
    await withProjectLock(projectRoot, async () => relockProject({ projectRoot, manifest: JSON.parse(await readFile(manifestPath, 'utf8')), replacementRoot }));
    return;
  }
  const [kind, sourcePath, outputRoot, manifestPath, lockPath, replacementRoot] = rest;
  requireValue((rest.length === 5 || rest.length === 6) && (mode === 'sync' || mode === 'check') && (kind === 'git' || kind === 'snapshot'), 'Usage: node scripts/sync-upstream.mjs <sync|check> <git|snapshot> <source-path> <output-root> <manifest.json> <lock.json> [replacement-root]');
  /** @type {Source} */
  const source = kind === 'git' ? { kind, repositoryPath: sourcePath } : { kind, snapshotRoot: sourcePath };
  const result = await withProjectLock(outputRoot, async () => syncProject({ mode, source, outputRoot, manifest: JSON.parse(await readFile(manifestPath, 'utf8')), lock: JSON.parse(await readFile(lockPath, 'utf8')), replacementRoot }));
  for (const difference of result.differences) console.log(`${difference.kind} ${difference.path}`);
  if (!result.clean) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
