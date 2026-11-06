import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaFormats, type MediaTurn } from './media.ts';

export type Feed = Array<MediaTurn & { excerpt: string }>;

/** cmux opens a remote machine's loopback links through `cmux-loopback.localtest.me`. */
const loopbackHosts = ['127.0.0.1', 'localhost', 'cmux-loopback.localtest.me'];
const pagePath = fileURLToPath(new URL('./page.html', import.meta.url));
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export async function startMediaServer(feed: () => Feed, root: string): Promise<{ url: string; close(): Promise<void> }> {
  const page = await readFile(pagePath);
  const html = page.toString('utf8');
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  const style = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1];
  if (script === undefined || style === undefined) throw new Error('Media page script or style is missing');
  const hash = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
  const csp = `default-src 'none'; img-src 'self'; media-src 'self'; frame-src 'self'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; base-uri 'none'; form-action 'none'`;
  const token = randomBytes(24).toString('base64url');
  const prefix = `/${token}/`;
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    res.setHeader('X-Content-Type-Options', headers['X-Content-Type-Options']);
    res.setHeader('Referrer-Policy', headers['Referrer-Policy']);
    res.setHeader('Cache-Control', headers['Cache-Control']);
    res.setHeader('Content-Security-Policy', csp);
    if (!loopbackHosts.some((host) => req.headers.host === `${host}:${port}`)) { res.writeHead(421).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const path = req.url?.split('?')[0];
    if (!path?.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const send = (status: number, body: Buffer | string, extra: Record<string, string | number>) => {
      res.writeHead(status, { ...extra, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (path === prefix) { send(200, page, { 'Content-Type': 'text/html; charset=utf-8' }); return; }
    const turns = feed();
    if (path === `${prefix}feed.json`) {
      const published = { turns: turns.slice().reverse().map(({ replyId, at, excerpt, skipped, items }) => ({
        replyId, at, excerpt, skipped: skipped ?? [], items: items.map(({ kind, mime, caption, name, object, bytes }) => ({ kind, mime, caption, name, bytes, url: `file/${object}` })),
      })) };
      const revision = `"${createHash('sha256').update(JSON.stringify(published)).digest('hex')}"`;
      if (req.headers['if-none-match'] === revision) { res.writeHead(304, { ETag: revision }).end(); return; }
      send(200, JSON.stringify({ ...published, revision }), { 'Content-Type': 'application/json; charset=utf-8', ETag: revision });
      return;
    }
    const object = path.slice(`${prefix}file/`.length);
    const item = path.startsWith(`${prefix}file/`) && turns.flatMap((turn) => turn.items).find((entry) => entry.object === object);
    if (!item) { res.writeHead(404).end(); return; }
    const format = mediaFormats[extname(item.object).toLowerCase() as keyof typeof mediaFormats];
    if (!format) { res.writeHead(404).end(); return; }
    try {
      const file = join(root, item.object);
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      const size = info.size;
      let start = 0;
      let end = size - 1;
      if (req.headers.range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        if (!match[1]) {
          const length = Number(match[2]);
          start = length > 0 ? Math.max(0, size - length) : size;
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(Number(match[2]), size - 1);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      }
      const partial = req.headers.range !== undefined;
      res.writeHead(partial ? 206 : 200, {
        'Content-Type': format.mime, 'Accept-Ranges': 'bytes', 'Content-Length': partial ? end - start + 1 : size,
        ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      });
      if (req.method === 'HEAD' || size === 0) { res.end(); return; }
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { if (res.headersSent) res.destroy(); else res.writeHead(404).end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${prefix}`;
  return { url, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
