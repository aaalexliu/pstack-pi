import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSettings, saveSettings, settingsPath } from '../../extensions/shared/settings.ts';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pstack-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('cmux tabs default off and idle compaction on without creating settings', async (t) => {
  const dir = await fixture(t);
  assert.deepEqual(await loadSettings(dir), { version: 1, cmuxTabs: false, idleCompaction: true });
  assert.deepEqual(await readdir(dir), []);
});

test('activation and deactivation persist atomically and preserve other settings', async (t) => {
  const dir = await fixture(t);
  await mkdir(path.dirname(settingsPath(dir)));
  await writeFile(settingsPath(dir), JSON.stringify({ version: 1, other: { keep: true } }));
  await saveSettings(dir, { cmuxTabs: true });
  assert.deepEqual(await loadSettings(dir), { version: 1, cmuxTabs: true, idleCompaction: true, other: { keep: true } });
  assert.equal((await stat(settingsPath(dir))).mode & 0o777, 0o600);
  await saveSettings(dir, { cmuxTabs: false });
  assert.deepEqual(await loadSettings(dir), { version: 1, cmuxTabs: false, idleCompaction: true, other: { keep: true } });
  assert.deepEqual(await readdir(path.dirname(settingsPath(dir))), ['settings.json']);
});

test('invalid settings cannot be silently overwritten', async (t) => {
  const dir = await fixture(t);
  await mkdir(path.dirname(settingsPath(dir)));
  for (const text of ['broken', 'null', '[]', '{}', '{"version":2,"cmuxTabs":true}', '{"version":1,"cmuxTabs":"on"}', '{"version":1,"idleCompaction":0}']) {
    await writeFile(settingsPath(dir), text);
    await assert.rejects(loadSettings(dir), /Invalid/);
    await assert.rejects(saveSettings(dir, { cmuxTabs: true }), /Invalid/);
    assert.equal(await readFile(settingsPath(dir), 'utf8'), text);
  }
});

test('concurrent setting writes always leave a complete document', async (t) => {
  const dir = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, index) => saveSettings(dir, { cmuxTabs: index % 2 === 0 })));
  assert.equal(typeof (await loadSettings(dir)).cmuxTabs, 'boolean');
  assert.deepEqual(await readdir(path.dirname(settingsPath(dir))), ['settings.json']);
});

test('idle compaction round-trips without touching cmux tabs', async (t) => {
  const dir = await fixture(t);
  await saveSettings(dir, { cmuxTabs: true });
  await saveSettings(dir, { idleCompaction: false });
  assert.deepEqual(await loadSettings(dir), { version: 1, cmuxTabs: true, idleCompaction: false });
  await saveSettings(dir, { idleCompaction: true });
  assert.deepEqual(await loadSettings(dir), { version: 1, cmuxTabs: true, idleCompaction: true });
});
