import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{find: string, replace: string, count: number}} Transform */
/** @typedef {{kind: 'copy', source: string, destination: string} | {kind: 'transform', source: string, destination: string, expectedBlob: string, transforms: Transform[], reason: string} | {kind: 'replace', source: string, destination: string, expectedBlob: string, replacement: string, reason: string} | {kind: 'omit', source: string, reason: string}} Disposition */
/** @typedef {{version: 1, repository: string, sourceRoot: string, managedRoots: string[], files: Disposition[]}} Manifest */
/** @typedef {'100644' | '100755'} FileMode */
/** @typedef {{destination: string, sha256: string, mode: FileMode}} LockedOutput */
/** @typedef {{source: string, blob: string, mode: FileMode, adaptationSha256: string | null, output: LockedOutput | null}} LockedFile */
/** @typedef {{version: 1, repository: string, commit: string, sourceRoot: string, sourceTree: string, files: LockedFile[]}} Lock */
/** @typedef {{bytes: Buffer, mode: number}} Output */
/** @typedef {{path: string, kind: 'missing' | 'changed' | 'extra' | 'mode-mismatched'}} Difference */

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
  fields(value, ['version', 'repository', 'sourceRoot', 'managedRoots', 'files']);
  requireValue(value.version === 1, 'Unsupported manifest version');
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
  const manifest = /** @type {Manifest} */ (value);
  uniquePaths(manifest.files.map((file) => file.source), 'sources');
  uniquePaths(manifest.files.flatMap((file) => file.kind === 'omit' ? [] : [file.destination]), 'destinations');
  return manifest;
}

/** @param {unknown} value @returns {Lock} */
export function parseLock(value) {
  fields(value, ['version', 'repository', 'commit', 'sourceRoot', 'sourceTree', 'files']);
  requireValue(value.version === 1, 'Unsupported lock version');
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
  const lock = /** @type {Lock} */ (value);
  uniquePaths(lock.files.map((file) => file.source), 'locked sources');
  uniquePaths(lock.files.flatMap((file) => file.output ? [file.output.destination] : []), 'locked destinations');
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

/** @param {string} repositoryPath @param {Manifest} manifest @param {Lock} lock @param {string} replacementRoot */
async function render(repositoryPath, manifest, lock, replacementRoot) {
  requireValue(manifest.repository === lock.repository && manifest.sourceRoot === lock.sourceRoot, 'Manifest and lock identity differ');
  requireValue(git(repositoryPath, ['remote', 'get-url', 'origin']).toString().trim() === lock.repository, 'Repository identity mismatch');
  requireValue(git(repositoryPath, ['cat-file', '-t', lock.commit]).toString().trim() === 'commit', 'Locked object is not a commit');
  const tree = git(repositoryPath, ['rev-parse', `${lock.commit}:${lock.sourceRoot}`]).toString().trim();
  requireValue(tree === lock.sourceTree, 'Source tree drift');
  const listing = new TextDecoder('utf-8', { fatal: true }).decode(git(repositoryPath, ['ls-tree', '-r', '-z', tree]));
  /** @type {Map<string, {mode: FileMode, blob: string}>} */
  const sources = new Map();
  for (const row of listing.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, type, blob] = row.slice(0, tab).split(' ');
    requireValue(type === 'blob', 'Only source blobs are supported');
    fileMode(mode);
    sources.set(row.slice(tab + 1), { mode, blob });
  }
  uniquePaths([...sources.keys()], 'Git sources');
  const classified = new Set(manifest.files.map((file) => file.source));
  for (const source of sources.keys()) requireValue(classified.has(source), `Unclassified source: ${source}`);
  requireValue(lock.files.length === manifest.files.length, 'Lock coverage differs');
  const locked = new Map(lock.files.map((file) => [file.source, file]));
  /** @type {Map<string, Output>} */
  const outputs = new Map();
  for (const file of manifest.files) {
    const source = sources.get(file.source);
    requireValue(source, `Missing classified source: ${file.source}`);
    const entry = locked.get(file.source);
    requireValue(entry, `Missing locked source: ${file.source}`);
    requireValue(source.blob === entry.blob, `Source blob drift: ${file.source}`);
    requireValue(source.mode === entry.mode, `Source mode drift: ${file.source}`);
    if (file.kind === 'omit') {
      requireValue(entry.output === null && entry.adaptationSha256 === null, 'Omission cannot have output or adaptation');
      continue;
    }
    let bytes = git(repositoryPath, ['cat-file', 'blob', entry.blob]);
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
    requireValue(adaptation === entry.adaptationSha256, `Adaptation digest drift: ${file.source}`);
    requireValue(entry.output !== null && entry.output.destination === file.destination, `Locked destination differs: ${file.source}`);
    requireValue(entry.output.sha256 === sha256(bytes), `Output hash drift: ${file.destination}`);
    requireValue(entry.output.mode === source.mode, `Output mode drift: ${file.destination}`);
    outputs.set(file.destination, { bytes, mode: source.mode === '100755' ? 0o755 : 0o644 });
  }
  return outputs;
}

/** @param {string} root @param {string[]} managedRoots */
async function scan(root, managedRoots) {
  /** @type {Map<string, Output>} */
  const files = new Map();
  /** @param {string} relative */
  async function walk(relative) {
    const filename = await safePath(root, relative);
    const stat = await statOrMissing(filename);
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await walk(`${relative}/${child}`);
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

/**
 * @param {{repositoryPath: string, outputRoot: string, replacementRoot?: string, manifest: unknown, lock: unknown, mode: 'sync' | 'check', signal?: AbortSignal}} options
 */
export async function syncUpstream(options) {
  requireValue(options.mode === 'sync' || options.mode === 'check', 'Expected sync or check mode');
  const manifest = parseManifest(options.manifest);
  const lock = parseLock(options.lock);
  const outputRoot = path.resolve(options.outputRoot);
  options.signal?.throwIfAborted();
  const outputs = await render(options.repositoryPath, manifest, lock, options.replacementRoot ?? outputRoot);
  const actual = await scan(outputRoot, manifest.managedRoots);
  const differences = compare(outputs, actual);
  if (options.mode === 'check') return { clean: differences.length === 0, differences };
  const stage = await mkdtemp(path.join(outputRoot, '.pstack-sync-'));
  const content = path.join(stage, 'content');
  let preserveBackup = false;
  try {
    await mkdir(content);
    for (const root of manifest.managedRoots) await mkdir(path.join(content, root), { recursive: true });
    for (const [name, output] of outputs) {
      const filename = path.join(content, name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, output.bytes);
      await chmod(filename, output.mode);
    }
    requireValue(compare(outputs, await scan(content, manifest.managedRoots)).length === 0, 'Staging validation failed');
    options.signal?.throwIfAborted();
    if (differences.length === 0) return { clean: true, differences };
    const changedRoots = manifest.managedRoots.filter((root) => differences.some((difference) => difference.path.startsWith(`${root}/`)));
    /** @type {{target: string, backup: string, next: string, existed: boolean, promoted: boolean}[]} */
    const promotions = [];
    try {
      for (const root of changedRoots) {
        const target = await safePath(outputRoot, root);
        await mkdir(path.dirname(target), { recursive: true });
        const backup = path.join(stage, 'previous', root);
        await mkdir(path.dirname(backup), { recursive: true });
        promotions.push({ target, backup, next: path.join(content, root), existed: false, promoted: false });
      }
      options.signal?.throwIfAborted();
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
        throw new AggregateError(failures, `Rollback failed; backups remain at ${stage}`);
      }
      throw error;
    }
    return { clean: true, differences };
  } finally {
    if (!preserveBackup) await rm(stage, { recursive: true, force: true });
  }
}

/** @param {string[]} args */
async function main(args) {
  const [mode, repositoryPath, outputRoot, manifestPath, lockPath, replacementRoot] = args;
  requireValue((args.length === 5 || args.length === 6) && (mode === 'sync' || mode === 'check'), 'Usage: node scripts/sync-upstream.mjs <sync|check> <repository> <output-root> <manifest.json> <lock.json> [replacement-root]');
  const result = await syncUpstream({ mode, repositoryPath, outputRoot, manifest: JSON.parse(await readFile(manifestPath, 'utf8')), lock: JSON.parse(await readFile(lockPath, 'utf8')), replacementRoot });
  for (const difference of result.differences) console.log(`${difference.kind} ${difference.path}`);
  if (!result.clean) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
