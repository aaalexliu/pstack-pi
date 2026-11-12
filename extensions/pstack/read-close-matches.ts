import { isReadToolResult, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const maxCloseMatches = 10;
const maxEditDistance = 3;
const enoentPrefix = 'ENOENT: ';
const accessMarker = ", access '";

function nodeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function editDistanceAtMost(left: string, right: string, max: number): number | undefined {
  if (Math.abs(left.length - right.length) > max) return undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  const distance = previous[right.length];
  return distance <= max ? distance : undefined;
}

function rankNames(names: readonly string[], wanted: string): string[] {
  const wantedStem = stem(wanted);
  const sameStem = names.filter((name) => name !== wanted && stem(name) === wantedStem).sort(byName);
  const near = names.flatMap((name) => {
    if (stem(name) === wantedStem && name !== wanted) return [];
    if (Math.abs(name.length - wanted.length) > maxEditDistance) return [];
    const distance = editDistanceAtMost(name, wanted, maxEditDistance);
    return distance === undefined ? [] : [{ name, distance }];
  }).sort((left, right) => left.distance - right.distance || byName(left.name, right.name));
  return [...sameStem, ...near.map((item) => item.name)].slice(0, maxCloseMatches);
}

function pathFromEnoent(text: string): string | undefined {
  const start = text.indexOf(accessMarker);
  if (start === -1) return undefined;
  let raw = text.slice(start + accessMarker.length);
  if (raw.endsWith("'")) raw = raw.slice(0, -1);
  return isAbsolute(raw) ? raw : undefined;
}

function resolveInput(input: string, cwd: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return resolve(cwd, input);
}

function missingPath(text: string, input: unknown, cwd: string): string | undefined {
  if (!text.startsWith(enoentPrefix)) return undefined;
  const fromError = pathFromEnoent(text);
  if (fromError) return fromError;
  if (typeof input !== 'string' || input.length === 0) return undefined;
  return resolveInput(input, cwd);
}

async function nearestDirectory(start: string): Promise<string | undefined> {
  let current = start;
  while (true) {
    try {
      const info = await stat(current);
      if (info.isDirectory()) return current;
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function listDirectory(directory: string): Promise<{ names: string[]; directories: ReadonlySet<string> } | undefined> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  const directories = new Set<string>();
  try {
    for await (const entry of handle) {
      if (entry.name.includes('\n') || entry.name.includes('\r')) continue;
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          folder = (await stat(join(directory, entry.name))).isDirectory();
        } catch {
          continue;
        }
      }
      names.push(entry.name);
      if (folder) directories.add(entry.name);
    }
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { names, directories };
}

function childSegments(absolutePath: string, directory: string): string[] {
  const rel = relative(directory, absolutePath);
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [];
  return rel.split(sep).filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function shownPath(directory: string, name: string, cwd: string, absoluteInput: boolean): string {
  const full = join(directory, name);
  if (absoluteInput) return full;
  const shown = relative(cwd, full);
  if (shown === '' || shown.startsWith('..') || isAbsolute(shown)) return full;
  if (shown === '~' || shown.startsWith('~/') || shown.startsWith('@')) return `./${shown}`;
  return shown;
}

async function closeMatchNote(text: string, input: unknown, cwd: string): Promise<string | undefined> {
  const missing = missingPath(text, input, cwd);
  if (!missing) return undefined;
  const trimmed = missing.replace(/[/\\]+$/u, '');
  if (basename(trimmed) === '' || basename(trimmed) === '.' || basename(trimmed) === '..') return undefined;
  const directory = await nearestDirectory(dirname(trimmed));
  if (!directory) return undefined;
  const segments = childSegments(trimmed, directory);
  if (segments.length === 0) return undefined;
  const listed = await listDirectory(directory);
  if (!listed) return undefined;
  // Rank the first missing segment. Ranking the leaf against a higher folder
  // suggests a different file, and misses a close folder name.
  const matches = rankNames(listed.names, segments[0]);
  const leaf = segments[segments.length - 1];
  if (
    segments.length > 1
    && listed.directories.has(leaf)
    && !matches.includes(leaf)
    && matches.length < maxCloseMatches
  ) {
    matches.push(leaf);
  }
  if (matches.length === 0) return undefined;
  const absoluteInput = typeof input === 'string' && (isAbsolute(input) || input.startsWith('~/'));
  const paths = matches.map((name) => {
    const shown = shownPath(directory, name, cwd, absoluteInput);
    return listed.directories.has(name) ? `${shown}/` : shown;
  });
  return `Closest existing paths:\n${paths.join('\n')}`;
}

function firstText(content: readonly { type: string; text?: string }[]): string {
  return content.find((item) => item.type === 'text' && typeof item.text === 'string')?.text ?? '';
}

export function registerReadCloseMatches(pi: ExtensionAPI): void {
  pi.on('tool_result', async (event, ctx) => {
    if (!isReadToolResult(event) || !event.isError || ctx.signal?.aborted) return;
    try {
      const note = await closeMatchNote(firstText(event.content), event.input.path, ctx.cwd);
      if (!note) return;
      return { content: [...event.content, { type: 'text' as const, text: note }] };
    } catch {
      return;
    }
  });
}
