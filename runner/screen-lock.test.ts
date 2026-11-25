import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const SCREEN_LOCK = path.join(import.meta.dirname, 'screen-lock');
/** Every process group a test starts, killed at the end so a failed test leaves no orphans. */
const groups = new Set<number>();
after(() => {
  for (const pid of groups) try { process.kill(-pid, 'SIGKILL'); } catch {}
});
const skip = !existsSync('/usr/bin/lockf') && 'screen-lock needs the macOS lockf';

/**
 * A lock file, a log, and a fake caffeinate that logs its flags, so tests never wake the display. It runs the command as its
 * child, so killing screen-lock can leave the command running. The real one keeps the command at screen-lock's pid.
 * A fake ioreg prints the console session the way macOS does, locked while the file `locked` exists in the test folder.
 */
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'screen-lock-'));
  mkdirSync(path.join(dir, 'bin'));
  const log = path.join(dir, 'log');
  writeFileSync(path.join(dir, 'bin', 'caffeinate'), `#!/bin/sh\nflags=$1\nshift 2\necho "caffeinate $flags" >> '${log}'\n"$@"\n`);
  writeFileSync(
    path.join(dir, 'bin', 'ioreg'),
    `#!/bin/sh\n[ -e '${dir}/locked' ] && state=Yes || state=No\n` +
      `echo '  | "IOConsoleLocked" = No'\n` +
      `echo '  | "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"='$state',"kCGSSessionUserNameKey"="alexliu"})'\n`,
  );
  for (const tool of ['caffeinate', 'ioreg']) chmodSync(path.join(dir, 'bin', tool), 0o755);
  const lockConsole = () => writeFileSync(path.join(dir, 'locked'), '');
  const env = { ...process.env, SCREEN_LOCK: path.join(dir, 'screen.lock'), PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` };
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  /** Starts `screen-lock` in its own process group; `done` resolves with its exit code and stderr, or kills the group and rejects after 15 s. */
  const run = (...args: string[]) => {
    const child = spawn(SCREEN_LOCK, args, { env, cwd: dir, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    groups.add(child.pid!);
    const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
        reject(new Error(`screen-lock ${args.join(' ')} did not finish in 15 s`));
      }, 15_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
    return { child, done, stderr: () => stderr };
  };
  const step = (key: string, body: string) => run('run', key, '--', 'sh', '-c', `echo "${key} start" >> "$0"; ${body}; echo "${key} end" >> "$0"`, log);
  return { lines, run, step, lockConsole, lock: env.SCREEN_LOCK };
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

test('a killed command does not block the next run', { skip }, async () => {
  const t = setup();
  // exec, so no fork races the group kill and leaves a sleep holding the screen.
  const first = t.step('ALE-1', 'exec sleep 30');
  await until(() => t.lines().includes('ALE-1 start'));
  process.kill(-first.child.pid!, 'SIGKILL');
  await first.done;
  const started = Date.now();
  assert.equal((await t.step('ALE-2', 'true').done).code, 0);
  assert.ok(Date.now() - started < 2000, 'the next run did not wait for the killed holder');
  assert.deepEqual(t.lines().slice(-2), ['ALE-2 start', 'ALE-2 end']);
});

for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
  test(`after a ${signal} to screen-lock alone, the screen stays held until its command ends, so two never overlap`, { skip }, async () => {
    const t = setup();
    const first = t.step('ALE-1', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "ALE-1 tick" >> "$0"; sleep 0.1; done');
    await until(() => t.lines().includes('ALE-1 tick'));
    first.child.kill(signal);
    const second = await t.step('ALE-2', 'true').done;
    assert.equal(second.code, 0);
    const log = t.lines().filter((line) => !line.startsWith('caffeinate'));
    assert.equal(log.indexOf('ALE-1 end'), log.indexOf('ALE-2 start') - 1, log.join('\n'));
    assert.equal(log.filter((line) => line === 'ALE-1 tick').length, 10);
  });
}

test('a locked console refuses the run at once with one line, and an unlocked one runs the command', { skip }, async () => {
  const t = setup();
  t.lockConsole();
  const started = Date.now();
  const locked = await t.step('ALE-1', 'true').done;
  assert.ok(Date.now() - started < 1000, 'the locked run took a second or more');
  assert.notEqual(locked.code, 0);
  assert.match(locked.stderr, /^screen-lock: ALE-1 can't use the screen: this Mac is locked at the password prompt\. Ask Alex to unlock it\.\n$/);
  assert.deepEqual(t.lines(), [], 'the command and caffeinate never ran');
  const unlocked = setup();
  assert.equal((await unlocked.step('ALE-2', 'true').done).code, 0);
  assert.deepEqual(unlocked.lines(), ['caffeinate -du', 'ALE-2 start', 'ALE-2 end']);
});

test('a run that waits checks the console when it gets the screen', { skip }, async () => {
  const t = setup();
  const first = t.step('ALE-1', 'sleep 1');
  await until(() => t.lines().includes('ALE-1 start'));
  const second = t.step('ALE-2', 'true');
  await until(() => second.stderr().includes('waits for the screen'));
  t.lockConsole();
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.code, 0);
  assert.notEqual(b.code, 0);
  assert.match(b.stderr, /ALE-2 can't use the screen: this Mac is locked/);
  assert.ok(!t.lines().includes('ALE-2 start'));
});

test('the command exit code comes back, and a malformed call prints usage', { skip }, async () => {
  const t = setup();
  assert.equal((await t.run('run', 'ALE-1', '--', 'sh', '-c', 'exit 3').done).code, 3);
  const bad = await t.run('ALE-1', 'true').done;
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /^usage: screen-lock run KEY -- <command>/);
});
