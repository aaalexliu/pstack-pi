import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCREEN_LOCK = path.join(import.meta.dirname, 'screen-lock');
const skip = !existsSync('/usr/bin/lockf') && 'screen-lock needs the macOS lockf';

/** A lock file, a log, and a fake caffeinate that logs its flags and runs the command, so tests never wake the display. */
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'screen-lock-'));
  mkdirSync(path.join(dir, 'bin'));
  const log = path.join(dir, 'log');
  writeFileSync(path.join(dir, 'bin', 'caffeinate'), `#!/bin/sh\nflags=$1\nshift 2\necho "caffeinate $flags" >> '${log}'\nexec "$@"\n`);
  chmodSync(path.join(dir, 'bin', 'caffeinate'), 0o755);
  const env = { ...process.env, SCREEN_LOCK: path.join(dir, 'screen.lock'), PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` };
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  /** Starts `screen-lock` in its own process group; `done` resolves with its exit code and stderr. */
  const run = (...args: string[]) => {
    const child = spawn(SCREEN_LOCK, args, { env, cwd: dir, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stderr })));
    return { child, done };
  };
  const step = (key: string, body: string) => run('run', key, '--', 'sh', '-c', `echo "${key} start" >> '${log}'; ${body}; echo "${key} end" >> '${log}'`);
  return { lines, run, step, lock: env.SCREEN_LOCK };
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('two concurrent runs take turns, and the second says who holds the screen', { skip }, async () => {
  const t = setup();
  const first = t.step('ALE-1', 'sleep 1');
  await until(() => t.lines().includes('ALE-1 start'));
  assert.match(readFileSync(t.lock, 'utf8'), /^ALE-1 since \d+:\d\d [AP]M \w+\n$/);
  const second = t.step('ALE-2', 'true');
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.deepEqual([a.code, b.code], [0, 0]);
  assert.deepEqual(t.lines(), ['caffeinate -du', 'ALE-1 start', 'ALE-1 end', 'caffeinate -du', 'ALE-2 start', 'ALE-2 end']);
  assert.match(b.stderr, /^screen-lock: ALE-2 waits for the screen, held by ALE-1 since /);
  assert.equal(a.stderr, '', 'a free screen starts at once, with no message');
});

test('a killed holder does not block the next run', { skip }, async () => {
  const t = setup();
  const first = t.step('ALE-1', 'sleep 30');
  await until(() => t.lines().includes('ALE-1 start'));
  process.kill(first.child.pid!, 'SIGKILL');
  const started = Date.now();
  const second = t.step('ALE-2', 'true');
  assert.equal((await second.done).code, 0);
  assert.ok(Date.now() - started < 2000, 'the next run did not wait for the killed holder');
  assert.ok(t.lines().includes('ALE-2 end'));
  process.kill(-first.child.pid!, 'SIGKILL');
});

test('the command exit code comes back, and a malformed call prints usage', { skip }, async () => {
  const t = setup();
  assert.equal((await t.run('run', 'ALE-1', '--', 'sh', '-c', 'exit 3').done).code, 3);
  const bad = await t.run('ALE-1', 'true').done;
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /^usage: screen-lock run KEY -- <command>/);
});
