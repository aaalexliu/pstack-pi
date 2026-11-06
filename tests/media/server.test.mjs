import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startMediaServer } from '../../extensions/media/server.ts';

test('the token page and feed expose only current files, with conditional polling and byte ranges', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-media-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('abcdefghij');
  const object = `${createHash('sha256').update(bytes).digest('hex')}.png`;
  await writeFile(join(root, object), bytes);
  const item = /** @type {const} */ ({ kind: 'image', mime: 'image/png', caption: 'before', name: 'first.png', object, bytes: bytes.length });
  /** @type {import('../../extensions/media/server.ts').Feed} */
  let feed = [
    { replyId: 'first', at: '2026-01-01T00:00:00.000Z', excerpt: 'First reply', items: [item] },
    { replyId: 'second', at: '2026-01-02T00:00:00.000Z', excerpt: 'Second reply', items: [item] },
  ];
  const server = await startMediaServer(() => feed, root);
  t.after(() => server.close());
  const base = server.url;
  const request = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => fetch(new URL(path, base), init);
  const page = await request('');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Pi media/u);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-src 'self'/u);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  const head = await request('', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('content-length')) > 0, true);
  const first = await request('feed.json');
  const json = /** @type {any} */ (await first.json());
  assert.deepEqual(json.turns.map((/** @type {any} */ turn) => turn.replyId), ['second', 'first']);
  assert.equal(json.turns[0].excerpt, 'Second reply');
  assert.deepEqual(json.turns[0].items[0], { kind: 'image', mime: 'image/png', caption: 'before', name: 'first.png', bytes: 10, url: `file/${object}` });
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(json.revision, etag);
  assert.equal((await request('feed.json', { headers: { 'If-None-Match': etag } })).status, 304);
  feed = feed.slice(0, 1);
  const changed = await request('feed.json', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal((await request(`file/${object}`, { method: 'HEAD' })).headers.get('content-length'), '10');
  const ranged = await request(`file/${object}`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await ranged.text(), 'cdef');
  assert.equal(await (await request(`file/${object}`, { headers: { Range: 'bytes=-3' } })).text(), 'hij');
  const invalid = await request(`file/${object}`, { headers: { Range: 'bytes=99-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  assert.equal((await request(`file/${'a'.repeat(64)}.png`)).status, 404);
  assert.equal((await request(`file/${object}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${new URL(base).port}/feed.json`)).status, 404);
  const hostStatus = (/** @type {string} */ host) => new Promise((resolve, reject) => {
    const call = httpRequest(base, { headers: { Host: host } }, (response) => { response.resume(); resolve(response.statusCode); });
    call.on('error', reject);
    call.end();
  });
  assert.equal(await hostStatus(`localhost:${new URL(base).port}`), 200);
  assert.equal(await hostStatus(`cmux-loopback.localtest.me:${new URL(base).port}`), 200);
  assert.equal(await hostStatus(`evil.localtest.me:${new URL(base).port}`), 421);
  assert.equal(await hostStatus(`example.com:${new URL(base).port}`), 421);
});
