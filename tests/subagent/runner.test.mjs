import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PiInvocation, processBackend } from '../../extensions/subagent/process.ts';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseAgent } from '../../extensions/subagent/agents.ts';
import { boundedOutput, childArguments, childOutputParser, resolveCwd, runChild } from '../../extensions/subagent/runner.ts';

const fixturePath = fileURLToPath(new URL('./child-fixture.mjs', import.meta.url));
const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
/** @param {string} mode */
function child(mode) {
  return { invocation, backend: { ...processBackend, spawn: (/** @type {PiInvocation} */ _invocation, /** @type {string[]} */ args, /** @type {import('node:child_process').SpawnOptionsWithoutStdio} */ options) => spawn(process.execPath, [fixturePath, mode, ...args], options) } };
}
const agent = { ...parseAgent('---\nname: test\ndescription: Test.\ntools: [read, grep, find, ls]\n---\nDo not delegate.'), provenance: { kind: /** @type {const} */ ('bundled'), path: '/fixture/test.md', sha256: 'a'.repeat(64) } };
const model = { provider: 'fixture', id: 'model', thinkingLevel: 'off' };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await resolveCwd({ current: root });
  return { root, identity: { id: 'test-call', agent: { name: agent.name, provenance: agent.provenance }, cwd } };
}

test('cwd defaults to canonical current directory and rejects other or symlinked paths', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'child'));
  await writeFile(path.join(f.root, 'file'), 'x');
  await symlink(f.root, path.join(f.root, 'link'));
  for (const supplied of [undefined, '.', f.root, './child/..']) assert.equal(await resolveCwd({ current: f.root, supplied }), f.root);
  for (const supplied of ['child', '..', '/', 'missing', 'missing/..', 'file', 'file/..', 'link', './link/..', path.join(f.root, 'link'), '']) {
    await assert.rejects(resolveCwd({ current: f.root, supplied }), supplied);
  }
});

test('child argv always isolates resources, qualifies the model, and specifies tools', () => {
  const args = childArguments({ agent, model, promptFile: '/tmp/prompt' });
  for (const flag of ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline', '--print']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--model') + 1], 'fixture/model');
  assert.equal(args[args.indexOf('--thinking') + 1], 'off');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], '');
  const none = childArguments({ agent: { ...agent, tools: [] }, model, promptFile: '/tmp/prompt' });
  assert.ok(none.includes('--no-tools') && !none.includes('--tools'));
  assert.ok(!childArguments({ agent, model: { ...model, thinkingLevel: undefined }, promptFile: 'p' }).includes('--thinking'));
  assert.throws(() => childArguments({ agent, model: { ...model, provider: '' }, promptFile: 'p' }));
});

test('separate child gets the exact task through stdin and a private prompt that is removed on close', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const task = '@not-a-file\n--tools bash\nUnicode ✓\u2028inside';
  const result = await runChild({ ...f, agent, model, task, signal: controller.signal, ...child('success') });
  assert.equal(result.kind, 'succeeded');
  assert.equal(result.usage, null);
  assert.deepEqual(result.diagnostics, []);
  const capture = JSON.parse(result.output.text);
  assert.equal(capture.task, task);
  assert.equal(capture.prompt, agent.systemPrompt);
  assert.equal(capture.cwd, f.root);
  assert.throws(() => process.kill(capture.pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(capture.promptFile), { code: 'ENOENT' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const mode of ['malformed', 'no-lf', 'line', 'stderr', 'count', 'stdout', 'invalid-utf8', 'error', 'aborted', 'length', 'toolUse', 'no-final', 'no-settled', 'wrong-model', 'exit']) {
  test(`child failure ${mode} cannot become success`, async (t) => {
    const f = await fixture(t);
    const result = await runChild({ ...f, agent, model, task: 'task', signal: undefined, ...child(mode) });
    assert.equal(result.kind, 'failed');
    assert.equal(result.usage, null);
    assert.ok(Buffer.byteLength(result.output.text) <= 32768);
    assert.ok(result.diagnostics.every((text) => Buffer.byteLength(text) <= 4096));
  });
}

test('output truncation preserves UTF-8 and does not retain a hidden full copy', async (t) => {
  const f = await fixture(t);
  const result = await runChild({ ...f, agent, model, task: 'task', signal: undefined, ...child('large-output') });
  assert.equal(result.kind, 'succeeded');
  assert.equal(result.output.bytes, 60000);
  assert.equal(result.output.truncated, true);
  assert.ok(!result.output.text.includes('�'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 34000);
  assert.deepEqual(boundedOutput('✓✓', 4), { text: '✓', bytes: 6, truncated: true });
});

test('execution abort stops and awaits the immediate child, removes prompt and listener', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'started.json');
  const controller = new AbortController();
  const promise = runChild({ ...f, agent, model, task: marker, signal: controller.signal, ...child('wait') });
  let capture;
  for (let tries = 0; tries < 100; tries++) {
    try { capture = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await delay(20); }
  }
  controller.abort();
  const result = await promise;
  assert.ok(capture, 'Child did not start');
  assert.equal(result.kind, 'cancelled');
  assert.throws(() => process.kill(capture.pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(capture.promptFile), { code: 'ENOENT' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pre-abort and spawn errors leave no temporary prompts', async (t) => {
  const f = await fixture(t);
  const before = (await readdir(tmpdir())).filter((name) => name.startsWith('pstack-subagent-')).sort();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runChild({ ...f, agent, model, task: '', signal: controller.signal })).kind, 'cancelled');
  const result = await runChild({ ...f, agent, model, task: '', signal: undefined, invocation, backend: { ...processBackend, spawn: () => spawn('/nonexistent-pi', [], { stdio: 'pipe' }) } });
  assert.equal(result.kind, 'failed');
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('pstack-subagent-')).sort(), before);
});

test('JSONL accepts split UTF-8 and LF framing but rejects malformed authoritative messages', () => {
  const parser = childOutputParser();
  const text = '✓\u2028and\u2029';
  const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', provider: 'p', model: 'm', content: [{ type: 'text', text }] } }) + '\n{"type":"agent_settled"}\n');
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  assert.deepEqual(parser.end().content, [{ type: 'text', text }]);
  for (const event of [[], {}, { type: 'made-up' }, { type: 'message_end' }, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }]) {
    assert.throws(() => childOutputParser().write(Buffer.from(JSON.stringify(event) + '\n')));
  }
});
