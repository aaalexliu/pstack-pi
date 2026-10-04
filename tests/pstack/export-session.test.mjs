import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  branchUsagePoints,
  bucketUsagePoints,
  enhanceExportedHtml,
  injectTimeline,
  registerExport,
  tokensFromUsage,
} from '../../extensions/pstack/export-session.ts';

test('tokensFromUsage sums provider usage fields', () => {
  assert.deepEqual(tokensFromUsage({
    input: 10,
    output: 2,
    cacheRead: 100,
    cacheWrite: 5,
    totalTokens: 117,
  }), {
    total: 117,
    input: 10,
    output: 2,
    cacheRead: 100,
    cacheWrite: 5,
  });
  assert.deepEqual(tokensFromUsage(null), {
    total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  });
});

test('branchUsagePoints keeps message order and assistant tokens only', () => {
  /** @type {import('@earendil-works/pi-coding-agent').SessionEntry[]} */
  const branch = /** @type {any} */ ([
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-03-27T18:05:00.000Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-03-27T18:05:00.000Z') } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-03-27T18:05:30.000Z', message: { role: 'assistant', content: [], usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 }, timestamp: Date.parse('2026-03-27T18:05:30.000Z') } },
    { type: 'model_change', id: 'm1', parentId: 'a1', timestamp: '2026-03-27T18:06:00.000Z', provider: 'x', modelId: 'y' },
    { type: 'message', id: 'a2', parentId: 'm1', timestamp: '2026-03-27T18:06:10.000Z', message: { role: 'assistant', content: [], usage: { input: 1, output: 2, cacheRead: 9, cacheWrite: 0, totalTokens: 12 }, timestamp: Date.parse('2026-03-27T18:06:10.000Z') } },
  ]);
  const points = branchUsagePoints(branch);
  assert.equal(points.length, 3);
  assert.equal(points[0].entryId, 'u1');
  assert.equal(points[0].tokens.total, 0);
  assert.equal(points[1].tokens.total, 55);
  assert.equal(points[2].tokens.cacheRead, 9);
});

test('bucketUsagePoints groups by local minute and keeps first entry id', () => {
  const points = [
    { entryId: 'u1', role: 'user', atMs: Date.parse('2026-03-27T12:05:10.000Z'), tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { entryId: 'a1', role: 'assistant', atMs: Date.parse('2026-03-27T12:05:40.000Z'), tokens: { total: 20, input: 10, output: 5, cacheRead: 5, cacheWrite: 0 } },
    { entryId: 'a2', role: 'assistant', atMs: Date.parse('2026-03-27T12:06:01.000Z'), tokens: { total: 7, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } },
  ];
  const buckets = bucketUsagePoints(points, 'UTC');
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].key, '2026-03-27T12:05');
  assert.equal(buckets[0].firstEntryId, 'u1');
  assert.deepEqual(buckets[0].entryIds, ['u1', 'a1']);
  assert.equal(buckets[0].turnCount, 2);
  assert.equal(buckets[0].tokens.total, 20);
  assert.equal(buckets[1].firstEntryId, 'a2');
  assert.equal(buckets[1].tokens.total, 7);
});

test('bucketUsagePoints jumps to first export-rendered role, not toolResult/system', () => {
  const points = [
    { entryId: 'sys', role: 'system', atMs: Date.parse('2026-03-27T12:05:00.000Z'), tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { entryId: 'tr', role: 'toolResult', atMs: Date.parse('2026-03-27T12:05:10.000Z'), tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { entryId: 'a1', role: 'assistant', atMs: Date.parse('2026-03-27T12:05:20.000Z'), tokens: { total: 9, input: 4, output: 5, cacheRead: 0, cacheWrite: 0 } },
  ];
  const [bucket] = bucketUsagePoints(points, 'UTC');
  assert.equal(bucket.firstEntryId, 'a1');
  assert.deepEqual(bucket.entryIds, ['sys', 'tr', 'a1']);
});

test('injectTimeline adds sticky chrome once without breaking main content', () => {
  const base = `<!DOCTYPE html><html><head><title>x</title></head><body><main id="content"><div id="messages"></div></main></body></html>`;
  const buckets = [{
    key: '2026-03-27T12:05',
    label: '12:05',
    atMs: Date.parse('2026-03-27T12:05:00.000Z'),
    firstEntryId: 'a1',
    entryIds: ['a1'],
    turnCount: 1,
    tokens: { total: 10, input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
  }];
  const once = injectTimeline(base, buckets);
  assert.match(once, /id="pstack-timeline"/);
  assert.match(once, /id="pstack-timeline-data"/);
  assert.match(once, /id="pstack-timeline-js"/);
  assert.match(once, /entry-a1|firstEntryId":"a1"/);
  assert.match(once, /<main id="content">/);
  const twice = injectTimeline(once, buckets);
  assert.equal(twice.match(/id="pstack-timeline-js"/g)?.length, 1);
});

test('enhanceExportedHtml is a no-op for empty branches', () => {
  const html = '<html><body><main id="content"></main></body></html>';
  assert.equal(enhanceExportedHtml(html, []), html);
});

test('registerExport wires one command', () => {
  /** @type {Map<string, any>} */
  const commands = new Map();
  registerExport(/** @type {any} */ ({
    registerCommand(/** @type {string} */ name, /** @type {any} */ value) { commands.set(name, value); },
  }));
  assert.deepEqual([...commands.keys()], ['pstack-export']);
});

test('pstack-export enhances stock HTML from a session file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-export-'));
  const sessionPath = join(dir, 'session.jsonl');
  const outPath = join(dir, 'out.html');
  const t0 = '2026-03-27T18:05:00.000Z';
  const t1 = '2026-03-27T18:05:20.000Z';
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: t0, cwd: dir }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: t0, message: { role: 'user', content: 'hello', timestamp: Date.parse(t0) } }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: t1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.parse(t1),
      },
    }),
  ];
  await writeFile(sessionPath, `${lines.join('\n')}\n`);

  /** @type {Map<string, any>} */
  const commands = new Map();
  /** @type {Array<{message: string, level: string}>} */
  const notifications = [];
  registerExport(/** @type {any} */ ({
    registerCommand(/** @type {string} */ name, /** @type {any} */ value) { commands.set(name, value); },
  }));
  const command = commands.get('pstack-export');
  await command.handler(outPath, {
    cwd: dir,
    sessionManager: {
      getSessionFile: () => sessionPath,
      getBranch: () => [
        { type: 'message', id: 'u1', parentId: null, timestamp: t0, message: { role: 'user', content: 'hello', timestamp: Date.parse(t0) } },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: t1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 14 },
            timestamp: Date.parse(t1),
          },
        },
      ],
    },
    ui: {
      notify(/** @type {string} */ message, /** @type {string} */ level) { notifications.push({ message, level }); },
    },
  });

  const html = await readFile(outPath, 'utf8');
  assert.match(html, /id="pstack-timeline"/);
  assert.match(html, /id="pstack-timeline-js"/);
  assert.match(html, /"firstEntryId":"u1"/);
  assert.match(html, /id="session-data"/);
  assert.match(html, /entry-"|entry-\"|firstEntryId|pstack-timeline-data/);
  assert.equal(notifications.at(-1)?.level, 'info');
  assert.match(notifications.at(-1)?.message ?? '', /Exported:/);
});
