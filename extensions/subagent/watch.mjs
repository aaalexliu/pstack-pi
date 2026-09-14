import { open } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** @param {string} text @param {number} width */
export function clip(text, width) {
  const clean = stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  let result = '';
  let used = 0;
  for (const { segment } of segments.segment(clean)) {
    const cells = /^[\x20-\x7e]$/.test(segment) ? 1 : 2;
    if (used + cells > Math.max(0, width)) break;
    used += cells;
    result += segment;
  }
  return result;
}
/** @param {string} filename */
export async function readSnapshot(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid watch file');
    const data = JSON.parse(await file.readFile('utf8'));
    if (data.version !== 1 || !Number.isSafeInteger(data.parentPid) || data.parentPid <= 0 || !Number.isFinite(data.updatedAt)
      || !Array.isArray(data.lines) || data.lines.length > 400 || !data.lines.every((/** @type {unknown} */ line) => typeof line === 'string' && line.length <= 4096)) throw new Error('Invalid watch data');
    return /** @type {{parentPid: number, updatedAt: number, endedAt: number | null, lines: string[]}} */ (data);
  } finally { await file.close(); }
}
/** @param {string} filename */
async function watch(filename) {
  const tty = process.stdout.isTTY && process.stdin.isTTY;
  let offset = 0;
  let stopped = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let polling = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stdin.off('data', input);
    process.stdin.pause();
    if (tty) { process.stdin.setRawMode(false); process.stdout.write('\x1b[?25h\x1b[?1049l'); }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGHUP', stop);
  };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const snapshot = await readSnapshot(filename);
      try { process.kill(snapshot.parentPid, 0); } catch { throw new Error('Parent stopped'); }
      if (stopped) return;
      const width = Math.max(1, (process.stdout.columns ?? 100) - 1);
      const height = Math.max(1, (process.stdout.rows ?? 32) - 4);
      offset = Math.min(offset, Math.max(0, snapshot.lines.length - height));
      const stale = snapshot.endedAt === null && Date.now() - snapshot.updatedAt > 5000;
      const title = stale ? 'WATCH STALE - parent has not published in 5s' : 'PSTACK SUBAGENTS - read only';
      const lines = [title, 'q close viewer | j/k scroll | Esc in parent cancels work', '', ...snapshot.lines.slice(offset, offset + height), `${offset + 1}-${Math.min(offset + height, snapshot.lines.length)} / ${snapshot.lines.length} lines`];
      process.stdout.write((tty ? '\x1b[H\x1b[2J' : '') + lines.map((line) => clip(line, width)).join('\n') + '\n');
      if (!tty) stop();
    } catch {
      stop();
      process.stdout.write('Subagent watch ended: parent stopped or snapshot unavailable.\n');
    } finally { polling = false; }
  };
  /** @param {Buffer} chunk */
  const input = (chunk) => {
    const key = chunk.toString();
    if (key === 'q' || key === '\x03' || key === '\x04') stop();
    if (key === 'j' || key === '\x1b[B') offset++;
    if (key === 'k' || key === '\x1b[A') offset = Math.max(0, offset - 1);
    void poll();
  };
  if (tty) {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.stdin.setRawMode(true);
    process.stdin.on('data', input);
    process.stdin.resume();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  timer = setInterval(() => void poll(), 1000);
  await poll();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error('Usage: node watch.mjs /path/to/progress.json'); process.exitCode = 1; }
  else await watch(process.argv[2]);
}
