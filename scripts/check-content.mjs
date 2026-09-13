import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { parseAgent } from '../extensions/subagent/agents.ts';
import { parseLock, parseManifest, readAdditions, sha256, transformDigest } from './sync-upstream.mjs';

/** @typedef {{disposition: import('./sync-upstream.mjs').Disposition, locked: import('./sync-upstream.mjs').LockedFile}} ContentRecord */
/** @typedef {{disposition: import('./sync-upstream.mjs').Addition & {kind: 'addition'}, locked: import('./sync-upstream.mjs').LockedAddition}} AdditionRecord */
/** @typedef {{name: string, description: string, disabled: boolean, body: string, text: string, destination: string}} Skill */
/** @typedef {{bySource: Map<string, ContentRecord>, byDestination: Map<string, ContentRecord | AdditionRecord>, bySkillName: Map<string, Skill>, byAgentName: Map<string, import('../extensions/subagent/domain.ts').AgentDefinition>}} ContentInventory */

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} text @param {string} destination @returns {Skill} */
export function parseSkill(text, destination) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  assert.ok(match, `Missing YAML frontmatter: ${destination}`);
  const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
  assert.equal(document.errors.length + document.warnings.length, 0, `Invalid YAML: ${destination}: ${[...document.errors, ...document.warnings].join('; ')}`);
  const frontmatter = object(document.toJS({ maxAliasCount: 0 }));
  const allowed = new Set(['name', 'description', 'disable-model-invocation', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const key of Object.keys(frontmatter)) assert.ok(allowed.has(key), `Unsupported Pi field: ${key}`);
  const { name, description } = frontmatter;
  assert.ok(typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name), `Invalid skill name: ${destination}`);
  assert.ok(typeof description === 'string' && description.trim().length > 0 && description.length <= 1024, `Invalid skill description: ${destination}`);
  assert.ok(frontmatter['disable-model-invocation'] === undefined || typeof frontmatter['disable-model-invocation'] === 'boolean', `Invalid invocation flag: ${destination}`);
  for (const key of ['license', 'compatibility', 'allowed-tools']) {
    if (frontmatter[key] !== undefined) assert.ok(typeof frontmatter[key] === 'string' && frontmatter[key].trim(), `Invalid ${key}: ${destination}`);
  }
  if (typeof frontmatter.compatibility === 'string') assert.ok(frontmatter.compatibility.length <= 500, 'Compatibility exceeds 500 characters');
  if (frontmatter.metadata !== undefined) {
    for (const value of Object.values(object(frontmatter.metadata))) assert.equal(typeof value, 'string', 'Metadata values must be strings');
  }
  return { name, description, disabled: frontmatter['disable-model-invocation'] === true, body: text.slice(match[0].length).trim(), text, destination };
}

/** @param {unknown} rawManifest @param {unknown} rawLock @returns {ContentInventory} */
export function contentInventory(rawManifest, rawLock) {
  const manifest = parseManifest(rawManifest);
  const lock = parseLock(rawLock);
  assert.equal(manifest.repository, lock.repository, 'Repository mismatch');
  assert.equal(manifest.sourceRoot, lock.sourceRoot, 'Source root mismatch');
  const locked = new Map(lock.files.map((entry) => [entry.source, entry]));
  assert.equal(locked.size, manifest.files.length, 'Lock membership differs');
  /** @type {ContentInventory} */
  const inventory = { bySource: new Map(), byDestination: new Map(), bySkillName: new Map(), byAgentName: new Map() };
  for (const disposition of manifest.files) {
    const entry = locked.get(disposition.source);
    assert.ok(entry, `Missing locked source: ${disposition.source}`);
    const record = { disposition, locked: entry };
    inventory.bySource.set(disposition.source, record);
    if (disposition.kind === 'omit') {
      assert.equal(entry.output, null, 'Omission has output');
      assert.equal(entry.adaptationSha256, null, 'Omission has adaptation');
      continue;
    }
    assert.ok(disposition.kind === 'copy' || disposition.kind === 'transform', 'Pre-runtime content supports only copy, transform, and omit');
    assert.ok(/^skills\/[^/]+\/(?:SKILL\.md|references\/[^/]+\.md)$/u.test(disposition.destination), `Unsupported content destination (zero agents): ${disposition.destination}`);
    assert.ok(entry.output, `Missing locked output: ${disposition.source}`);
    assert.equal(entry.output.destination, disposition.destination, 'Locked destination differs');
    assert.equal(entry.output.mode, '100644', 'Content must not be executable');
    assert.equal(entry.mode, entry.output.mode, 'Source and output modes differ');
    if (disposition.kind === 'transform') {
      assert.equal(disposition.expectedBlob, entry.blob, 'Transform preimage differs');
      assert.equal(entry.adaptationSha256, transformDigest(disposition.transforms), 'Transform digest differs');
    } else assert.equal(entry.adaptationSha256, null, 'Copy has adaptation');
    inventory.byDestination.set(disposition.destination, record);
  }
  const additions = new Map(lock.additions.map((entry) => [entry.source, entry]));
  assert.equal(additions.size, manifest.additions.length, 'Addition lock membership differs');
  for (const addition of manifest.additions) {
    const entry = additions.get(addition.source);
    assert.ok(entry, `Missing locked addition: ${addition.source}`);
    assert.equal(entry.output.destination, addition.destination, 'Locked addition destination differs');
    assert.equal(entry.output.mode, addition.mode, 'Locked addition mode differs');
    assert.equal(addition.mode, '100644', 'Content must not be executable');
    assert.ok(addition.destination === 'agents/general-purpose.md' || /^skills\/[^/]+\/(?:SKILL\.md|references\/[^/]+\.md)$/u.test(addition.destination), `Unsupported addition destination: ${addition.destination}`);
    inventory.byDestination.set(addition.destination, { disposition: { ...addition, kind: 'addition' }, locked: entry });
  }
  return inventory;
}

/** @param {string} root @param {string[]} roots */
async function fileInventory(root, roots) {
  assert.ok((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'Root must be a real directory');
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  /** @param {string} relative */
  async function walk(relative) {
    const filename = path.join(root, relative);
    let stat;
    try { stat = await lstat(filename); }
    catch (error) {
      if (object(error).code === 'ENOENT' && roots.includes(relative)) return;
      throw error;
    }
    assert.ok(!stat.isSymbolicLink(), `Symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of await readdir(filename)) await walk(`${relative}/${child}`);
    } else {
      assert.ok(stat.isFile(), `Special file: ${relative}`);
      assert.equal(stat.mode & 0o7777, 0o644, `Unexpected file mode: ${relative}`);
      files.set(relative, await readFile(filename));
    }
  }
  for (const relative of roots) await walk(relative);
  return files;
}

/** @param {ContentInventory} inventory */
export function extensionFiles(inventory) {
  return inventory.byDestination.has('agents/general-purpose.md')
    ? ['extensions/subagent/agents.ts', 'extensions/subagent/domain.ts', 'extensions/subagent/index.ts', 'extensions/subagent/model-config.ts', 'extensions/subagent/model-runtime.ts', 'extensions/subagent/process.ts', 'extensions/subagent/protocol.ts', 'extensions/subagent/runner.ts', 'extensions/subagent/scheduler.ts', 'extensions/subagent/usage.ts'] : [];
}

/** @param {ContentInventory} inventory */
export function expectedPackFiles(inventory) {
  return ['LICENSE', 'README.md', 'package.json', ...inventory.byDestination.keys(), ...extensionFiles(inventory)].sort();
}

/** @param {string[]} actual @param {ContentInventory} inventory */
export function assertPackInventory(actual, inventory) {
  assert.deepEqual([...actual].sort(), expectedPackFiles(inventory), 'Packed file membership differs');
}

/** @param {unknown} rawPackage @param {ContentInventory} inventory */
export function assertPackageExposure(rawPackage, inventory) {
  const pkg = object(rawPackage);
  const pi = object(pkg.pi);
  assert.deepEqual(Object.keys(pi).sort(), ['extensions', 'prompts', 'skills', 'themes'], 'Unexpected Pi registration');
  const runtime = extensionFiles(inventory).length > 0;
  assert.deepEqual(pi.extensions, runtime ? ['extensions/subagent/index.ts'] : [], 'Only the single delegate may register');
  for (const key of ['prompts', 'themes']) assert.deepEqual(pi[key], [], `No ${key} may register`);
  assert.deepEqual(pkg.dependencies, runtime ? { yaml: '2.9.0' } : undefined, 'Unexpected runtime dependencies');
  if (runtime) assert.deepEqual(pkg.peerDependencies, { '@earendil-works/pi-coding-agent': '*', typebox: '*' });
  assert.deepEqual(pi.skills, [...inventory.byDestination.keys()].filter((name) => name.endsWith('/SKILL.md')).sort(), 'Pi skills must list each entrypoint explicitly');
  assert.ok(Array.isArray(pkg.files), 'Package files must be explicit');
  assertPackInventory(pkg.files, inventory);
  for (const key of ['optionalDependencies', 'bundledDependencies', 'bundleDependencies', 'bin', 'main', 'exports']) {
    assert.equal(pkg[key], undefined, `No runtime registration: ${key}`);
  }
  if (pkg.scripts !== undefined) {
    const scripts = object(pkg.scripts);
    for (const key of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) assert.equal(scripts[key], undefined, `No package lifecycle hook: ${key}`);
  }
}

/** @param {string} text @param {string} filename @param {ContentInventory} inventory */
function dependencies(text, filename, inventory) {
  assert.ok(!/(?:\bsubagent_type\b|\brun_in_background\b|\bAskQuestion\b|\.cursor\/|\bcursor-agent\b|\bTask\s+(?:tool|subagent|call)\b|`Task`\s+(?:tool|call)|\breadonly`?\s*:\s*`?true\b)/u.test(text), `Unsupported Cursor mechanics: ${filename}`);
  assert.ok(!/(?:\bpstack_(?:todo|config|sessions)\b|\bsubagent\s*\(|\bpi\.(?:on|registerTool)\s*\(|\bcommand-approval\s+gate\b)/u.test(text), `Runtime or command-gate dependency: ${filename}`);
  const sourceSkills = new Set([...inventory.bySource.keys()].flatMap((source) => /^skills\/([^/]+)\/SKILL\.md$/u.exec(source)?.slice(1) ?? []));
  for (const match of text.matchAll(/(?:^|[\s`(])\/(skill:)?([a-z0-9]+(?:-[a-z0-9]+)*)\b/gu)) {
    if (match[1]) assert.ok(inventory.bySkillName.has(match[2]), `Missing skill dependency: ${match[2]}`);
    else assert.ok(!sourceSkills.has(match[2]), `Unadapted skill command: /${match[2]}`);
  }
  for (const match of text.matchAll(/\*\*([a-z0-9-]+)\*\*(?=[^.\n]*\bskills?\b)/gu)) {
    const name = match[1];
    const skill = /\bprinciple skills?\b/u.test(text.slice((match.index ?? 0) + match[0].length).split(/[.\n]/u)[0]) && !name.startsWith('principle-') ? `principle-${name}` : name;
    assert.ok(inventory.bySkillName.has(skill), `Missing named skill dependency: ${skill}`);
  }
  const links = [...text.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/gu)].map((match) => match[1]);
  links.push(...[...text.matchAll(/^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gmu)].map((match) => match[1]));
  const support = [...text.matchAll(/`((?:(?:\.\.?\/)+(?:[^`\s]+)|(?:references|scripts|assets|playbooks)\/[^`\s]+))`/gu)].map((match) => match[1]);
  for (const target of [...links, ...support]) {
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
    const decoded = decodeURIComponent(target.split(/[?#]/u)[0]);
    assert.ok(!/^(?:\/|~|[a-z]+:)/iu.test(decoded) && !decoded.includes('\\'), `Non-relative local link: ${target}`);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), decoded));
    assert.ok(inventory.byDestination.has(resolved) || ['LICENSE', 'README.md'].includes(resolved), `Missing local dependency: ${filename} -> ${target}`);
  }
}

/** @param {{root: string, manifest: unknown, lock: unknown}} options */
export async function checkContent({ root, manifest, lock }) {
  const inventory = contentInventory(manifest, lock);
  const inputs = await readAdditions(root, parseManifest(manifest).additions);
  for (const entry of parseLock(lock).additions) {
    assert.equal(sha256(inputs.get(entry.source)?.bytes ?? Buffer.alloc(0)), entry.output.sha256, `Addition bytes differ: ${entry.source}`);
  }
  const files = await fileInventory(root, ['skills', 'agents']);
  assert.deepEqual([...files.keys()].sort(), [...inventory.byDestination.keys()].sort(), 'Generated file membership differs');
  const descriptions = new Set();
  for (const [destination, record] of inventory.byDestination) {
    const bytes = files.get(destination);
    assert.ok(bytes && record.locked.output);
    assert.equal(sha256(bytes), record.locked.output.sha256, `Generated hash differs: ${destination}`);
    if (destination.startsWith('agents/')) {
      const agent = parseAgent(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      assert.equal(destination, `agents/${agent.name}.md`, 'Agent name differs from destination');
      assert.ok(!inventory.byAgentName.has(agent.name), `Duplicate agent name: ${agent.name}`);
      inventory.byAgentName.set(agent.name, agent);
    }
    if (destination.endsWith('/SKILL.md')) {
      const skill = parseSkill(new TextDecoder('utf-8', { fatal: true }).decode(bytes), destination);
      assert.ok(!inventory.bySkillName.has(skill.name), `Duplicate skill name: ${skill.name}`);
      assert.ok(!descriptions.has(skill.description.trim()), `Duplicate skill description: ${skill.name}`);
      inventory.bySkillName.set(skill.name, skill);
      descriptions.add(skill.description.trim());
    }
  }
  for (const [filename, bytes] of files) {
    if (filename.startsWith('skills/')) {
      const owner = `skills/${filename.split('/')[1]}/SKILL.md`;
      assert.ok([...inventory.bySkillName.values()].some((skill) => skill.destination === owner), `Support file has no skill: ${filename}`);
    }
    dependencies(new TextDecoder('utf-8', { fatal: true }).decode(bytes), filename, inventory);
  }
  assertPackageExposure(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')), inventory);
  return inventory;
}

/** @param {string} root @param {ContentInventory} inventory */
export async function checkPackedContent(root, inventory) {
  const files = await fileInventory(root, await readdir(root));
  assertPackInventory([...files.keys()], inventory);
  assertPackageExposure(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')), inventory);
  for (const [name, record] of inventory.byDestination) {
    assert.equal(sha256(files.get(name) ?? Buffer.alloc(0)), record.locked.output?.sha256, `Packed bytes differ: ${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = process.cwd();
    const inventory = await checkContent({ root, manifest: JSON.parse(await readFile('sync/manifest.json', 'utf8')), lock: JSON.parse(await readFile('sync/upstream.lock.json', 'utf8')) });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }));
    assertPackInventory(packed[0].files.map(/** @param {{path: string}} file */ (file) => file.path), inventory);
    console.log(`${inventory.bySource.size} records, ${inventory.byDestination.size} files, ${inventory.bySkillName.size} skills, ${inventory.byAgentName.size} agents, ${extensionFiles(inventory).length ? 1 : 0} extensions`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
