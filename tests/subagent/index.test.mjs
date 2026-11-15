import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import subagentExtension, { MAX_CONCURRENCY, SPAWNING_TOOLS, TERM_GRACE_MS, childEnvironment, createSlots, observedModelId } from '../../extensions/subagent/index.ts';
import { bundledAgents } from '../../extensions/subagent/agents.ts';
import { roles } from '../../extensions/subagent/model-config.ts';
import { Check } from 'typebox/value';
import { progressCard, progressLines } from '../../extensions/subagent/progress.ts';

const fakePi = fileURLToPath(new URL('./fake-pi.mjs', import.meta.url));

/** @param {string} text */
function childOutput(text) {
  const match = /^resolved-model: [^\n]+\n(?:session-id: [^\n]+\nsession-path: [^\n]+\n|session: [^\n]+\n)?\n/.exec(text);
  assert.ok(match, `missing resolved-model line: ${text.slice(0, 120)}`);
  return text.slice(match[0].length);
}
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
/** @param {number} ms */
const realDelay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/** @typedef {import('../../extensions/subagent/index.ts').SubagentDetails} SubagentDetails */
/** @typedef {{content: {type: string, text: string}[], details: SubagentDetails, isError?: boolean}} ToolResult */

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
  /** @type {Map<string, Parameters<import('@earendil-works/pi-coding-agent').ExtensionAPI['registerCommand']>[1]>} */
  const commands = new Map();
  const api = {
    registerTool: (/** @type {any} */ tool) => tools.push(tool),
    registerCommand: (/** @type {string} */ name, /** @type {Parameters<import('@earendil-works/pi-coding-agent').ExtensionAPI['registerCommand']>[1]} */ command) => {
      assert.equal(name, 'subagents');
      commands.set(name, command);
    },
    on: (/** @type {string} */ event, /** @type {(...args: any[]) => any} */ handler) => { assert.ok(!handlers.has(event), `duplicate ${event} handler`); handlers.set(event, handler); },
  };
  subagentExtension(/** @type {any} */ (api), { spawnChild: spawnFake, env: {}, runPane: null, ...options });
  return { tools, handlers, commands };
}

/** @param {import('node:test').TestContext} t @param {Parameters<typeof subagentExtension>[1]} [options] */
async function fixture(t, options) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'subagent-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'work');
  await mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await mkdir(cwd);
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, tmpdir: process.env.TMPDIR, denied: process.env.PI_DENY_TOOLS };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMPDIR = root;
  delete process.env.PI_DENY_TOOLS;
  const abort = new AbortController();
  /** @type {import('node:child_process').ChildProcess[]} */
  const live = [];
  /** @type {NonNullable<Parameters<typeof subagentExtension>[1]>['spawnChild']} */
  const spawnChild = (invocation, spawnOptions) => {
    const child = (options?.spawnChild ?? spawnFake)(invocation, spawnOptions);
    live.push(child);
    child.on('exit', () => {
      const index = live.indexOf(child);
      if (index !== -1) live.splice(index, 1);
    });
    return child;
  };
  t.after(async () => {
    abort.abort();
    for (const child of [...live]) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    for (const [key, value] of /** @type {[string, string | undefined][]} */ ([['PI_CODING_AGENT_DIR', previous.agentDir], ['TMPDIR', previous.tmpdir], ['PI_DENY_TOOLS', previous.denied]])) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const { tools, handlers, commands } = registration({ ...options, spawnChild });
  assert.equal(tools.length, 1);
  /** @type {string[]} */
  const notices = [];
  const ctx = /** @type {any} */ ({ cwd, model: { provider: 'fixture', id: 'model' }, thinkingLevel: 'high', hasUI: false, isProjectTrusted: () => false, ui: { confirm: async () => false, notify: (/** @type {string} */ text) => notices.push(text) } });
  /** @type {(params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: ToolResult) => void) => Promise<ToolResult>} */
  const execute = (params, signal, onUpdate) => tools[0].execute('call', params, signal ?? abort.signal, onUpdate, ctx);
  const promptDirs = async () => (await readdir(root)).filter((name) => name.startsWith('pi-subagent-'));
  return { root, agentDir, cwd, tool: tools[0], handlers, commands, notices, ctx, execute, promptDirs, abort };
}

/** @param {string} file @returns {Promise<{pid: number, grandchild: number}>} */
async function waitFor(file) {
  for (let tries = 0; tries < 200; tries++) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { await realDelay(25); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** @param {number[]} pids @param {number} ms */
async function untilGone(pids, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(alive)) await realDelay(25);
  return pids.filter(alive);
}

test('spawning rule: a Pi denied blocking_subagent registers nothing, the root registers the tool and both hooks', () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin' }).PI_DENY_TOOLS?.split(','), SPAWNING_TOOLS);
  assert.equal(childEnvironment({ PI_DENY_TOOLS: 'bash, subagent' }).PI_DENY_TOOLS, 'bash,subagent,blocking_subagent,subagent_interrupt,subagents_list,subagent_resume');
  assert.equal(childEnvironment({ PI_MEMORY_EXIT_SUMMARY: '1' }).PI_MEMORY_EXIT_SUMMARY, '0', 'Children never write pi-memory exit summaries');
  for (const denied of ['blocking_subagent', ' bash , blocking_subagent ', SPAWNING_TOOLS.join(',')]) assert.deepEqual(registration({ env: { PI_DENY_TOOLS: denied } }).tools, []);
  assert.equal(registration({ env: { PSTACK_SUBAGENT_DEPTH: '1' } }).tools.length, 1, 'Depth no longer gates the tool');
  assert.equal(registration({ env: { PI_DENY_TOOLS: 'subagent,bash' } }).tools.length, 1);
  const { tools, handlers } = registration({ env: {} });
  assert.equal(tools[0].name, 'blocking_subagent');
  assert.deepEqual([...handlers.keys()].sort(), ['session_shutdown', 'tool_result']);
  for (const text of ['comment-sicko', 'general-purpose', 'poteto-agent', 'inherit-parent', roles[0], 'Children cannot delegate']) assert.ok(tools[0].description.includes(text), text);
});

test('registered tool description lists bundled capabilities without inferring task intent', () => {
  const { tools } = registration({ env: {} });
  const description = tools[0].description;
  const general = bundledAgents().find((agent) => agent.name === 'general-purpose');
  const poteto = bundledAgents().find((agent) => agent.name === 'poteto-agent');
  assert.ok(general && poteto);
  assert.match(description, /general-purpose: Read files and answer one focused research or code question\. Tools: read, grep, find, ls\./);
  assert.match(description, /poteto-agent: Implement one bounded coding task in poteto style, test it, and report exact changes for parent review\. Tools: read, grep, find, ls, bash, edit, write\./);
  assert.match(description, /User and project agents override bundled ones by name/);
  assert.deepEqual(general.tools, ['read', 'grep', 'find', 'ls']);
  assert.ok(poteto.tools?.includes('write') && poteto.tools?.includes('edit'));
  assert.ok(!general.tools?.includes('write') && !general.tools?.includes('edit'));
});

test('single mode runs the bundled agent in a detached child with prompt file, stdin task, denied spawning tools, and parent model', async (t) => {
  const f = await fixture(t);
  const task = 'Summarize @file with --flags and unicode ✓';
  /** @type {ToolResult[]} */
  const updates = [];
  const result = await f.execute({ agent: 'general-purpose', task }, undefined, (partial) => { updates.push(partial); });
  const details = result.details;
  assert.equal(details.results[0].exitCode, 0);
  assert.equal(details.results[0].agentSource, 'bundled');
  assert.equal(details.results[0].modelSource, 'parent');
  assert.equal(details.results[0].model, 'fixture/model');
  assert.equal(details.results[0].observedModel, 'fixture/model');
  assert.equal(details.results[0].usage.turns, 1);
  assert.equal(details.results[0].usage.input, 11);
  assert.match(result.content[0].text, /^resolved-model: fixture\/model\n/);
  const capture = JSON.parse(childOutput(result.content[0].text));
  assert.equal(capture.task, task);
  assert.deepEqual(capture.denied?.split(','), SPAWNING_TOOLS);
  assert.equal(capture.memoryExitSummary, '0');
  assert.equal(capture.cwd, f.cwd);
  assert.equal(capture.promptMode, 0o600);
  assert.equal(capture.prompt, (await readFile(new URL('../../additions/agents/general-purpose.md', import.meta.url), 'utf8')).split('---\n')[2].trim());
  assert.deepEqual(capture.args.slice(0, 3), ['--mode', 'json', '-p']);
  assert.ok(!capture.args.includes('--no-session'));
  assert.equal(capture.args[capture.args.indexOf('--session-id') + 1], details.results[0].sessionId);
  assert.ok(capture.args.includes('--model') && capture.args[capture.args.indexOf('--model') + 1] === 'fixture/model');
  assert.equal(capture.args[capture.args.indexOf('--thinking') + 1], 'high');
  assert.equal(capture.args[capture.args.indexOf('--tools') + 1], 'read,grep,find,ls,pstack_todo');
  assert.ok(!capture.args.includes(task), 'The task travels over stdin, not argv');
  assert.ok(updates.length >= 1 && updates[updates.length - 1].details.results[0].messages.length === 1);
  assert.deepEqual(await f.promptDirs(), [], 'Prompt temp directory is removed');
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.results[0].messages.map((m) => m.role), ['assistant'], 'The child system prompt stays out of details');
});

test('model routing: explicit beats role beats agent default beats parent, and pinned models skip parent thinking', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.agentDir, 'pstack-pi'));
  await writeFile(path.join(f.agentDir, 'pstack-pi', 'models.json'), JSON.stringify({ version: 1, roles: { feature: ['pool/one', 'pool/two'], review: 'inherit-parent' } }));
  await writeFile(path.join(f.agentDir, 'agents', 'custom.md'), '---\nname: custom\ndescription: Custom.\nmodel: agent/default\ntools: bash\n---\nCustom prompt.\n');
  /** @param {Record<string, unknown>} params */
  const modelOf = async (params) => {
    const result = await f.execute(params);
    const capture = JSON.parse(childOutput(result.content[0].text));
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

test('a role selector keeps its thinking suffix, and an explicit thinking level still wins', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.agentDir, 'pstack-pi'));
  await writeFile(path.join(f.agentDir, 'pstack-pi', 'models.json'), JSON.stringify({ version: 1, roles: { feature: 'pinned/model:xhigh' } }));
  /** @param {Record<string, unknown>} params */
  const argsOf = async (params) => JSON.parse(childOutput((await f.execute(params)).content[0].text)).args;
  const roleArgs = await argsOf({ agent: 'general-purpose', task: 'x', role: 'feature' });
  assert.deepEqual(roleArgs.slice(7, 9), ['--model', 'pinned/model:xhigh']);
  assert.ok(!roleArgs.includes('--thinking'));
  assert.deepEqual((await argsOf({ agent: 'general-purpose', task: 'x', role: 'feature', thinking: 'low' })).slice(7, 11), ['--model', 'pinned/model:xhigh', '--thinking', 'low']);
});

test('thinking schema accepts only Pi levels', () => {
  const { tools } = registration();
  for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(Check(tools[0].parameters, { agent: 'general-purpose', task: 'x', thinking }), true);
  }
  for (const params of [
    { agent: 'general-purpose', task: 'x', thinking: 'ultra' },
  ]) assert.equal(Check(tools[0].parameters, params), false);
});

test('single thinking overrides inherited parent level and pinned model defaults stay unchanged', async (t) => {
  const f = await fixture(t);
  /** @type {[Record<string, unknown>, string[]][]} */
  const cases = [
    [{ agent: 'general-purpose', task: 'x', thinking: 'off' }, ['--model', 'fixture/model', '--thinking', 'off']],
    [{ agent: 'general-purpose', task: 'x', model: 'pinned/model', thinking: 'high' }, ['--model', 'pinned/model', '--thinking', 'high']],
    [{ agent: 'general-purpose', task: 'x' }, ['--model', 'fixture/model', '--thinking', 'high']],
    [{ agent: 'general-purpose', task: 'x', model: 'pinned/model' }, ['--model', 'pinned/model']],
  ];
  for (const [params, expected] of cases) {
    const result = await f.execute(params);
    const args = JSON.parse(childOutput(result.content[0].text)).args;
    assert.deepEqual(args.slice(7, 7 + expected.length), expected);
    assert.equal(args.includes('--thinking'), expected.includes('--thinking'));
    assert.equal(result.details.results[0].thinking, expected.includes('--thinking') ? expected[expected.indexOf('--thinking') + 1] : undefined);
    assert.ok(result.details.progress);
    assert.equal(result.details.progress.tasks[0].thinking, result.details.results[0].thinking ?? null);
    if (expected.includes('--thinking')) {
      assert.match(progressCard(result.details.progress).lines.join('\n'), new RegExp(`thinking ${result.details.results[0].thinking}`));
      assert.match(progressLines(result.details.progress).join('\n'), new RegExp(`thinking ${result.details.results[0].thinking}`));
    }
  }
});

/** @param {string} text */
const sessionOf = (text) => /^session-id: (\S+)\nsession-path: (\S+)$/m.exec(text)?.slice(1) ?? [];
/** @param {string} file */
const header = async (file) => JSON.parse((await readFile(file, 'utf8')).split('\n')[0]);

test('every child keeps its session and the reply names its id and path', async (t) => {
  const f = await fixture(t);
  const single = await f.execute({ agent: 'general-purpose', task: 'x' });
  const [id, file] = sessionOf(single.content[0].text);
  assert.match(single.content[0].text, /^resolved-model: fixture\/model\nsession-id: /);
  assert.equal(path.dirname(path.dirname(file)), path.join(f.agentDir, 'sessions'));
  assert.deepEqual(await header(file), { type: 'session', version: 3, id, cwd: f.cwd });
  assert.ok(!JSON.parse(childOutput(single.content[0].text)).args.includes('--no-session'));
});

test('the child session follows PI_CODING_AGENT_SESSION_DIR', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.root, 'custom-sessions');
  process.env.PI_CODING_AGENT_SESSION_DIR = custom;
  t.after(() => { delete process.env.PI_CODING_AGENT_SESSION_DIR; });
  const result = await f.execute({ agent: 'general-purpose', task: 'x' });
  const [id, file] = sessionOf(result.content[0].text);
  assert.equal(path.dirname(file), custom);
  assert.deepEqual(await header(file), { type: 'session', version: 3, id, cwd: f.cwd });
});

test('the child session expands ~ in PI_CODING_AGENT_SESSION_DIR as Pi does', async (t) => {
  const f = await fixture(t);
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  process.env.PI_CODING_AGENT_SESSION_DIR = '~/tilde-sessions';
  t.after(() => { delete process.env.PI_CODING_AGENT_SESSION_DIR; process.env.HOME = previousHome; });
  const [id, file] = sessionOf((await f.execute({ agent: 'general-purpose', task: 'x' })).content[0].text);
  assert.equal(path.dirname(file), path.join(f.root, 'tilde-sessions'));
  assert.equal((await header(file)).id, id);
});

test('the child session with a symlinked cwd uses the folder a real Pi child would, keyed by the real path', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, 'link');
  await symlink(f.cwd, link);
  const ctx = { ...f.ctx, cwd: link };
  const result = await f.tool.execute('call', { agent: 'general-purpose', task: 'x' }, f.abort.signal, undefined, ctx);
  const [id, file] = sessionOf(result.content[0].text);
  assert.equal(path.dirname(file), path.join(f.agentDir, 'sessions', `--${f.cwd.slice(1).replaceAll('/', '-')}--`));
  assert.deepEqual(await header(file), { type: 'session', version: 3, id, cwd: f.cwd });
});

test('the child session says plainly when the child saved no session', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ agent: 'general-purpose', task: 'EXIT2' });
  assert.match(result.content[0].text, /^resolved-model: unknown\nsession: none saved, the child exited before writing its session file\n/);
  assert.doesNotMatch(result.content[0].text, /session-path/);
});

test('resolved-model comes from the child response, not the requested selector', async (t) => {
  assert.equal(observedModelId('openai-codex', 'gpt-6-sol'), 'openai-codex/gpt-6-sol');
  assert.equal(observedModelId('openai-codex', 'gpt\n6'), undefined);
  assert.equal(observedModelId(undefined, 'gpt-6-sol'), undefined);
  const f = await fixture(t);
  const other = await f.execute({ agent: 'general-purpose', task: 'OTHERMODEL', model: 'requested/selector' });
  assert.equal(other.details.results[0].model, 'observed/actual');
  assert.equal(other.details.results[0].observedModel, 'observed/actual');
  assert.match(other.content[0].text, /^resolved-model: observed\/actual\n/);
  assert.equal(childOutput(other.content[0].text), 'other model');
  const missing = await f.execute({ agent: 'general-purpose', task: 'NOMODEL', model: 'requested/selector' });
  assert.equal(missing.details.results[0].observedModel, undefined);
  assert.equal(missing.details.results[0].model, 'requested/selector');
  assert.match(missing.content[0].text, /^resolved-model: unknown\n/);
  assert.doesNotMatch(missing.content[0].text, /requested\/selector/);
});

test('unknown agents return guidance without spawning', async (t) => {
  const f = await fixture(t);
  const unknown = await f.execute({ agent: 'nope', task: 'x' });
  assert.match(unknown.content[0].text, /Unknown agent "nope".*general-purpose \(bundled\)/);
  assert.deepEqual(unknown.details.results, []);
  assert.equal(unknown.isError, false);
});

test('the schema takes one agent and task: tasks and chain arrays are gone', () => {
  const { tools } = registration();
  const params = tools[0].parameters;
  assert.equal(Check(params, { agent: 'general-purpose', task: 'x' }), true);
  assert.equal(Check(params, { tasks: [{ agent: 'general-purpose', task: 'x' }] }), false);
  assert.equal(Check(params, { chain: [{ agent: 'general-purpose', task: 'x' }] }), false);
  assert.equal(params.properties.tasks, undefined);
  assert.equal(params.properties.chain, undefined);
  assert.doesNotMatch(tools[0].description, /tasks array|chain|\{previous\}/);
});

test('separate calls run side by side, headless children share a cap of four, and one failure fails only its call', async (t) => {
  const f = await fixture(t);
  const log = path.join(f.root, 'overlap.log');
  const tasks = [`SLOW 300 ${log}`, `SLOW 100 ${log}`, 'FAIL now', `SLOW 50 ${log}`, `SLOW 200 ${log}`, `SLOW 20 ${log}`, `SLOW 80 ${log}`, `SLOW 60 ${log}`];
  const results = await Promise.all(tasks.map((task) => f.execute({ agent: 'general-purpose', task })));
  assert.deepEqual(results.map((r) => r.details.results[0].task), tasks);
  assert.deepEqual(results.map((r) => r.isError), [false, false, true, false, false, false, false, false]);
  assert.match(results[2].content[0].text, /^resolved-model: fixture\/model\nsession-id: \S+\nsession-path: \S+\n\nAgent error: PRIVATE_BOOM/);
  const events = (await readFile(log, 'utf8')).trim().split('\n').map((line) => line.split(' '));
  let live = 0; let peak = 0;
  for (const [kind] of events.sort((a, b) => Number(a[1]) - Number(b[1]))) { live += kind === 'start' ? 1 : -1; peak = Math.max(peak, live); }
  assert.ok(peak <= MAX_CONCURRENCY && peak >= 2, `peak concurrency ${peak}`);
});

test('createSlots starts waiters in call order and an abort drops a waiter', async () => {
  const slots = createSlots(1);
  await slots.acquire();
  /** @type {string[]} */
  const order = [];
  const controller = new AbortController();
  const first = slots.acquire().then(() => order.push('first'));
  const dropped = slots.acquire(controller.signal);
  const second = slots.acquire().then(() => order.push('second'));
  controller.abort();
  await assert.rejects(dropped, /aborted/);
  slots.release();
  await realDelay(0);
  slots.release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(slots.active, 1);
});

test('a failed single result is an error result and a spawn failure is reported', async (t) => {
  const f = await fixture(t);
  const failed = await f.execute({ agent: 'general-purpose', task: 'FAIL x' });
  assert.match(failed.content[0].text, /^resolved-model: fixture\/model\nsession-id: \S+\nsession-path: \S+\n\nAgent error: PRIVATE_BOOM/);
  assert.equal(failed.details.results[0].observedModel, 'fixture/model');
  assert.equal(failed.isError, true);
  const exited = await f.execute({ agent: 'general-purpose', task: 'EXIT2 x' });
  assert.equal(exited.details.results[0].exitCode, 2);
  assert.match(exited.content[0].text, /^resolved-model: unknown\nsession: none saved, the child exited before writing its session file\n\nAgent failed: child exploded/);
  assert.equal(exited.details.results[0].observedModel, undefined);
  assert.equal(exited.details.results[0].model, 'fixture/model');
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

test('timeoutMs stops a stuck child and reports a failed result instead of throwing', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { termGraceMs: 50 });
  const marker = path.join(f.root, 'hang.json');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.execute({ agent: 'general-purpose', task: `HANG-IGNORE ${marker}`, timeoutMs: 300 });
  const { pid, grandchild } = await waitFor(marker);
  assert.ok(alive(pid) && alive(grandchild));
  t.mock.timers.tick(300);
  t.mock.timers.tick(50);
  const result = await pending;
  t.mock.timers.reset();
  assert.match(result.content[0].text, /Agent aborted: Timed out after 300 ms/);
  assert.equal(result.details.results[0].stopReason, 'aborted');
  assert.notEqual(result.details.results[0].exitCode, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(await untilGone([pid, grandchild], 1000), []);
});

test('a call waiting for a headless slot shows queued until a slot frees, then freezes completion', async (t) => {
  const f = await fixture(t);
  const count = MAX_CONCURRENCY + 1;
  const ready = Array.from({ length: count }, (_, index) => path.join(f.root, `ready-${index}.json`));
  const release = Array.from({ length: count }, (_, index) => path.join(f.root, `release-${index}`));
  const releaseAll = () => Promise.all(release.map((file) => writeFile(file, 'go').catch(() => {})));
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot[]} */
  const lastSnapshots = [];
  const pending = ready.map((file, index) => f.execute({ role: 'review', agent: 'general-purpose', task: `WAIT ${file} ${release[index]}` }, undefined,
    (partial) => { if (partial.details.progress) lastSnapshots[index] = structuredClone(partial.details.progress); }));
  try {
    await Promise.all(ready.slice(0, MAX_CONCURRENCY).map(waitFor));
    await delay(100);
    assert.equal(lastSnapshots[MAX_CONCURRENCY]?.tasks[0].state, 'queued');
    await assert.rejects(readFile(ready[MAX_CONCURRENCY]), /ENOENT/);
    await writeFile(release[0], 'go');
    await waitFor(ready[MAX_CONCURRENCY]);
    await releaseAll();
    const results = await Promise.all(pending);
    for (const result of results) {
      assert.ok(result.details.progress?.endedAt);
      assert.ok(result.details.progress.tasks.every((row) => row.state === 'succeeded' && row.role === 'review'));
    }
  } finally {
    f.abort.abort();
    await releaseAll();
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => realSetTimeout(resolve, 2000))]);
  }
});

test('an aborted call waits for its child and preserves terminal metadata through the error hook', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { termGraceMs: 50 });
  const marker = path.join(f.root, 'hang.json');
  const controller = new AbortController();
  const pending = f.execute({ agent: 'general-purpose', task: `HANG-IGNORE ${marker}` }, controller.signal);
  const { pid, grandchild } = await waitFor(marker);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(await untilGone([pid, grandchild], 500), []);
  const hook = f.handlers.get('tool_result');
  const event = { toolName: 'blocking_subagent', toolCallId: 'call', isError: true };
  const saved = hook?.(event);
  assert.ok(saved.details.progress.endedAt);
  assert.deepEqual(saved.details.progress.tasks.map((/** @type {{state: string}} */ row) => row.state), ['aborted']);
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

/**
 * A pane launcher that records each call and writes the session file a real child would leave.
 * @param {import('node:test').TestContext} t
 * @param {(params: any, signal: AbortSignal) => Promise<Record<string, unknown>> | Record<string, unknown>} [finish]
 */
async function paneFixture(t, finish) {
  /** @type {any[]} */
  const calls = [];
  /** @type {import('../../extensions/subagent/index.ts').PaneRunner} */
  const runPane = async (params, _ctx, signal, thinking) => {
    calls.push({ ...params, thinking });
    const sessionFile = path.join(f.root, `pane-${calls.length}.jsonl`);
    const text = `pane says ${params.task}`;
    const lines = [{ type: 'session', id: `sid-${calls.length}` }, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: params.task }] } },
      { type: 'message', message: { role: 'assistant', provider: 'pane', model: 'model', content: [{ type: 'text', text }], usage: { input: 3, output: 4, totalTokens: 7 }, stopReason: 'stop' } }];
    await writeFile(sessionFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return /** @type {any} */ ({ name: params.name, task: params.task, summary: text, sessionFile, exitCode: 0, elapsed: 0, ...(await finish?.(params, signal)) });
  };
  const f = await fixture(t, { runPane, spawnChild: () => assert.fail('headless child in a multiplexer') });
  f.ctx.sessionManager = { getSessionFile: () => path.join(f.root, 'parent.jsonl') };
  return { ...f, calls };
}

test('in a multiplexer a single child runs in a pane and the reply carries its model and session', async (t) => {
  const f = await paneFixture(t);
  const single = await f.execute({ agent: 'general-purpose', task: 'hello', thinking: 'low' });
  assert.equal(single.isError, false);
  assert.equal(single.content[0].text, `resolved-model: pane/model\nsession-id: sid-1\nsession-path: ${path.join(f.root, 'pane-1.jsonl')}\n\npane says hello`);
  assert.equal(single.details.results[0].usage.output, 4);
  assert.deepEqual(single.details.progress?.tasks.map((row) => row.state), ['succeeded']);
  const agent = bundledAgents().find((item) => item.name === 'general-purpose');
  assert.deepEqual(f.calls[0], { name: 'general-purpose', task: 'hello', cwd: f.cwd, systemPrompt: agent?.systemPrompt.trim(), model: 'fixture/model', thinking: 'low', tools: agent?.tools?.length ? [...new Set([...agent.tools, 'pstack_todo'])].join(',') : undefined });
});

test('a child that asks for help fails with its question', async (t) => {
  const f = await paneFixture(t, () => ({ ping: { name: 'general-purpose', message: 'Which branch?' } }));
  const result = await f.execute({ agent: 'general-purpose', task: 'hello' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Agent error: The child asked for help: Which branch\?$/);
});

test('the pane child keeps the requested thinking level when no model resolves', async (t) => {
  const f = await paneFixture(t);
  f.ctx.model = undefined;
  await f.execute({ agent: 'general-purpose', task: 'hello', thinking: 'low' });
  assert.equal(f.calls[0].model, undefined);
  assert.equal(f.calls[0].thinking, 'low');
});

test('blocking_subagent uses the pane runner the live interactive extension published', async (t) => {
  const key = Symbol.for('pstack-pi/interactive-subagents/pane-runner');
  const previous = /** @type {any} */ (globalThis)[key];
  t.after(() => { /** @type {any} */ (globalThis)[key] = previous; });
  /** @type {string[]} */
  const ran = [];
  /** @type {any} */ (globalThis)[key] = { isMuxAvailable: () => true, runSubagentInPane: async (/** @type {any} */ params) => { ran.push(params.task); return { summary: 'ok', exitCode: 0 }; } };
  const f = await fixture(t, { runPane: undefined, spawnChild: () => assert.fail('headless child with a published runner') });
  f.ctx.sessionManager = { getSessionFile: () => path.join(f.root, 'parent.jsonl') };
  await f.execute({ agent: 'general-purpose', task: 'hello' });
  assert.deepEqual(ran, ['hello']);
  /** @type {any} */ (globalThis)[key] = { isMuxAvailable: () => false, runSubagentInPane: () => assert.fail('no multiplexer') };
  await assert.rejects(f.execute({ agent: 'general-purpose', task: 'plain' }), /headless child with a published runner/);
});

test('a closed pane or a timeout fails the child and an abort rejects the call', { timeout: 5000 }, async (t) => {
  const f = await paneFixture(t, async (params, signal) => {
    if (params.task === 'closed') return { exitCode: 1, paneClosed: true, summary: 'Its pane was closed before it finished.' };
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { exitCode: 1, error: 'cancelled', summary: 'Subagent cancelled.' };
  });
  const closed = await f.execute({ agent: 'general-purpose', task: 'closed' });
  assert.equal(closed.isError, true);
  assert.match(closed.content[0].text, /Agent error: Its pane was closed before it finished\.$/);
  const timed = await f.execute({ agent: 'general-purpose', task: 'hang', timeoutMs: 100 });
  assert.equal(timed.details.results[0].stopReason, 'aborted');
  assert.match(timed.content[0].text, /Timed out after 100 ms/);
  const controller = new AbortController();
  const pending = f.execute({ agent: 'general-purpose', task: 'hang' }, controller.signal);
  await realDelay(20);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('without a parent session file the child runs headless even in a multiplexer', async (t) => {
  const f = await fixture(t, { runPane: () => assert.fail('pane without a session file') });
  const result = await f.execute({ agent: 'general-purpose', task: 'hello' });
  assert.equal(JSON.parse(childOutput(result.content[0].text)).task, 'hello');
});
