import assert from 'node:assert/strict';
import { stat, readFile, writeFile, access } from 'node:fs/promises';
import test from 'node:test';
import { WatchFile } from '../../extensions/subagent/view.ts';
import { RunProgress } from '../../extensions/subagent/progress.ts';
import { clip, readSnapshot } from '../../extensions/subagent/watch.mjs';

test('watch files isolate sessions, write private atomic snapshots, and remove on close', async () => {
  const a = await WatchFile.open();
  const b = await WatchFile.open();
  const run = new RunProgress([{ agent: 'general-purpose', task: 'Inspect' }], (snapshot) => { a.publish(snapshot); b.publish(snapshot); });
  try {
    run.started(0);
    run.finish();
    await Promise.all([a.flush(), b.flush()]);
    assert.notEqual(a.filename, b.filename);
    assert.equal((await stat(a.filename)).mode & 0o777, 0o600);
    assert.equal((await stat(new URL('.', `file://${a.filename}`).pathname)).mode & 0o777, 0o700);
    const snapshot = await readSnapshot(a.filename);
    assert.equal(snapshot.parentPid, process.pid);
    assert.ok(snapshot.endedAt);
    assert.ok(snapshot.lines.some((line) => line.includes('Inspect')));
    assert.equal(JSON.parse(await readFile(a.filename, 'utf8')).tasks.length, 1);
    await a.close();
    await assert.rejects(access(a.filename), { code: 'ENOENT' });
    await access(b.filename);
  } finally { run.finish(); await a.close(); await b.close(); }
});
test('watch reader rejects oversized and malformed files; display strips controls and fits narrow panes', async () => {
  const file = await WatchFile.open();
  try {
    await writeFile(file.filename, 'x'.repeat(128 * 1024 + 1));
    await assert.rejects(readSnapshot(file.filename), /Invalid/);
    await writeFile(file.filename, JSON.stringify({ version: 1, parentPid: -1, lines: [] }));
    await assert.rejects(readSnapshot(file.filename), /Invalid/);
    assert.equal(clip('\x1b[31mhello\nworld', 5), 'hello');
    assert.equal(clip('你好你好', 4), '你好');
    assert.equal(clip('long line', 0), '');
  } finally { await file.close(); }
});
