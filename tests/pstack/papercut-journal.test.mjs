import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PapercutJournal } from '../../extensions/pstack/papercut-journal.ts';

/** @type {import('../../extensions/pstack/papercut-model.ts').PapercutRecord} */
const record = {
  version: 1,
  source: 'agent',
  at: '2026-09-14T20:00:00.000Z',
  cwd: '/work/project',
  sessionId: 'session-1',
  kind: 'other',
  note: 'A small but persistent annoyance.',
};

test('stores private per-process journals and reads valid records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const journal = new PapercutJournal(root, 4321);
  const file = await journal.append(record);
  assert.match(file, /papercuts\/session-1\.4321\.jsonl$/u);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'papercuts'))).mode & 0o777, 0o700);
  assert.deepEqual(await journal.readAll(), [record]);
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(record)}\n`);
});

test('serializes concurrent appends and sorts records by time on read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const journal = new PapercutJournal(root, 4321);
  const later = { ...record, at: '2026-09-14T21:00:00.000Z', note: 'later' };
  await Promise.all([journal.append(later), journal.append(record)]);
  assert.deepEqual((await journal.readAll()).map((entry) => entry.note), [record.note, 'later']);
});

test('ignores malformed lines and reports an empty journal before the first write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const journal = new PapercutJournal(root, 4321);
  assert.deepEqual(await journal.readAll(), []);
  await journal.append(record);
  await writeFile(join(root, 'papercuts', 'broken.jsonl'), 'not-json\n{}\n', { mode: 0o600 });
  assert.deepEqual(await journal.readAll(), [record]);
});

test('writes immutable timestamped aggregation snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const journal = new PapercutJournal(root, 4321);
  const file = await journal.writeAggregation({ filename: '2026-09-14T20-30-00Z.md', content: '# Papercut aggregation\n' });
  assert.match(file, /papercut-aggregations\/2026-09-14T20-30-00Z\.md$/u);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), '# Papercut aggregation\n');
  await assert.rejects(journal.writeAggregation({ filename: '2026-09-14T20-30-00Z.md', content: 'replacement' }), /already exists/u);
});
