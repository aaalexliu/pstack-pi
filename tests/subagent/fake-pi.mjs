// Stands in for `pi --mode json -p`: reads the task from stdin and answers with message_end events.
// The task text selects the behavior so tests can drive success, failure, hangs, and slow replies.
import { spawn } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';

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
} else if (verb === 'HANG' || verb === 'HANG-IGNORE') {
  const [file] = rest;
  const ignore = verb === 'HANG-IGNORE' ? "process.on('SIGTERM', () => {});" : '';
  const grandchild = spawn(process.execPath, ['-e', `${ignore} setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  if (verb === 'HANG-IGNORE') process.on('SIGTERM', () => {});
  writeFileSync(file, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, pgid: process.pid }));
  assistant('still working', { stopReason: 'toolUse' });
  setInterval(() => {}, 1000);
} else {
  assistant(capture());
}
