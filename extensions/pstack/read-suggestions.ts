import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const matchLimit = 10;
const distanceLimit = 3;

type ToolContent = Readonly<{ type: string; text?: string }>;

export type ReadResultLike = Readonly<{
  toolName: string;
  isError: boolean;
  input: Readonly<{ path?: unknown }>;
  content: readonly ToolContent[];
}>;

function byName(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Levenshtein distance, or one past `limit` when the names are farther than that. */
function editDistance(left: string, right: string, limit: number): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMin = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + cost);
      current[column] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length] <= limit ? previous[right.length] : limit + 1;
}

function rankNames(missingName: string, names: readonly string[]): string[] {
  const missing = parse(missingName);
  const stemMatches: string[] = [];
  const closeMatches: { name: string; distance: number }[] = [];
  for (const name of names) {
    if (name.includes('\n') || name.includes('\r')) continue;
    const parsed = parse(name);
    if (parsed.name === missing.name && parsed.ext !== missing.ext) {
      stemMatches.push(name);
      continue;
    }
    const distance = editDistance(missingName, name, distanceLimit);
    if (distance <= distanceLimit) closeMatches.push({ name, distance });
  }
  stemMatches.sort(byName);
  closeMatches.sort((left, right) => left.distance - right.distance || byName(left.name, right.name));
  return [...stemMatches, ...closeMatches.map((match) => match.name)].slice(0, matchLimit);
}

function resolveRequestedPath(requestedPath: string, cwd: string): string {
  let path = requestedPath.startsWith('@') ? requestedPath.slice(1) : requestedPath;
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

function missingName(absolutePath: string): string {
  return basename(absolutePath.replace(/[/\\]+$/u, ''));
}

function nearestDirectory(absolutePath: string): string | undefined {
  let current = dirname(absolutePath.replace(/[/\\]+$/u, ''));
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function displayPath(absolutePath: string, requestedPath: string, cwd: string): string {
  const stripped = requestedPath.startsWith('@') ? requestedPath.slice(1) : requestedPath;
  if (stripped.startsWith('~') || isAbsolute(stripped)) return absolutePath;
  const shown = relative(resolve(cwd), absolutePath);
  return shown.split(sep).join('/');
}

/** Up to 10 existing paths in the nearest existing parent: same stem and another extension, then names within edit distance 3. */
export function suggestCloseMatches(requestedPath: string, cwd: string): string[] {
  if (!requestedPath) return [];
  const absolute = resolveRequestedPath(requestedPath, cwd);
  const name = missingName(absolute);
  const directory = name ? nearestDirectory(absolute) : undefined;
  if (!directory) return [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  return rankNames(name, entries.map((entry) => entry.name)).map((entryName) => {
    const shown = displayPath(join(directory, entryName), requestedPath, cwd);
    return directories.has(entryName) ? `${shown}/` : shown;
  });
}

function isEnoent(content: readonly ToolContent[]): boolean {
  return content.some((block) => block.type === 'text' && typeof block.text === 'string' && /(^|\n)ENOENT:/u.test(block.text));
}

export function readEnoentNote(event: ReadResultLike, cwd: string): string | undefined {
  if (event.toolName !== 'read' || event.isError !== true || !isEnoent(event.content)) return undefined;
  const requested = event.input.path;
  if (typeof requested !== 'string' || !requested) return undefined;
  const paths = suggestCloseMatches(requested, cwd);
  return paths.length ? `Close matches:\n${paths.join('\n')}` : undefined;
}

export function registerReadSuggestions(pi: ExtensionAPI): void {
  pi.on('tool_result', (event, ctx) => {
    try {
      const note = readEnoentNote(event, ctx.cwd);
      if (!note) return;
      return { content: [...event.content, { type: 'text', text: note }] };
    } catch {
      return;
    }
  });
}
