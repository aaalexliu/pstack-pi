import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import { maxPapercutsPerTurn, papercutToolName, readPstackBuild, registerPapercuts } from '../../extensions/pstack/papercuts.ts';

function fakeExtension() {
  /** @type {Map<string, any>} */
  const handlers = new Map();
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {Map<string, any>} */
  const commands = new Map();
  /** @type {Array<{message: string, level: string}>} */
  const notifications = [];
  const pi = {
    on(/** @type {string} */ name, /** @type {any} */ handler) { handlers.set(name, handler); },
    registerTool(/** @type {any} */ value) { tools.set(value.name, value); },
    registerCommand(/** @type {string} */ name, /** @type {any} */ value) { commands.set(name, value); },
  };
  const ctx = {
    cwd: '/work/alpha',
    model: { provider: 'test-provider', id: 'test-model' },
    sessionManager: { getSessionId: () => 'session-1' },
    ui: { notify(/** @type {string} */ message, /** @type {string} */ level) { notifications.push({ message, level }); } },
  };
  return { pi, handlers, tools, commands, notifications, ctx };
}

const read = { culprit: { type: 'pi-tool', name: 'read' }, impact: 'extra-steps' };

test('registers scoped tool hooks, one strict tool, and one command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  assert.deepEqual([...f.handlers.keys()].sort(), ['tool_execution_start', 'tool_result', 'turn_start']);
  assert.deepEqual([...f.tools.keys()], [papercutToolName]);
  assert.deepEqual([...f.commands.keys()], ['papercuts']);
  const tool = f.tools.get(papercutToolName);
  assert.equal(Check(tool.parameters, { note: 'x', ...read }), true);
  assert.equal(Check(tool.parameters, { note: 'x', kind: 'tool.slow', ...read }), false);
});

test('trails only top-level calls of 10 seconds or more', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), '/unused');
  const start = f.handlers.get('tool_execution_start');
  const result = f.handlers.get('tool_result');
  const content = [{ type: 'text', text: '{"ok":true}' }];
  for (const event of [
    { toolCallId: 'fast', toolName: 'bash' },
    { toolCallId: 'slow', toolName: 'bash' },
    { toolCallId: 'script', toolName: 'codemode' },
    { toolCallId: 'script/1', toolName: 'mcp', parentToolCallId: 'script' },
    { toolCallId: 'own', toolName: papercutToolName },
  ]) start(event);
  now = 1_000;
  assert.equal(result({ toolCallId: 'fast', toolName: 'bash', content, isError: false }), undefined);
  now = 12_000;
  assert.equal(result({ toolCallId: 'script/1', toolName: 'mcp', parentToolCallId: 'script', content, isError: false }), undefined);
  assert.equal(JSON.parse(content[0].text).ok, true, 'a nested result stays parseable');
  assert.deepEqual(result({ toolCallId: 'slow', toolName: 'bash', content, isError: true }).content, [...content, { type: 'text', text: '[pstack: took 12s]' }]);
  assert.deepEqual(result({ toolCallId: 'script', toolName: 'codemode', content, isError: false }).content[1], { type: 'text', text: '[pstack: took 12s]' });
  assert.equal(result({ toolCallId: 'own', toolName: papercutToolName, content: [], isError: false }), undefined);
  assert.equal(result({ toolCallId: 'unknown', toolName: 'read', content: [], isError: false }), undefined);
});

test('writes a version 3 record stamped with the call, the build and the repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const repo = await mkdtemp(join(tmpdir(), 'pstack-papercuts-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  const result = await tool.execute('toolu_01', { note: ' read showed  the old file ', culprit: { type: 'pi-tool', name: ' read ' }, impact: 'wrong-result', fix: 'skip the cache' }, undefined, undefined, { ...f.ctx, cwd: join(repo) });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Recorded papercut [pi-tool:read]' }]);
  const [line, ...rest] = (await readFile(result.details.file, 'utf8')).trim().split('\n');
  assert.deepEqual(rest, []);
  const { at, build, ...record } = JSON.parse(line);
  assert.ok(!Number.isNaN(Date.parse(at)));
  assert.equal(build, await readPstackBuild());
  assert.match(build, /^pstack-pi@([0-9a-f]{7}|\d+\.\d+\.\d+)$/u);
  assert.deepEqual(record, {
    version: 3,
    source: 'agent',
    sessionId: 'session-1',
    callId: 'toolu_01',
    cwd: repo,
    repo: { root: realpathSync(repo), head },
    host: hostname().replace(/\.local$/u, ''),
    model: 'test-provider/test-model',
    note: 'read showed the old file',
    culprit: { type: 'pi-tool', name: 'read' },
    impact: 'wrong-result',
    fix: 'skip the cache',
  });
  const outside = await tool.execute('toolu_02', { note: 'no repo here', culprit: { type: 'self' }, impact: 'extra-steps' }, undefined, undefined, { ...f.ctx, cwd: tmpdir(), model: undefined });
  assert.equal(outside.details.record.repo, undefined);
  assert.equal(outside.details.record.model, undefined);
  assert.equal(outside.details.record.fix, undefined);
});

test('lists the journal for this project or all projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  await tool.execute('call-1', { note: 'cat dumped a lockfile', culprit: { type: 'command', name: 'cat' }, impact: 'extra-steps' }, undefined, undefined, f.ctx);
  await tool.execute('call-2', { note: 'guessed a path', culprit: { type: 'self' }, impact: 'extra-steps' }, undefined, undefined, f.ctx);
  const command = f.commands.get('papercuts');
  await command.handler('', f.ctx);
  await command.handler('all', { ...f.ctx, cwd: '/elsewhere' });
  await command.handler('', { ...f.ctx, cwd: '/elsewhere' });
  await command.handler('aggregate', f.ctx);
  assert.equal(f.notifications.length, 4);
  assert.match(f.notifications[0].message, /^.+ \| self \| guessed a path \| extra-steps\n.+ \| command:cat \| cat dumped a lockfile \| extra-steps$/u);
  assert.match(f.notifications[1].message, /\| \/work\/alpha \| self \|/u);
  assert.deepEqual(f.notifications[2], { message: 'No papercuts for this project', level: 'info' });
  assert.deepEqual(f.notifications[3], { message: 'Usage: /papercuts [all]', level: 'error' });
});

test('thousands of concurrent calls with one note write one record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  f.handlers.get('turn_start')({ type: 'turn_start', turnIndex: 0, timestamp: 0 });
  const results = await Promise.all(Array.from({ length: 3000 }, (_, index) => tool.execute(`call-${index}`, { note: 'Same  note ', ...read }, undefined, undefined, f.ctx)));
  const recorded = results.filter((result) => result.details.status === 'recorded');
  assert.equal(recorded.length, 1);
  assert.equal((await readFile(recorded[0].details.file, 'utf8')).trim().split('\n').length, 1);
  const duplicates = results.filter((result) => result.details.status === 'duplicate');
  assert.equal(duplicates.length, 2999);
  for (const result of duplicates) {
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /^Not recorded: this session already recorded the same papercut/u);
  }
  f.handlers.get('turn_start')({ type: 'turn_start', turnIndex: 1, timestamp: 1 });
  const later = await tool.execute('call-later', { note: 'Same note', ...read, impact: 'blocked' }, undefined, undefined, f.ctx);
  assert.equal(later.details.status, 'duplicate', 'the same papercut stays a duplicate in later turns');
  const otherSession = await tool.execute('call-other', { note: 'Same note', ...read }, undefined, undefined, { ...f.ctx, sessionManager: { getSessionId: () => 'session-2' } });
  assert.equal(otherSession.details.status, 'recorded');
});

test('caps distinct papercuts per turn and resets the cap on the next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  const turnStart = f.handlers.get('turn_start');
  turnStart({ type: 'turn_start', turnIndex: 0, timestamp: 0 });
  const first = await Promise.all(Array.from({ length: 8 }, (_, index) => tool.execute(`a-${index}`, { note: `distinct ${index}`, ...read }, undefined, undefined, f.ctx)));
  assert.equal(maxPapercutsPerTurn, 5);
  assert.deepEqual(first.map((result) => result.details.status), ['recorded', 'recorded', 'recorded', 'recorded', 'recorded', 'turn-limit', 'turn-limit', 'turn-limit']);
  for (const result of first.slice(5)) {
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'Not recorded: reached the limit of 5 papercuts per turn. Record only distinct problems.');
  }
  turnStart({ type: 'turn_start', turnIndex: 1, timestamp: 1 });
  const second = await Promise.all([5, 6].map((index) => tool.execute(`b-${index}`, { note: `distinct ${index}`, ...read }, undefined, undefined, f.ctx)));
  assert.deepEqual(second.map((result) => result.details.status), ['recorded', 'recorded']);
  const lines = (await readFile(second[0].details.file, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).note).sort(), ['distinct 0', 'distinct 1', 'distinct 2', 'distinct 3', 'distinct 4', 'distinct 5', 'distinct 6']);
});

test('a result nested in another tool, such as an MCP result in a codemode script, stays parseable JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const content = [{ type: 'text', text: '{"ok":true}' }];
  f.handlers.get('tool_execution_start')({ toolCallId: 'script/1', toolName: 'mcp', parentToolCallId: 'script' });
  const replaced = f.handlers.get('tool_result')({ toolCallId: 'script/1', toolName: 'mcp', parentToolCallId: 'script', content, isError: false });
  const seen = (replaced?.content ?? content).map((/** @type {{ text: string }} */ part) => part.text).join('');
  assert.deepEqual(JSON.parse(seen), { ok: true });
});
