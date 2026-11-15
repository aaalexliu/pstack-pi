import { isToolCallEventType, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const grepHint = 'Blocked: `grep -r` without `--exclude-dir` walks node_modules and other dependency folders. Use `rg PATTERN [PATH]`, which skips .gitignore matches (add `-uu` to search them), or `git grep` from the repo root. To keep grep, add `--exclude-dir=node_modules`. This is a routine redirect, not a papercut.';
export const findHint = 'Blocked: `find` from `~` or `/` walks the whole home folder or disk. Start from the folder you mean, add `-maxdepth 3` or less, or use `rg --files PATH | rg NAME`. To locate a program, ask `command -v`, `brew --prefix`, or the tool itself. This is a routine redirect, not a papercut.';

const maxFindDepth = 3;

type Word = { text: string; quoted: boolean };
type Segment = Word[];

const separators = new Set(['&&', '||', '|', '|&', ';', '&', '\n', '(', ')', '$(', '`', ';;']);
const prefixWords = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup']);
const optionPrefixes = new Set(['sudo', 'env', 'nice', 'stdbuf']);
const xargsArgFlags = new Set(['-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '-d', '-E', '-a']);
const grepArgFlags = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);
const grepLongArgFlags = new Set(['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--devices', '--label', '--color', '--colour', '--binary-files', '--include', '--exclude', '--exclude-from']);
const shells = new Set(['sh', 'bash', 'zsh', 'dash']);

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

function readHeredocDelimiter(command: string, start: number): { delimiter: string; strip: boolean; end: number } | undefined {
  let index = start;
  const strip = command[index] === '-';
  if (strip) index++;
  while (command[index] === ' ' || command[index] === '\t') index++;
  let delimiter = '';
  while (index < command.length && !/[\s;&|<>()]/u.test(command[index])) {
    const char = command[index];
    if (char !== '"' && char !== "'" && char !== '\\') delimiter += char;
    index++;
  }
  return delimiter ? { delimiter, strip, end: index } : undefined;
}

export function splitCommand(command: string): Segment[] {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let text = '';
  let quoted = false;
  let started = false;
  let dropNext = false;
  const heredocs: { delimiter: string; strip: boolean }[] = [];

  const endWord = (): void => {
    if (started) {
      if (dropNext) dropNext = false;
      else words.push({ text, quoted });
    }
    text = '';
    quoted = false;
    started = false;
  };
  const endSegment = (): void => {
    endWord();
    dropNext = false;
    if (words.length) segments.push(words);
    words = [];
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index];
    const next = command[index + 1];
    if (char === '\\') {
      if (next === '\n') { index += 2; continue; }
      if (next !== undefined) { text += next; started = true; }
      index += 2;
      continue;
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const stop = close === -1 ? command.length : close;
      text += command.slice(index + 1, stop);
      started = true;
      quoted = true;
      index = stop + 1;
      continue;
    }
    if (char === '"') {
      index++;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === '\\' && index + 1 < command.length) index++;
        text += command[index];
        index++;
      }
      started = true;
      quoted = true;
      index++;
      continue;
    }
    if (char === '#' && !started) {
      while (index < command.length && command[index] !== '\n') index++;
      continue;
    }
    if (char === '<' && next === '<' && command[index + 2] !== '<') {
      endWord();
      const heredoc = readHeredocDelimiter(command, index + 2);
      if (heredoc) {
        heredocs.push({ delimiter: heredoc.delimiter, strip: heredoc.strip });
        index = heredoc.end;
      } else {
        index += 2;
      }
      continue;
    }
    if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      if (started && /^\d+$/u.test(text) && !quoted) { text = ''; started = false; }
      endWord();
      index += char === '&' ? 2 : 1;
      while (command[index] === '>' || command[index] === '&' || command[index] === '|' || command[index] === '<') index++;
      if (/^\d|^-/u.test(command[index] ?? '') && command[index - 1] === '&') {
        while (/[\d-]/u.test(command[index] ?? '')) index++;
        continue;
      }
      dropNext = true;
      continue;
    }
    if (char === '\n') {
      endSegment();
      index++;
      for (const heredoc of heredocs.splice(0)) {
        while (index < command.length) {
          const lineEnd = command.indexOf('\n', index);
          const stop = lineEnd === -1 ? command.length : lineEnd;
          const line = command.slice(index, stop);
          index = stop + 1;
          if ((heredoc.strip ? line.replace(/^\t+/u, '') : line) === heredoc.delimiter) break;
        }
      }
      continue;
    }
    const pair = char + (next ?? '');
    if (pair === '$(' || pair === '&&' || pair === '||' || pair === '|&' || pair === ';;') {
      endSegment();
      index += 2;
      continue;
    }
    if (separators.has(char)) {
      endSegment();
      index++;
      continue;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      index++;
      continue;
    }
    text += char;
    started = true;
    index++;
  }
  endSegment();
  return segments;
}

function stripPrefixes(words: Word[]): Word[] {
  let rest = words;
  for (;;) {
    const head = rest[0];
    if (!head) return rest;
    if (!head.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(head.text)) { rest = rest.slice(1); continue; }
    if (prefixWords.has(head.text)) { rest = rest.slice(1); continue; }
    const name = base(head.text);
    if (optionPrefixes.has(name)) {
      rest = rest.slice(1);
      while (rest[0] && (rest[0].text.startsWith('-') || (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0].text)))) rest = rest.slice(1);
      continue;
    }
    if (name === 'timeout' || name === 'gtimeout') {
      rest = rest.slice(1);
      while (rest[0]?.text.startsWith('-')) rest = rest.slice(1);
      rest = rest.slice(1);
      continue;
    }
    if (name === 'xargs') {
      rest = rest.slice(1);
      while (rest[0]?.text.startsWith('-')) {
        const flag = rest[0].text;
        rest = rest.slice(xargsArgFlags.has(flag) ? 2 : 1);
      }
      continue;
    }
    return rest;
  }
}

function grepIsUnboundedRecursive(args: Word[]): boolean {
  let recursive = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index].text;
    if (arg === '--') break;
    if (arg.startsWith('--exclude-dir')) return false;
    if (arg === '--recursive' || arg === '--dereference-recursive' || arg === '--directories=recurse') { recursive = true; continue; }
    if (arg === '--directories' && args[index + 1]?.text === 'recurse') { recursive = true; index++; continue; }
    if (arg.startsWith('--')) {
      if (grepLongArgFlags.has(arg)) index++;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') continue;
    for (let position = 1; position < arg.length; position++) {
      const flag = arg[position];
      if (flag === 'r' || flag === 'R') recursive = true;
      if (grepArgFlags.has(flag)) {
        const value = arg.slice(position + 1) || args[index + 1]?.text;
        if (flag === 'd' && value === 'recurse') recursive = true;
        if (position === arg.length - 1) index++;
        break;
      }
    }
  }
  return recursive;
}

function expandHome(path: string, home: string): string | undefined {
  if (path === '~' || path.startsWith('~/')) return home + path.slice(1);
  const variable = /^(?:\$HOME|\$\{HOME\})(?=\/|$)/u.exec(path);
  if (variable) return home + path.slice(variable[0].length);
  if (path.startsWith('~') || path.includes('$')) return undefined;
  return path;
}

function isHomeOrAncestor(path: string, cwd: string | undefined, home: string): boolean {
  const expanded = expandHome(path.replace(/\/\*$/u, '') || '/', home);
  if (expanded === undefined) return false;
  if (!expanded.startsWith('/') && cwd === undefined) return false;
  const target = resolve(cwd ?? '/', expanded);
  for (let ancestor = home; ; ancestor = dirname(ancestor)) {
    if (target === ancestor) return true;
    if (ancestor === dirname(ancestor)) return false;
  }
}

function findIsHomeWide(args: Word[], cwd: string | undefined, home: string): boolean {
  let index = 0;
  const roots: string[] = [];
  while (index < args.length && /^-[HLPEXdsx]+$/u.test(args[index].text)) index++;
  while (index < args.length) {
    const arg = args[index].text;
    if (arg === '-f' && args[index + 1]) { roots.push(args[index + 1].text); index += 2; continue; }
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    roots.push(arg);
    index++;
  }
  if (roots.length === 0) roots.push('.');
  for (let position = index; position < args.length; position++) {
    if (args[position].text !== '-maxdepth') continue;
    const depth = Number(args[position + 1]?.text);
    if (Number.isInteger(depth) && depth <= maxFindDepth) return false;
  }
  return roots.some((root) => isHomeOrAncestor(root, cwd, home));
}

function changeDirectory(args: Word[], cwd: string | undefined, home: string): string | undefined {
  const target = args.find((arg) => !arg.text.startsWith('-') || arg.text === '-')?.text;
  if (target === undefined) return home;
  if (target === '-') return undefined;
  const expanded = expandHome(target, home);
  if (expanded === undefined) return undefined;
  if (expanded.startsWith('/')) return resolve(expanded);
  return cwd === undefined ? undefined : resolve(cwd, expanded);
}

export function searchGuardReason(command: string, cwd: string, home: string = homedir()): string | undefined {
  let current: string | undefined = cwd;
  const visit = (source: string): string | undefined => {
    for (const segment of splitCommand(source)) {
      const words = stripPrefixes(segment);
      const head = words[0];
      if (!head) continue;
      const name = base(head.text);
      const args = words.slice(1);
      if (name === 'cd' || name === 'pushd') { current = changeDirectory(args, current, home); continue; }
      if (shells.has(name)) {
        const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg.text));
        const script = flag === -1 ? undefined : args[flag + 1]?.text;
        if (script !== undefined) {
          const reason = visit(script);
          if (reason) return reason;
        }
        continue;
      }
      if ((name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'ggrep') && grepIsUnboundedRecursive(args)) return grepHint;
      if ((name === 'find' || name === 'gfind') && findIsHomeWide(args, current, home)) return findHint;
    }
    return undefined;
  };
  return visit(command);
}

export function registerSearchGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return;
    const reason = searchGuardReason(event.input.command, ctx.cwd);
    if (reason) return { block: true, reason };
  });
}
