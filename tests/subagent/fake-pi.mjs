// Stands in for `pi --mode json -p`: reads the task from stdin and answers with message_end events.
// The task text selects the behavior so tests can drive success, failure, hangs, and slow replies.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const promptFile = flag('--append-system-prompt');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : '';
const promptMode = promptFile ? lstatSync(promptFile).mode & 0o777 : null;

/** @type {Buffer[]} */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const task = Buffer.concat(chunks).toString('utf8');
const [verb, ...rest] = task.split(' ');

/** @param {string} text @param {Record<string, unknown>} [extra] */
function assistant(text, extra = {}) {
  const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
  const model = flag('--model') ?? 'fixture/model';
  const slash = model.indexOf('/');
  const message = { role: 'assistant', timestamp: Date.now(), provider: model.slice(0, slash), model: model.slice(slash + 1), stopReason: 'stop', usage, content: [{ type: 'text', text }], ...extra };
  process.stdout.write(`${JSON.stringify({ type: 'message_start', message })}\n${JSON.stringify({ type: 'message_end', message })}\n`);
}

const capture = () => JSON.stringify({ args, task, prompt, promptMode, cwd: process.cwd(), depth: process.env.PSTACK_SUBAGENT_DEPTH ?? null, pid: process.pid });
const parentPid = process.ppid;
const loopMs = Number(process.env.FAKE_PI_LOOP_MS) || 15_000;
const parentGone = () => { try { process.kill(parentPid, 0); return false; } catch { return true; } };
/** @param {string} file @param {number} ms */
async function waitForPath(file, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    if (parentGone()) return false;
    await delay(10);
  }
  return false;
}

if (verb === 'FAIL') {
  assistant('partial answer', { stopReason: 'error', errorMessage: 'PRIVATE_BOOM' });
} else if (verb === 'EXIT2') {
  process.stderr.write('child exploded\n');
  process.exitCode = 2;
} else if (verb === 'SLOW') {
  const [ms, log] = rest;
  if (log) appendFileSync(log, `start ${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(ms)));
  if (log) appendFileSync(log, `end ${Date.now()}\n`);
  assistant(capture());
} else if (verb === 'WAIT') {
  const [ready, release] = rest;
  writeFileSync(ready, JSON.stringify({ pid: process.pid }));
  if (!await waitForPath(release, loopMs)) process.exit(1);
  assistant(capture());
} else if (verb === 'HANG' || verb === 'HANG-IGNORE') {
  const [file] = rest;
  const grandchildReady = `${file}.grandchild-ready`;
  const ignore = verb === 'HANG-IGNORE' ? "process.on('SIGTERM', () => {});" : '';
  const grandchild = spawn(process.execPath, ['-e', `${ignore} require('fs').writeFileSync(${JSON.stringify(grandchildReady)}, 'ready'); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  const reap = () => {
    if (grandchild.pid === undefined) return;
    try { process.kill(grandchild.pid, 'SIGKILL'); } catch { /* already gone */ }
  };
  process.on('exit', reap);
  if (!await waitForPath(grandchildReady, loopMs)) {
    reap();
    process.exit(1);
  }
  if (verb === 'HANG-IGNORE') process.on('SIGTERM', () => {});
  writeFileSync(file, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, pgid: process.pid }));
  assistant('still working', { stopReason: 'toolUse' });
  setInterval(() => {}, 1000);
} else {
  assistant(capture());
}
