import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import subagentExtension, { DEPTH_VARIABLE, MAX_CONCURRENCY, TERM_GRACE_MS, childEnvironment, observedModelId, parentDepth } from '../../extensions/subagent/index.ts';
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
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, tmpdir: process.env.TMPDIR, depth: process.env[DEPTH_VARIABLE] };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMPDIR = root;
  delete process.env[DEPTH_VARIABLE];
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
    for (const [key, value] of /** @type {[string, string | undefined][]} */ ([['PI_CODING_AGENT_DIR', previous.agentDir], ['TMPDIR', previous.tmpdir], [DEPTH_VARIABLE, previous.depth]])) {
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

test('depth guard: a child Pi registers nothing, the root registers the tool and both hooks', () => {
  assert.equal(parentDepth({}), 0);
  assert.equal(parentDepth({ [DEPTH_VARIABLE]: '1' }), 1);
  assert.ok(parentDepth({ [DEPTH_VARIABLE]: 'garbage' }) >= 1, 'Unreadable depth disables delegation');
  assert.equal(childEnvironment(0, { PATH: '/bin' })[DEPTH_VARIABLE], '1');
  assert.equal(childEnvironment(0, { PI_MEMORY_EXIT_SUMMARY: '1' }).PI_MEMORY_EXIT_SUMMARY, '0', 'Children never write pi-memory exit summaries');
  for (const depth of ['1', '01', '7', 'x']) assert.deepEqual(registration({ env: { [DEPTH_VARIABLE]: depth } }).tools, []);
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
  assert.equal(details.results[0].observedModel, 'fixture/model');
  assert.equal(details.results[0].usage.turns, 1);
  assert.equal(details.results[0].usage.input, 11);
  assert.match(result.content[0].text, /^resolved-model: fixture\/model\n/);
  const capture = JSON.parse(childOutput(result.content[0].text));
  assert.equal(capture.task, task);
  assert.equal(capture.depth, '1');
  assert.equal(capture.memoryExitSummary, '0');
  assert.equal(capture.cwd, f.cwd);
  assert.equal(capture.promptMode, 0o600);
  assert.equal(capture.prompt, (await readFile(new URL('../../additions/agents/general-purpose.md', import.meta.url), 'utf8')).split('---\n')[2].trim());
  assert.deepEqual(capture.args.slice(0, 4), ['--mode', 'json', '-p', '--no-session']);
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
  assert.deepEqual(roleArgs.slice(4, 6), ['--model', 'pinned/model:xhigh']);
  assert.ok(!roleArgs.includes('--thinking'));
  assert.deepEqual((await argsOf({ agent: 'general-purpose', task: 'x', role: 'feature', thinking: 'low' })).slice(4, 8), ['--model', 'pinned/model:xhigh', '--thinking', 'low']);
});

test('thinking schema accepts only Pi levels at the call and task boundaries', () => {
  const { tools } = registration();
  for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(Check(tools[0].parameters, { agent: 'general-purpose', task: 'x', thinking }), true);
    assert.equal(Check(tools[0].parameters, { tasks: [{ agent: 'general-purpose', task: 'x', thinking }] }), true);
    assert.equal(Check(tools[0].parameters, { chain: [{ agent: 'general-purpose', task: 'x', thinking }] }), true);
  }
  for (const params of [
    { agent: 'general-purpose', task: 'x', thinking: 'ultra' },
    { tasks: [{ agent: 'general-purpose', task: 'x', thinking: 'ultra' }] },
    { chain: [{ agent: 'general-purpose', task: 'x', thinking: 'ultra' }] },
  ]) assert.equal(Check(tools[0].parameters, params), false);
});

test('single thinking overrides inherited parent level and pinned model defaults stay unchanged', async (t) => {
  const f = await fixture(t);
  /** @type {[Record<string, unknown>, string[]][]} */
  const cases = [
    [{ agent: 'general-purpose', task: 'x', thinking: 'off' }, ['--mode', 'json', '-p', '--no-session', '--model', 'fixture/model', '--thinking', 'off']],
    [{ agent: 'general-purpose', task: 'x', model: 'pinned/model', thinking: 'high' }, ['--mode', 'json', '-p', '--no-session', '--model', 'pinned/model', '--thinking', 'high']],
    [{ agent: 'general-purpose', task: 'x' }, ['--mode', 'json', '-p', '--no-session', '--model', 'fixture/model', '--thinking', 'high']],
    [{ agent: 'general-purpose', task: 'x', model: 'pinned/model' }, ['--mode', 'json', '-p', '--no-session', '--model', 'pinned/model']],
  ];
  for (const [params, expected] of cases) {
    const result = await f.execute(params);
    const args = JSON.parse(childOutput(result.content[0].text)).args;
    assert.deepEqual(args.slice(0, expected.length), expected);
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

test('parallel and chain thinking use per-item overrides over the call default', async (t) => {
  const f = await fixture(t);
  for (const mode of ['tasks', 'chain']) {
    const result = await f.execute({ [mode]: [
      { agent: 'general-purpose', task: 'first' },
      { agent: 'general-purpose', task: 'second', thinking: 'high' },
    ], thinking: 'low', model: 'pinned/model' });
    assert.deepEqual(result.details.results.map((r) => r.thinking), ['low', 'high']);
    assert.ok(result.details.progress);
    assert.deepEqual(result.details.progress.tasks.map((r) => r.thinking), ['low', 'high']);
    for (const [index, level] of ['low', 'high'].entries()) {
      const content = result.details.results[index].messages.at(-1)?.content[0];
      assert.ok(content && typeof content !== 'string' && content.type === 'text');
      const args = JSON.parse(content.text).args;
      assert.deepEqual(args.slice(0, 8), ['--mode', 'json', '-p', '--no-session', '--model', 'pinned/model', '--thinking', level]);
    }
  }
});

/** @param {string} text */
const sessionOf = (text) => /^session-id: (\S+)\nsession-path: (\S+)$/m.exec(text)?.slice(1) ?? [];
/** @param {string} file */
const header = async (file) => JSON.parse((await readFile(file, 'utf8')).split('\n')[0]);

test('keepSession saves the child session and reports its id and path in every mode', async (t) => {
  const f = await fixture(t);
  const single = await f.execute({ agent: 'general-purpose', task: 'x', keepSession: true });
  const [id, file] = sessionOf(single.content[0].text);
  assert.match(single.content[0].text, /^resolved-model: fixture\/model\nsession-id: /);
  assert.equal(path.dirname(path.dirname(file)), path.join(f.agentDir, 'sessions'));
  assert.deepEqual(await header(file), { type: 'session', version: 3, id, cwd: f.cwd });
  assert.ok(!JSON.parse(childOutput(single.content[0].text)).args.includes('--no-session'));
  const parallel = await f.execute({ tasks: [{ agent: 'general-purpose', task: 'a' }, { agent: 'general-purpose', task: 'b' }, { agent: 'general-purpose', task: 'c', keepSession: false }], keepSession: true });
  const blocks = parallel.content[0].text.split('### ').slice(1);
  const ids = [];
  for (const block of blocks.slice(0, 2)) {
    const [blockId, blockFile] = sessionOf(block);
    assert.equal((await header(blockFile)).id, blockId);
    ids.push(blockId);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.doesNotMatch(blocks[2], /^session/m);
  const chain = await f.execute({ chain: [{ agent: 'general-purpose', task: 'a' }, { agent: 'general-purpose', task: 'b' }], keepSession: true });
  const [chainId, chainFile] = sessionOf(chain.content[0].text);
  assert.equal(chainId, chain.details.results[1].sessionId);
  assert.equal((await header(chainFile)).id, chainId);
  assert.doesNotMatch((await f.execute({ agent: 'general-purpose', task: 'x' })).content[0].text, /^session/m);
});

test('keepSession follows PI_CODING_AGENT_SESSION_DIR', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.root, 'custom-sessions');
  process.env.PI_CODING_AGENT_SESSION_DIR = custom;
  t.after(() => { delete process.env.PI_CODING_AGENT_SESSION_DIR; });
  const result = await f.execute({ agent: 'general-purpose', task: 'x', keepSession: true });
  const [id, file] = sessionOf(result.content[0].text);
  assert.equal(path.dirname(file), custom);
  assert.deepEqual(await header(file), { type: 'session', version: 3, id, cwd: f.cwd });
});

test('keepSession expands ~ in PI_CODING_AGENT_SESSION_DIR as Pi does', async (t) => {
  const f = await fixture(t);
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  process.env.PI_CODING_AGENT_SESSION_DIR = '~/tilde-sessions';
  t.after(() => { delete process.env.PI_CODING_AGENT_SESSION_DIR; process.env.HOME = previousHome; });
  const [id, file] = sessionOf((await f.execute({ agent: 'general-purpose', task: 'x', keepSession: true })).content[0].text);
  assert.equal(path.dirname(file), path.join(f.root, 'tilde-sessions'));
  assert.equal((await header(file)).id, id);
});

test('keepSession with a symlinked cwd uses the folder a real Pi child would, keyed by the real path', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, 'link');
  await symlink(f.cwd, link);
  const ctx = { ...f.ctx, cwd: link };
  const result = await f.tool.execute('call', { agent: 'general-purpose', task: 'x', keepSession: true }, f.abort.signal, undefined, ctx);
  const [id, file] = sessionOf(result.content[0].text);
  assert.equal(path.dirname(file), path.join(f.agentDir, 'sessions', `--${f.cwd.slice(1).replaceAll('/', '-')}--`));
  assert.deepEqual(await header(file), { type: 'session', version: 3, id, cwd: f.cwd });
});

test('keepSession says plainly when the child saved no session', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ agent: 'general-purpose', task: 'EXIT2', keepSession: true });
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

test('unknown agents, mixed modes, and too many tasks return guidance without spawning', async (t) => {
  const f = await fixture(t);
  const unknown = await f.execute({ agent: 'nope', task: 'x' });
  assert.match(unknown.content[0].text, /Unknown agent "nope".*general-purpose \(bundled\)/);
  assert.deepEqual(unknown.details.results, []);
  assert.match((await f.execute({ agent: 'general-purpose', task: 'x', tasks: [{ agent: 'general-purpose', task: 'y' }] })).content[0].text, /exactly one mode/);
  assert.match((await f.execute({ tasks: Array.from({ length: 9 }, () => ({ agent: 'general-purpose', task: 'y' })) })).content[0].text, /Too many parallel tasks \(9\)/);
  assert.equal(unknown.isError, false);
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
  assert.match(result.content[0].text, /### \[poteto-agent\] failed \(error\)\nresolved-model: fixture\/model\n\nPRIVATE_BOOM/);
  const events = (await readFile(log, 'utf8')).trim().split('\n').map((line) => line.split(' '));
  let live = 0; let peak = 0;
  for (const [kind] of events.sort((a, b) => Number(a[1]) - Number(b[1]))) { live += kind === 'start' ? 1 : -1; peak = Math.max(peak, live); }
  assert.ok(peak <= MAX_CONCURRENCY && peak >= 2, `peak concurrency ${peak}`);
  assert.equal(result.isError, false, 'A partial failure is not an error result');
  const allFailed = await f.execute({ tasks: [{ agent: 'general-purpose', task: 'FAIL a' }, { agent: 'general-purpose', task: 'EXIT2 b' }] });
  assert.equal(allFailed.isError, true);
  assert.match(allFailed.content[0].text, /\[general-purpose\] failed\nresolved-model: unknown\n\nchild exploded/);
});

test('chain mode substitutes {previous} and stops at the first failed step', async (t) => {
  const f = await fixture(t);
  const ok = await f.execute({ chain: [{ agent: 'general-purpose', task: 'first' }, { agent: 'general-purpose', task: 'second after {previous}' }] });
  assert.equal(ok.details.mode, 'chain');
  assert.deepEqual(ok.details.results.map((r) => r.step), [1, 2]);
  assert.match(ok.content[0].text, /^resolved-model: fixture\/model\n/);
  const second = JSON.parse(childOutput(ok.content[0].text));
  assert.ok(second.task.startsWith('second after {"args"'), second.task.slice(0, 40));
  const stopped = await f.execute({ chain: [{ agent: 'general-purpose', task: 'FAIL early' }, { agent: 'general-purpose', task: 'never {previous}' }] });
  assert.equal(stopped.details.results.length, 1);
  assert.match(stopped.content[0].text, /Chain stopped at step 1 \(general-purpose\): PRIVATE_BOOM/);
  assert.equal(stopped.isError, true);
});

test('a failed single result is an error result and a spawn failure is reported', async (t) => {
  const f = await fixture(t);
  const failed = await f.execute({ agent: 'general-purpose', task: 'FAIL x' });
  assert.match(failed.content[0].text, /^resolved-model: fixture\/model\n\nAgent error: PRIVATE_BOOM/);
  assert.equal(failed.details.results[0].observedModel, 'fixture/model');
  assert.equal(failed.isError, true);
  const exited = await f.execute({ agent: 'general-purpose', task: 'EXIT2 x' });
  assert.equal(exited.details.results[0].exitCode, 2);
  assert.match(exited.content[0].text, /^resolved-model: unknown\n\nAgent failed: child exploded/);
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

test('progress keeps queued rows distinct, freezes completion, and marks skipped chain steps', async (t) => {
  const f = await fixture(t);
  const ready = Array.from({ length: 6 }, (_, index) => path.join(f.root, `ready-${index}.json`));
  const release = Array.from({ length: 6 }, (_, index) => path.join(f.root, `release-${index}`));
  const releaseAll = () => Promise.all(release.map((file) => writeFile(file, 'go').catch(() => {})));
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot[]} */
  const snapshots = [];
  const pending = f.execute({ role: 'review', tasks: ready.map((file, index) => ({ agent: 'general-purpose', task: `WAIT ${file} ${release[index]}` })) }, undefined,
    (partial) => { if (partial.details.progress) snapshots.push(structuredClone(partial.details.progress)); });
  try {
    await Promise.all(ready.slice(0, MAX_CONCURRENCY).map(waitFor));
    for (let tries = 0; tries < 200; tries++) {
      if (snapshots.some((snapshot) => snapshot.tasks.some((row) => row.state === 'running') && snapshot.tasks.some((row) => row.state === 'queued'))) break;
      await delay(25);
    }
    assert.ok(snapshots.some((snapshot) => snapshot.tasks.some((row) => row.state === 'running') && snapshot.tasks.some((row) => row.state === 'queued')));
    await writeFile(release[0], 'go');
    for (let tries = 0; tries < 200; tries++) {
      if (snapshots.some((snapshot) => snapshot.tasks[0].state === 'succeeded' && snapshot.tasks[1].state === 'running')) break;
      await delay(25);
    }
    assert.ok(snapshots.some((snapshot) => snapshot.tasks[0].state === 'succeeded' && snapshot.tasks[1].state === 'running'));
    await releaseAll();
    const result = await pending;
    assert.ok(result.details.progress?.endedAt);
    assert.ok(result.details.progress.tasks.every((row) => row.state === 'succeeded' && row.role === 'review'));
    assert.equal(result.details.progress.tasks[0].endedAt, snapshots.find((snapshot) => snapshot.tasks[0].state === 'succeeded')?.tasks[0].endedAt);
    const chain = await f.execute({ chain: [{ agent: 'general-purpose', task: 'FAIL first' }, { agent: 'general-purpose', task: 'never {previous}' }] });
    assert.deepEqual(chain.details.progress?.tasks.map((row) => row.state), ['failed', 'skipped']);
  } finally {
    f.abort.abort();
    await releaseAll();
    await new Promise((/** @type {(value?: undefined) => void} */ resolve) => {
      const timer = realSetTimeout(resolve, 2000);
      pending.catch(() => {}).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

test('aborted batches wait for all children and preserve terminal metadata through the error hook', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { termGraceMs: 50 });
  const markers = [path.join(f.root, 'first.json'), path.join(f.root, 'second.json')];
  const controller = new AbortController();
  const pending = f.execute({ tasks: markers.map((marker, index) => ({ agent: 'general-purpose', task: `${index ? 'HANG-IGNORE' : 'HANG'} ${marker}` })) }, controller.signal);
  const children = await Promise.all(markers.map(waitFor));
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(await untilGone(children.flatMap(({ pid, grandchild }) => [pid, grandchild]), 500), []);
  const hook = f.handlers.get('tool_result');
  const event = { toolName: 'blocking_subagent', toolCallId: 'call', isError: true };
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
