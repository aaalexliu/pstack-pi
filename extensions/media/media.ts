import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { stripControls } from '../shared/model.ts';

export const mediaEntryType = 'pstack-media';
export const maxMediaBytes = 1024 ** 3;

export const mediaFormats = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
} as const;

type Extension = keyof typeof mediaFormats;
export type MediaItem = { kind: 'image' | 'video' | 'pdf'; mime: string; caption: string; name: string; object: string; bytes: number };
export type MediaTurn = { replyId: string; at: string } & ({ items: [MediaItem, ...MediaItem[]]; skipped?: string[] } | { items: []; skipped: [string, ...string[]] });
type Citation = { path: string; caption: string };

const extensions = Object.keys(mediaFormats).map((ext) => ext.slice(1)).join('|');
const barePath = new RegExp(`(?:^|[\\s("'\x60])((?:file:\\/\\/)?(?:\\/|~\\/|\\.{1,2}\\/|[\\w.-]+\\/)[^\\s<>"'\x60\\[\\](){}]+?\\.(?:${extensions}))(?=$|[\\s"'\x60)\\]]|[.,;:!?](?:$|[\\s"'\x60)\\]]))`, 'giu');
const markdownLink = /!?\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/gu;

function withoutFences(text: string): string {
  let fence: { mark: string; size: number } | undefined;
  return text.split(/(?<=\n)/u).map((line) => {
    const start = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (start) {
      if (!fence) fence = { mark: start[1][0], size: start[1].length };
      else if (start[1][0] === fence.mark && start[1].length >= fence.size && /^\s*$/u.test(line.slice(start[0].length))) fence = undefined;
      return line.replace(/[^\n]/gu, ' ');
    }
    return fence ? line.replace(/[^\n]/gu, ' ') : line;
  }).join('');
}

function resolveCitation(raw: string, cwd: string): string | undefined {
  let path = raw.trim().replace(/^['"\x60<]+|['"\x60>.,;:!?]+$/gu, '');
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path); }
    catch { return undefined; }
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
  if (path.startsWith('~/')) path = join(process.env.HOME ?? cwd, path.slice(2));
  const absolute = resolve(cwd, path);
  return Object.hasOwn(mediaFormats, extname(absolute).toLowerCase()) ? absolute : undefined;
}

export function citations(text: string, cwd: string): Citation[] {
  const visible = withoutFences(text);
  const matches: Array<Citation & { offset: number }> = [];
  const masked = visible.split('');
  for (const match of visible.matchAll(markdownLink)) {
    const path = resolveCitation(match[2].startsWith('<') ? match[2].slice(1, -1) : match[2], cwd);
    if (path) matches.push({ path, caption: stripControls(match[1]).trim() || basename(path), offset: match.index });
    for (let i = match.index; i < match.index + match[0].length; i++) masked[i] = ' ';
  }
  for (const match of masked.join('').matchAll(barePath)) {
    const path = resolveCitation(match[1], cwd);
    if (path) matches.push({ path, caption: basename(path), offset: match.index });
  }
  const seen = new Set<string>();
  return matches.sort((a, b) => a.offset - b.offset).filter(({ path }) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  }).map(({ path, caption }) => ({ path, caption }));
}

export function decodeMediaTurn(data: unknown): MediaTurn | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const turn = data as Partial<MediaTurn>;
  if (typeof turn.replyId !== 'string' || !turn.replyId || typeof turn.at !== 'string' || !Array.isArray(turn.items)) return undefined;
  if (turn.skipped !== undefined && (!Array.isArray(turn.skipped) || !turn.skipped.every((name) => typeof name === 'string'))) return undefined;
  if (!turn.items.length && !turn.skipped?.length) return undefined;
  for (const item of turn.items) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.caption !== 'string' || typeof item.object !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes < 0) return undefined;
    const ext = extname(item.object).toLowerCase() as Extension;
    const format = mediaFormats[ext];
    if (!format || !new RegExp(`^[a-f0-9]{64}\\${ext}$`, 'u').test(item.object) || item.kind !== format.kind || item.mime !== format.mime) return undefined;
  }
  return turn as MediaTurn;
}

async function snapshot(source: string, root: string, limit: number): Promise<{ object: string; bytes: number } | 'skipped' | undefined> {
  let info;
  try { info = await stat(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.size > limit) return 'skipped';
  await mkdir(root, { recursive: true });
  const temp = join(root, `.media-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(createReadStream(source), new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > limit) return done(new Error('media size limit exceeded'));
        hash.update(chunk);
        done(null, chunk);
      },
    }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const object = `${hash.digest('hex')}${extname(source).toLowerCase()}`;
    try {
      if (!(await lstat(join(root, object))).isFile()) return 'skipped';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await rename(temp, join(root, object));
    }
    return { object, bytes };
  } catch (error) {
    if (error instanceof Error && error.message === 'media size limit exceeded') return 'skipped';
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function collectMediaTurn(replyId: string, text: string, cwd: string, root: string, limit = maxMediaBytes): Promise<MediaTurn | undefined> {
  const items: MediaItem[] = [];
  const skipped: string[] = [];
  for (const citation of citations(text, cwd)) {
    const ext = extname(citation.path).toLowerCase() as Extension;
    const result = await snapshot(citation.path, root, limit).catch(() => 'skipped' as const);
    if (result === 'skipped') skipped.push(basename(citation.path));
    else if (result) items.push({ ...mediaFormats[ext], caption: citation.caption, name: basename(citation.path), ...result });
  }
  if (!items.length && !skipped.length) return undefined;
  return { replyId, at: new Date().toISOString(), items, ...(skipped.length ? { skipped } : {}) } as MediaTurn;
}

export function mediaTurns(branch: SessionEntry[]): MediaTurn[] {
  return branch.flatMap((entry) => entry.type === 'custom' && entry.customType === mediaEntryType ? [decodeMediaTurn(entry.data)].filter((turn): turn is MediaTurn => turn !== undefined) : []);
}
