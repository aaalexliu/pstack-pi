import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import subagentExtension, { DEPTH_VARIABLE, MAX_CONCURRENCY, TERM_GRACE_MS, childEnvironment, parentDepth } from '../../extensions/subagent/index.ts';
import { roles } from '../../extensions/subagent/model-config.ts';

const fakePi = fileURLToPath(new URL('./fake-pi.mjs', import.meta.url));

/** @typedef {import('../../extensions/subagent/index.ts').SubagentDetails} SubagentDetails */
/** @typedef {{content: {type: string, text: string}[], details: SubagentDetails}} ToolResult */

/** Runs fake-pi with the flags the extension composed, in the process group the extension expects. */
/** @type {import('../../extensions/subagent/index.ts').SpawnChild} */
const spawnFake = (invocation, { cwd, env }) => {
  const args = invocation.args.slice(invocation.args.indexOf('--mode'));
  return spawn(process.execPath, [fakePi, ...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
};

/** @param {Parameters<typeof subagentExtension>[1]} [options] */
function registration(options = {}) {
  /** @type {any[]} */
  const tools = [];
  /** @type {Map<string, (...args: any[]) => any>} */
  const handlers = new Map();
  const api = {
    registerTool: (/** @type {any} */ tool) => tools.push(tool),
    registerCommand: (/** @type {string} */ name) => assert.equal(name, 'subagents'),
    on: (/** @type {string} */ event, /** @type {(...args: any[]) => any} */ handler) => { assert.ok(!handlers.has(event), `duplicate ${event} handler`); handlers.set(event, handler); },
  };
  subagentExtension(/** @type {any} */ (api), { spawnChild: spawnFake, env: {}, ...options });
  return { tools, handlers };
}

/** @param {import('node:test').TestContext} t @param {Parameters<typeof subagentExtension>[1]} [options] */
async function fixture(t, options) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'subagent-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'work');
  await mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await mkdir(cwd);
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, tmpdir: process.env.TMPDIR, depth: process.env[DEPTH_VARIABLE] };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMPDIR = root;
  delete process.env[DEPTH_VARIABLE];
  t.after(async () => {
    for (const [key, value] of /** @type {[string, string | undefined][]} */ ([['PI_CODING_AGENT_DIR', previous.agentDir], ['TMPDIR', previous.tmpdir], [DEPTH_VARIABLE, previous.depth]])) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const { tools, handlers } = registration(options);
  assert.equal(tools.length, 1);
  const ctx = /** @type {any} */ ({ cwd, model: { provider: 'fixture', id: 'model' }, thinkingLevel: 'high', hasUI: false, isProjectTrusted: () => false, ui: { confirm: async () => false } });
  /** @type {(params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: ToolResult) => void) => Promise<ToolResult>} */
  const execute = (params, signal, onUpdate) => tools[0].execute('call', params, signal, onUpdate, ctx);
  /** @param {ToolResult} result @param {boolean} [isError] */
  const resultHook = (result, isError = false) => handlers.get('tool_result')?.({ type: 'tool_result', toolName: 'subagent', toolCallId: 'call', input: {}, content: result.content, details: result.details, isError });
  const promptDirs = async () => (await readdir(root)).filter((name) => name.startsWith('pi-subagent-'));
  return { root, agentDir, cwd, tool: tools[0], handlers, ctx, execute, resultHook, promptDirs };
}

/** @param {string} file @returns {Promise<{pid: number, grandchild: number}>} */
async function waitFor(file) {
  for (let tries = 0; tries < 200; tries++) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { await delay(25); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** @param {number[]} pids @param {number} ms */
async function untilGone(pids, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(alive)) await delay(25);
  return pids.filter(alive);
}

test('depth guard: a child Pi registers nothing, the root registers the tool and both hooks', () => {
  assert.equal(parentDepth({}), 0);
  assert.equal(parentDepth({ [DEPTH_VARIABLE]: '1' }), 1);
  assert.ok(parentDepth({ [DEPTH_VARIABLE]: 'garbage' }) >= 1, 'Unreadable depth disables delegation');
  assert.equal(childEnvironment(0, { PATH: '/bin' })[DEPTH_VARIABLE], '1');
  for (const depth of ['1', '01', '7', 'x']) assert.deepEqual(registration({ env: { [DEPTH_VARIABLE]: depth } }).tools, []);
  const { tools, handlers } = registration({ env: {} });
  assert.equal(tools[0].name, 'subagent');
  assert.deepEqual([...handlers.keys()].sort(), ['session_shutdown', 'tool_result']);
  for (const text of ['comment-sicko', 'general-purpose', 'poteto-agent', 'inherit-parent', roles[0], 'Children cannot delegate']) assert.ok(tools[0].description.includes(text), text);
});

test('single mode runs the bundled agent in a detached child with prompt file, stdin task, depth, and parent model', async (t) => {
  const f = await fixture(t);
  const task = 'Summarize @file with --flags and unicode ✓';
  /** @type {ToolResult[]} */
  const updates = [];
  const result = await f.execute({ agent: 'general-purpose', task }, undefined, (partial) => { updates.push(partial); });
  const details = result.details;
  assert.equal(details.mode, 'single');
  assert.equal(details.results[0].exitCode, 0);
  assert.equal(details.results[0].agentSource, 'bundled');
  assert.equal(details.results[0].modelSource, 'parent');
  assert.equal(details.results[0].model, 'fixture/model');
  assert.equal(details.results[0].usage.turns, 1);
  assert.equal(details.results[0].usage.input, 11);
  const capture = JSON.parse(result.content[0].text);
  assert.equal(capture.task, task);
  assert.equal(capture.depth, '1');
  assert.equal(capture.cwd, f.cwd);
  assert.equal(capture.promptMode, 0o600);
  assert.equal(capture.prompt, (await readFile(new URL('../../agents/general-purpose.md', import.meta.url), 'utf8')).split('---\n')[2].trim());
  assert.deepEqual(capture.args.slice(0, 4), ['--mode', 'json', '-p', '--no-session']);
  assert.ok(capture.args.includes('--model') && capture.args[capture.args.indexOf('--model') + 1] === 'fixture/model');
  assert.equal(capture.args[capture.args.indexOf('--thinking') + 1], 'high');
  assert.equal(capture.args[capture.args.indexOf('--tools') + 1], 'read,grep,find,ls,pstack_todo');
  assert.ok(!capture.args.includes(task), 'The task travels over stdin, not argv');
  assert.ok(updates.length >= 1 && updates[updates.length - 1].details.results[0].messages.length === 1);
  assert.deepEqual(await f.promptDirs(), [], 'Prompt temp directory is removed');
  assert.equal(f.resultHook(result), undefined);
});

test('model routing: explicit beats role beats agent default beats parent, and pinned models skip parent thinking', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.agentDir, 'pstack-pi'));
  await writeFile(path.join(f.agentDir, 'pstack-pi', 'models.json'), JSON.stringify({ version: 1, roles: { feature: ['pool/one', 'pool/two'], review: 'inherit-parent' } }));
  await writeFile(path.join(f.agentDir, 'agents', 'custom.md'), '---\nname: custom\ndescription: Custom.\nmodel: agent/default\ntools: bash\n---\nCustom prompt.\n');
  /** @param {Record<string, unknown>} params */
  const modelOf = async (params) => {
    const result = await f.execute(params);
    const capture = JSON.parse(result.content[0].text);
    return { model: capture.args[capture.args.indexOf('--model') + 1], thinking: capture.args.includes('--thinking') ? capture.args[capture.args.indexOf('--thinking') + 1] : null, source: result.details.results[0].modelSource };
  };
  assert.deepEqual(await modelOf({ agent: 'custom', task: 'x', model: 'explicit/win', role: 'feature' }), { model: 'explicit/win', thinking: null, source: 'explicit' });
  assert.deepEqual(await modelOf({ agent: 'custom', task: 'x', role: 'feature' }), { model: 'pool/one', thinking: null, source: 'role' });
  assert.deepEqual(await modelOf({ agent: 'general-purpose', task: 'x', role: 'feature' }), { model: 'pool/two', thinking: null, source: 'role' });
  assert.deepEqual(await modelOf({ agent: 'custom', task: 'x', role: 'review' }), { model: 'fixture/model', thinking: 'high', source: 'role' });
  assert.deepEqual(await modelOf({ agent: 'custom', task: 'x' }), { model: 'agent/default', thinking: null, source: 'agent' });
  assert.deepEqual(await modelOf({ agent: 'general-purpose', task: 'x' }), { model: 'fixture/model', thinking: 'high', source: 'parent' });
  await writeFile(path.join(f.agentDir, 'pstack-pi', 'models.json'), '{"version":1,"roles":{"feature":"broken"}}');
  await assert.rejects(f.execute({ agent: 'general-purpose', task: 'x' }), /Invalid pstack-pi\/models.json/);
});

test('unknown agents, mixed modes, and too many tasks return guidance without spawning', async (t) => {
  const f = await fixture(t);
  const unknown = await f.execute({ agent: 'nope', task: 'x' });
  assert.match(unknown.content[0].text, /Unknown agent "nope".*general-purpose \(bundled\)/);
  assert.deepEqual(unknown.details.results, []);
  assert.match((await f.execute({ agent: 'general-purpose', task: 'x', tasks: [{ agent: 'general-purpose', task: 'y' }] })).content[0].text, /exactly one mode/);
  assert.match((await f.execute({ tasks: Array.from({ length: 9 }, () => ({ agent: 'general-purpose', task: 'y' })) })).content[0].text, /Too many parallel tasks \(9\)/);
  assert.equal(f.resultHook(unknown), undefined);
});

test('parallel mode keeps input order, caps concurrency, and reports one failure without failing the call', async (t) => {
  const f = await fixture(t);
  const log = path.join(f.root, 'overlap.log');
  const tasks = [
    { agent: 'general-purpose', task: `SLOW 300 ${log}` }, { agent: 'general-purpose', task: `SLOW 100 ${log}` }, { agent: 'poteto-agent', task: 'FAIL now' },
    { agent: 'general-purpose', task: `SLOW 50 ${log}` }, { agent: 'general-purpose', task: `SLOW 200 ${log}` }, { agent: 'general-purpose', task: `SLOW 20 ${log}` },
  ];
  const result = await f.execute({ tasks });
  assert.equal(result.details.mode, 'parallel');
  assert.deepEqual(result.details.results.map((r) => r.task), tasks.map((task) => task.task));
  assert.deepEqual(result.details.results.map((r) => r.exitCode), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.details.results.map((r) => r.stopReason), ['stop', 'stop', 'error', 'stop', 'stop', 'stop']);
  assert.match(result.content[0].text, /^Parallel: 5\/6 succeeded/);
  assert.match(result.content[0].text, /### \[poteto-agent\] failed \(error\)\n\nPRIVATE_BOOM/);
  const events = (await readFile(log, 'utf8')).trim().split('\n').map((line) => line.split(' '));
  let live = 0; let peak = 0;
  for (const [kind] of events.sort((a, b) => Number(a[1]) - Number(b[1]))) { live += kind === 'start' ? 1 : -1; peak = Math.max(peak, live); }
  assert.ok(peak <= MAX_CONCURRENCY && peak >= 2, `peak concurrency ${peak}`);
  assert.equal(f.resultHook(result), undefined, 'A partial failure is not an error result');
  const allFailed = await f.execute({ tasks: [{ agent: 'general-purpose', task: 'FAIL a' }, { agent: 'general-purpose', task: 'EXIT2 b' }] });
  assert.deepEqual(f.resultHook(allFailed), { isError: true });
  assert.match(allFailed.content[0].text, /\[general-purpose\] failed\n\nchild exploded/);
});

test('chain mode substitutes {previous} and stops at the first failed step', async (t) => {
  const f = await fixture(t);
  const ok = await f.execute({ chain: [{ agent: 'general-purpose', task: 'first' }, { agent: 'general-purpose', task: 'second after {previous}' }] });
  assert.equal(ok.details.mode, 'chain');
  assert.deepEqual(ok.details.results.map((r) => r.step), [1, 2]);
  const second = JSON.parse(ok.content[0].text);
  assert.ok(second.task.startsWith('second after {"args"'), second.task.slice(0, 40));
  const stopped = await f.execute({ chain: [{ agent: 'general-purpose', task: 'FAIL early' }, { agent: 'general-purpose', task: 'never {previous}' }] });
  assert.equal(stopped.details.results.length, 1);
  assert.match(stopped.content[0].text, /Chain stopped at step 1 \(general-purpose\): PRIVATE_BOOM/);
  assert.deepEqual(f.resultHook(stopped), { isError: true });
  assert.equal(f.resultHook(stopped, true), undefined, 'An already failed event is left alone');
});

test('a failed single result is an error result and a spawn failure is reported', async (t) => {
  const f = await fixture(t);
  const failed = await f.execute({ agent: 'general-purpose', task: 'FAIL x' });
  assert.match(failed.content[0].text, /^Agent error: PRIVATE_BOOM/);
  assert.deepEqual(f.resultHook(failed), { isError: true });
  const exited = await f.execute({ agent: 'general-purpose', task: 'EXIT2 x' });
  assert.equal(exited.details.results[0].exitCode, 2);
  assert.match(exited.content[0].text, /child exploded/);
  const { tools } = registration({ spawnChild: () => spawn('/nonexistent/pi', [], { stdio: 'pipe' }) });
  const broken = await tools[0].execute('call', { agent: 'general-purpose', task: 'x' }, undefined, undefined, f.ctx);
  assert.equal(broken.details.results[0].exitCode, 1);
  assert.match(broken.content[0].text, /ENOENT/);
  assert.deepEqual(await f.promptDirs(), []);
});

test('abort kills the child process group, including a grandchild that ignores SIGTERM', { timeout: TERM_GRACE_MS + 5000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'hang.json');
  const controller = new AbortController();
  const pending = f.execute({ agent: 'general-purpose', task: `HANG-IGNORE ${marker}` }, controller.signal);
  const { pid, grandchild } = await waitFor(marker);
  assert.ok(alive(pid) && alive(grandchild));
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(await untilGone([pid, grandchild], TERM_GRACE_MS + 2000), [], 'SIGKILL reaches the whole group');
  assert.ok(Date.now() - startedAt >= TERM_GRACE_MS - 50, 'SIGTERM grace was honored before SIGKILL');
  assert.deepEqual(await f.promptDirs(), []);
});

test('abort with a cooperative child returns before the SIGKILL grace', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'hang.json');
  const controller = new AbortController();
  const pending = f.execute({ agent: 'general-purpose', task: `HANG ${marker}` }, controller.signal);
  const { pid, grandchild } = await waitFor(marker);
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.ok(Date.now() - startedAt < TERM_GRACE_MS);
  assert.deepEqual(await untilGone([pid, grandchild], 1000), []);
});

test('timeoutMs stops a stuck child and reports a failed result instead of throwing', { timeout: TERM_GRACE_MS + 5000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'hang.json');
  const result = await f.execute({ agent: 'general-purpose', task: `HANG-IGNORE ${marker}`, timeoutMs: 300 });
  const { pid, grandchild } = await waitFor(marker);
  assert.match(result.content[0].text, /Agent aborted: Timed out after 300 ms/);
  assert.equal(result.details.results[0].stopReason, 'aborted');
  assert.notEqual(result.details.results[0].exitCode, 0);
  assert.deepEqual(f.resultHook(result), { isError: true });
  assert.deepEqual(await untilGone([pid, grandchild], 1000), []);
});

test('progress keeps queued rows distinct, freezes completion, and marks skipped chain steps', async (t) => {
  const f = await fixture(t);
  const log = path.join(f.root, 'progress.log');
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot[]} */
  const snapshots = [];
  const result = await f.execute({ role: 'review', tasks: Array.from({ length: 6 }, (_, index) => ({ agent: 'general-purpose', task: `SLOW ${index === 0 ? 50 : 1200} ${log}` })) }, undefined,
    (partial) => { if (partial.details.progress) snapshots.push(structuredClone(partial.details.progress)); });
  assert.ok(snapshots.some((snapshot) => snapshot.tasks.some((row) => row.state === 'running') && snapshot.tasks.some((row) => row.state === 'queued')));
  assert.ok(snapshots.some((snapshot) => snapshot.tasks[0].state === 'succeeded' && snapshot.tasks[1].state === 'running'));
  assert.ok(result.details.progress?.endedAt);
  assert.ok(result.details.progress.tasks.every((row) => row.state === 'succeeded' && row.role === 'review'));
  assert.equal(result.details.progress.tasks[0].endedAt, snapshots.find((snapshot) => snapshot.tasks[0].state === 'succeeded')?.tasks[0].endedAt);
  const chain = await f.execute({ chain: [{ agent: 'general-purpose', task: 'FAIL first' }, { agent: 'general-purpose', task: 'never {previous}' }] });
  assert.deepEqual(chain.details.progress?.tasks.map((row) => row.state), ['failed', 'skipped']);
});

test('aborted batches wait for all children and preserve terminal metadata through the error hook', { timeout: TERM_GRACE_MS + 6000 }, async (t) => {
  const f = await fixture(t);
  const markers = [path.join(f.root, 'first.json'), path.join(f.root, 'second.json')];
  const controller = new AbortController();
  const pending = f.execute({ tasks: markers.map((marker, index) => ({ agent: 'general-purpose', task: `${index ? 'HANG-IGNORE' : 'HANG'} ${marker}` })) }, controller.signal);
  const children = await Promise.all(markers.map(waitFor));
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(await untilGone(children.flatMap(({ pid, grandchild }) => [pid, grandchild]), 500), []);
  const hook = f.handlers.get('tool_result');
  const event = { toolName: 'subagent', toolCallId: 'call', isError: true };
  const saved = hook?.(event);
  assert.ok(saved.details.progress.endedAt);
  assert.deepEqual(saved.details.progress.tasks.map((/** @type {{state: string}} */ row) => row.state), ['aborted', 'aborted']);
  assert.equal(hook?.(event), undefined, 'Error metadata is consumed once');
});

test('session shutdown takes live children down with the parent', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'hang.json');
  const pending = f.execute({ agent: 'general-purpose', task: `HANG-IGNORE ${marker}` });
  const { pid, grandchild } = await waitFor(marker);
  const startedAt = Date.now();
  await f.handlers.get('session_shutdown')?.();
  assert.ok(Date.now() - startedAt < 2500, `shutdown took ${Date.now() - startedAt} ms`);
  assert.deepEqual(await untilGone([pid, grandchild], 500), []);
  const outcome = await Promise.race([pending.then(() => 'resolved'), delay(200).then(() => 'pending')]);
  assert.equal(outcome, 'pending', 'A result produced during shutdown must not restart the parent agent loop');
});

/** @param {import('node:test').TestContext} t */
async function cmuxFixture(t) {
  /** @type {string[][]} */
  const calls = [];
  const env = { CMUX_WORKSPACE_ID: 'workspace:fixture', CMUX_SURFACE_ID: 'surface:parent' };
  const f = await fixture(t, { env, cmuxExec: async (args, capturedEnv) => {
    assert.equal(capturedEnv.CMUX_WORKSPACE_ID, 'workspace:fixture');
    calls.push(args);
    return JSON.stringify({ surface_id: `surface:${calls.length}` });
  } });
  env.CMUX_WORKSPACE_ID = 'changed-after-registration';
  t.after(async () => { await f.handlers.get('session_shutdown')?.(); });
  const files = async () => (await readdir(f.root)).filter((name) => name.startsWith('pi-cmux-')).map((name) => path.join(f.root, name, 'transcript.txt'));
  return { ...f, calls, files };
}

test('cmux mirrors per-run output and final status without changing batch results or progress', async (t) => {
  const f = await cmuxFixture(t);
  const tasks = ['hello', 'FAIL x', 'EXIT2 x'].map((task) => ({ agent: 'general-purpose', task }));
  const result = await f.execute({ tasks });
  assert.deepEqual(result.details.results.map((r) => r.exitCode), [0, 0, 2]);
  assert.deepEqual(result.details.progress?.tasks.map((r) => r.state), ['succeeded', 'failed', 'failed']);
  assert.equal(f.resultHook(result), undefined);
  const files = await f.files();
  assert.equal(files.length, 3);
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  assert.ok(texts.some((text) => text.includes('hello') && text.includes('[Completed: exit 0]')));
  assert.ok(texts.some((text) => text.includes('partial answer') && text.includes('[Failed: PRIVATE_BOOM]')));
  assert.ok(texts.some((text) => text.includes('[Failed: exit 2]')));
  for (const file of files) await readFile(file + '.done');
  assert.equal(f.calls.filter((args) => args[1] === 'new-split').length, 3);
  await f.handlers.get('session_shutdown')?.();
  assert.deepEqual(await f.files(), []);
});

test('cmux creates panes only for started chain steps and none for invalid requests', async (t) => {
  const f = await cmuxFixture(t);
  await f.execute({ agent: 'missing', task: 'x' });
  assert.deepEqual(f.calls, []);
  const result = await f.execute({ chain: [
    { agent: 'general-purpose', task: 'first' },
    { agent: 'general-purpose', task: 'FAIL after {previous}' },
    { agent: 'general-purpose', task: 'never' },
  ] });
  assert.equal(result.details.results.length, 2);
  assert.deepEqual(result.details.progress?.tasks.map((row) => row.state), ['succeeded', 'failed', 'skipped']);
  assert.equal(f.calls.filter((args) => args[1] === 'new-split').length, 2);
  assert.equal((await f.files()).length, 2);
});

test('cmux shutdown removes a live transcript without returning a child result', { timeout: 5000 }, async (t) => {
  const f = await cmuxFixture(t);
  const marker = path.join(f.root, 'shutdown.json');
  const pending = f.execute({ agent: 'general-purpose', task: `HANG ${marker}` });
  const { pid, grandchild } = await waitFor(marker);
  assert.equal((await f.files()).length, 1);
  await f.handlers.get('session_shutdown')?.();
  assert.deepEqual(await f.files(), []);
  assert.deepEqual(await untilGone([pid, grandchild], 1000), []);
  assert.equal(await Promise.race([pending.then(() => 'resolved'), delay(100).then(() => 'pending')]), 'pending');
});

test('cmux timeout and abort finish transcripts while the runner keeps control of children', { timeout: 6000 }, async (t) => {
  const f = await cmuxFixture(t);
  const timed = await f.execute({ agent: 'general-purpose', task: `HANG ${path.join(f.root, 'timed.json')}`, timeoutMs: 500 });
  assert.equal(timed.details.results[0].stopReason, 'aborted');
  const controller = new AbortController();
  const marker = path.join(f.root, 'aborted.json');
  const pending = f.execute({ agent: 'general-purpose', task: `HANG ${marker}` }, controller.signal);
  const children = await waitFor(marker);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(await untilGone([children.pid, children.grandchild], 1000), []);
  const texts = await Promise.all((await f.files()).map((file) => readFile(file, 'utf8')));
  assert.ok(texts.some((text) => text.includes('[Failed: Timed out after 500 ms]')));
  assert.ok(texts.some((text) => text.includes('[Aborted: Subagent was aborted]')));
});

test('closing the cmux follower does not terminate the child or its grandchild', { timeout: 6000 }, async (t) => {
  const f = await cmuxFixture(t);
  const controller = new AbortController();
  const marker = path.join(f.root, 'pane-close.json');
  const pending = f.execute({ agent: 'general-purpose', task: `HANG ${marker}` }, controller.signal);
  const children = await waitFor(marker);
  const [file] = await f.files();
  const follower = spawn(process.execPath, [path.join(path.dirname(file), 'follow.cjs'), file, String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (follower.exitCode === null) follower.kill(); });
  await new Promise((resolve) => follower.stdout.once('data', resolve));
  const closed = new Promise((resolve) => follower.once('close', resolve));
  follower.kill('SIGTERM');
  await closed;
  assert.ok(alive(children.pid) && alive(children.grandchild));
  assert.equal(await Promise.race([pending.then(() => 'finished'), delay(100).then(() => 'running')]), 'running');
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(await untilGone([children.pid, children.grandchild], 1000), []);
});

test('missing or hung cmux does not delay child results', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const cmuxExec of [async () => { throw new Error('cmux unavailable'); }, async () => new Promise(() => {})]) {
    const { tools, handlers } = registration({ env: { CMUX_WORKSPACE_ID: 'workspace:fixture' }, cmuxExec });
    t.after(async () => { await handlers.get('session_shutdown')?.(); });
    const result = await Promise.race([
      tools[0].execute('call', { agent: 'general-purpose', task: 'hello' }, undefined, undefined, f.ctx),
      delay(700).then(() => { throw new Error('cmux blocked the runner'); }),
    ]);
    assert.equal(result.details.results[0].exitCode, 0);
    assert.equal(JSON.parse(result.content[0].text).task, 'hello');
  }
});
