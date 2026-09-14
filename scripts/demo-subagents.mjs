import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConcurrentProvider } from '../tests/pi/concurrent-provider.mjs';
import { FIXTURE_KEY, FIXTURE_MODEL } from '../tests/pi/provider.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(await realpath(tmpdir()), 'pstack-visibility-demo-'));
const profile = path.join(root, 'profile');
const work = path.join(root, 'work');
const parent = 'Demo: review cancellation and verify the runner. Fixture model responses, real Pi children and tools.';
const tasks = [
  { agent: 'poteto-agent', role: 'review', task: 'Review cancellation cleanup in index.ts.' },
  { agent: 'poteto-agent', role: 'test', task: 'Check the leaf delegation boundary and run a slow verification.' },
];
const slow = process.argv.includes('--quick') ? 5 : 65;
/** @type {import('../tests/pi/concurrent-provider.mjs').ConcurrentRoute[]} */
const routes = [{ marker: parent, steps: [
  { model: FIXTURE_MODEL, reply: process.argv.includes('--overlap')
    ? { kind: 'tools', calls: tasks.map((task, index) => ({ id: `demo-${index}`, name: 'subagent', arguments: task })) }
    : { kind: 'tool', id: 'demo-batch', name: 'subagent', arguments: { tasks } } },
  { model: FIXTURE_MODEL, reply: { kind: 'text', text: 'Demo finished. These were scripted fixture responses, not code-review findings. /subagents inspects the final tasks. /quit exits.' } },
] }, ...tasks.map((task, index) => ({ marker: task.task, steps: [
  { model: index ? 'pi-test-model' : FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('tool'), id: 'plan', name: 'pstack_todo', arguments: { action: 'set', items: ['Read the runner', 'Verify behavior', 'Report findings'] } } },
  { model: index ? 'pi-test-model' : FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('tool'), id: 'read', name: 'read', arguments: { path: 'runner-note.txt' } } },
  { model: index ? 'pi-test-model' : FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('tool'), id: 'read-done', name: 'pstack_todo', arguments: { action: 'complete', item: 'Read the runner' } } },
  { model: index ? 'pi-test-model' : FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('tool'), id: 'wait', name: 'bash', arguments: { command: `sleep ${index ? slow : 8}; printf 'fixture verification finished\\n'` } } },
  { model: index ? 'pi-test-model' : FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('tool'), id: 'verify-done', name: 'pstack_todo', arguments: { action: 'complete', item: 'Verify behavior' } } },
  { model: index ? 'pi-test-model' : FIXTURE_MODEL, reply: { kind: /** @type {const} */ ('text'), text: index ? 'Leaf boundary checked. The slow verification returned.' : 'Cancellation cleanup checked. Ready for the parent review.' } },
] }))];
const provider = await startConcurrentProvider(routes);
try {
  await mkdir(path.join(profile, 'pstack-pi'), { recursive: true });
  await mkdir(work);
  await writeFile(path.join(work, 'runner-note.txt'), 'DEMO FIXTURE: children cannot delegate; the parent stops their process groups.\n');
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ packages: [repository], compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false }));
  await writeFile(path.join(profile, 'models.json'), JSON.stringify({ providers: { 'pi-fixture': { baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: FIXTURE_KEY,
    models: [FIXTURE_MODEL, 'pi-test-model'].map((id) => ({ id, name: id, reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })) } } }));
  await writeFile(path.join(profile, 'pstack-pi/models.json'), JSON.stringify({ version: 1, roles: { review: [`pi-fixture/${FIXTURE_MODEL}`], test: ['pi-fixture/pi-test-model'] } }));
  const child = spawn('pi', ['--no-extensions', '-e', path.join(repository, 'extensions/subagent/index.ts'), '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve', '--offline', '--provider', 'pi-fixture', '--model', FIXTURE_MODEL, '--thinking', 'off', '--', parent], {
    cwd: work, stdio: 'inherit', env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', PI_TELEMETRY: '0', PSTACK_SUBAGENT_DEPTH: '0' },
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { process.off('SIGTERM', stop); process.off('SIGHUP', stop); }
} finally {
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
