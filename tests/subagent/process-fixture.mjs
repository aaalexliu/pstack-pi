import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const mode = process.argv[2];
if (mode === 'unobserved') {
  process.on('SIGTERM', () => {});
  writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, descendants: [] }));
  setInterval(() => {}, 1000);
} else if (mode === 'descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const promptFile = process.argv[process.argv.indexOf('--system-prompt') + 1];
  /** @type {number[]} */
  const descendants = [];
  if (['orphan', 'detached', 'pipes', 'term-spawn'].includes(mode)) {
    const makeChild = () => {
      const child = spawn(process.execPath, [process.argv[1], 'descendant'], { detached: mode !== 'orphan', stdio: mode === 'pipes' ? 'inherit' : 'ignore' });
      if (child.pid === undefined) throw new Error('Descendant failed to spawn');
      descendants.push(child.pid);
      child.unref();
      writeFileSync(input, JSON.stringify({ pid: process.pid, descendants, promptFile }));
    };
    if (mode === 'term-spawn') process.on('SIGTERM', makeChild);
    else makeChild();
  }
  if (mode === 'ignore' || mode === 'malformed-wait') process.on('SIGTERM', () => {});
  writeFileSync(input, JSON.stringify({ pid: process.pid, descendants, promptFile, depth: process.env.PSTACK_SUBAGENT_DEPTH, stale: process.env.PSTACK_RECURSION_TEST_CONFIG }));
  if (mode === 'malformed-wait') process.stdout.write('PRIVATE_TRANSCRIPT_NOT_JSON\n');
  if (['orphan', 'detached', 'pipes'].includes(mode)) {
    setTimeout(() => {
      const message = { role: 'assistant', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', provider: 'fixture', model: 'model', content: [{ type: 'text', text: 'must not succeed' }] };
      process.stdout.write(JSON.stringify({ type: 'message_start', message }) + '\n' + JSON.stringify({ type: 'message_end', message }) + '\n{"type":"agent_settled"}\n');
      process.exit(0);
    }, 250);
  } else setInterval(() => {}, 1000);
}
