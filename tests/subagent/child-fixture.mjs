import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';

const [mode, ...args] = process.argv.slice(2);
const promptFile = args[args.indexOf('--system-prompt') + 1];
assert.equal((await lstat(promptFile)).mode & 0o777, 0o600);
const prompt = await readFile(promptFile, 'utf8');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const task = Buffer.concat(chunks).toString('utf8');
if (mode === 'wait') {
  await writeFile(task, JSON.stringify({ pid: process.pid, promptFile }));
  setInterval(() => {}, 1000);
} else if (mode === 'malformed') process.stdout.write('not JSON\n');
else if (mode === 'no-lf') process.stdout.write('{"type":"agent_start"}');
else if (mode === 'line') process.stdout.write('x'.repeat(256 * 1024 + 1));
else if (mode === 'stderr') process.stderr.write('x'.repeat(64 * 1024 + 1));
else if (mode === 'count') process.stdout.write('{"type":"agent_start"}\n'.repeat(4097));
else if (mode === 'stdout') process.stdout.write((' {"type":"agent_start"}' + ' '.repeat(16000) + '\n').repeat(600));
else if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([255]));
else {
  const stopReason = ['error', 'aborted', 'length', 'toolUse'].includes(mode) ? mode : 'stop';
  const text = mode === 'large-output' ? '✓'.repeat(20000) : JSON.stringify({ args, prompt, task, cwd: process.cwd(), pid: process.pid, promptFile });
  const message = { role: 'assistant', stopReason, content: [{ type: 'text', text }], provider: 'fixture', model: mode === 'wrong-model' ? 'wrong' : 'model' };
  if (mode !== 'no-final') process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\n');
  if (mode !== 'no-settled') process.stdout.write('{"type":"agent_settled"}\n');
  if (mode === 'exit') process.exitCode = 2;
}
