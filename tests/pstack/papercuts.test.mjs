import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import { maxPapercutsPerTurn, papercutToolName, registerPapercuts } from '../../extensions/pstack/papercuts.ts';

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

test('registers scoped tool hooks, one strict tool, and one command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  assert.deepEqual([...f.handlers.keys()].sort(), ['tool_execution_start', 'tool_result', 'turn_start']);
  assert.deepEqual([...f.tools.keys()], [papercutToolName]);
  assert.deepEqual([...f.commands.keys()], ['papercuts']);
  const tool = f.tools.get(papercutToolName);
  assert.equal(Check(tool.parameters, { note: 'x', evidence: { tool: 'bash', durationMs: 1, outputBytes: 2 } }), true);
  assert.equal(Check(tool.parameters, { note: 'x', includeLastTool: true }), false);
});

test('appends a copyable trailer to every other tool result, keyed by call id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const start = f.handlers.get('tool_execution_start');
  const result = f.handlers.get('tool_result');
  start({ toolCallId: 'cat', toolName: 'bash' });
  start({ toolCallId: 'sleep', toolName: 'bash' });
  start({ toolCallId: 'own', toolName: papercutToolName });
  const sleep = result({ toolCallId: 'sleep', toolName: 'bash', content: [{ type: 'text', text: 'done\n' }], isError: false });
  const cat = result({ toolCallId: 'cat', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(51_338) }], isError: true });
  assert.equal(sleep.content.length, 2);
  assert.match(sleep.content[1].text, /^\[pstack: bash \d+ms 5B\]$/u);
  assert.match(cat.content[1].text, /^\[pstack: bash \d+ms 51338B failed\]$/u);
  assert.equal(result({ toolCallId: 'own', toolName: papercutToolName, content: [], isError: false }), undefined);
  assert.equal(result({ toolCallId: 'unknown', toolName: 'read', content: [], isError: false }), undefined);
});

test('records agent-supplied evidence verbatim and lists or aggregates the journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  const first = await tool.execute('call-1', { kind: 'tool.output-noisy', note: ' cat dumped  a lockfile ', evidence: { tool: 'bash', durationMs: 24, outputBytes: 51_338 } }, undefined, undefined, f.ctx);
  const second = await tool.execute('call-2', { note: 'no kind given' }, undefined, undefined, f.ctx);
  assert.deepEqual(first.content, [{ type: 'text', text: 'Recorded papercut [tool.output-noisy]' }]);
  assert.equal(first.details.record.note, 'cat dumped a lockfile');
  assert.deepEqual(first.details.record.evidence, { tool: 'bash', durationMs: 24, outputBytes: 51_338, isError: false });
  assert.equal(second.details.record.kind, 'other');
  assert.equal(second.details.record.evidence, undefined);
  assert.equal(first.details.file, second.details.file);
  assert.equal((await readFile(first.details.file, 'utf8')).trim().split('\n').length, 2);

  const command = f.commands.get('papercuts');
  await command.handler('', f.ctx);
  await command.handler('all', { ...f.ctx, cwd: '/elsewhere' });
  await command.handler('', { ...f.ctx, cwd: '/elsewhere' });
  await command.handler('bogus', f.ctx);
  await command.handler('aggregate', f.ctx);
  assert.equal(f.notifications.length, 5);
  assert.match(f.notifications[0].message, /^.+ \| other \| no kind given\n.+ \| tool\.output-noisy \| cat dumped a lockfile \| bash, 24ms, 50\.1 KiB$/u);
  assert.match(f.notifications[1].message, /\| \/work\/alpha \| other \|/u);
  assert.deepEqual(f.notifications[2], { message: 'No papercuts for this project', level: 'info' });
  assert.deepEqual(f.notifications[3], { message: 'Usage: /papercuts [all | aggregate]', level: 'error' });
  assert.match(f.notifications[4].message, /^Wrote 2 papercuts to .+\/papercut-aggregations\/.+\.md$/u);
  const [snapshot] = await readdir(join(root, 'papercut-aggregations'));
  const markdown = await readFile(join(root, 'papercut-aggregations', snapshot), 'utf8');
  assert.match(markdown, /Records: 2\nProjects: 1/u);
  assert.match(markdown, /\| \/work\/alpha \| tool\.output-noisy \| cat dumped a lockfile \| 1 \| bash \| 24ms \| 50\.1 KiB \|/u);
});

test('new records name the host and the session model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  const result = await tool.execute('call-1', { note: 'slow build' }, undefined, undefined, f.ctx);
  const [line] = (await readFile(result.details.file, 'utf8')).trim().split('\n');
  const record = JSON.parse(line);
  assert.equal(record.version, 2);
  assert.equal(record.host, hostname().replace(/\.local$/u, ''));
  assert.doesNotMatch(record.host, /\.local$/u);
  assert.equal(record.model, 'test-provider/test-model');
  const withoutModel = await tool.execute('call-2', { note: 'no model yet' }, undefined, undefined, { ...f.ctx, model: undefined });
  assert.equal(withoutModel.details.record.model, undefined);
});

test('thousands of concurrent calls with one note write one record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  f.handlers.get('turn_start')({ type: 'turn_start', turnIndex: 0, timestamp: 0 });
  const results = await Promise.all(Array.from({ length: 3000 }, (_, index) => tool.execute(`call-${index}`, { note: 'Same  note ' }, undefined, undefined, f.ctx)));
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
  const later = await tool.execute('call-later', { note: 'Same note' }, undefined, undefined, f.ctx);
  assert.equal(later.details.status, 'duplicate', 'the same papercut stays a duplicate in later turns');
  const otherSession = await tool.execute('call-other', { note: 'Same note' }, undefined, undefined, { ...f.ctx, sessionManager: { getSessionId: () => 'session-2' } });
  assert.equal(otherSession.details.status, 'recorded');
});

test('caps distinct papercuts per turn and resets the cap on the next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  const tool = f.tools.get(papercutToolName);
  const turnStart = f.handlers.get('turn_start');
  turnStart({ type: 'turn_start', turnIndex: 0, timestamp: 0 });
  const first = await Promise.all(Array.from({ length: 8 }, (_, index) => tool.execute(`a-${index}`, { note: `distinct ${index}` }, undefined, undefined, f.ctx)));
  assert.equal(maxPapercutsPerTurn, 5);
  assert.deepEqual(first.map((result) => result.details.status), ['recorded', 'recorded', 'recorded', 'recorded', 'recorded', 'turn-limit', 'turn-limit', 'turn-limit']);
  for (const result of first.slice(5)) {
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'Not recorded: reached the limit of 5 papercuts per turn. Record only distinct problems.');
  }
  turnStart({ type: 'turn_start', turnIndex: 1, timestamp: 1 });
  const second = await Promise.all([5, 6].map((index) => tool.execute(`b-${index}`, { note: `distinct ${index}` }, undefined, undefined, f.ctx)));
  assert.deepEqual(second.map((result) => result.details.status), ['recorded', 'recorded']);
  const lines = (await readFile(second[0].details.file, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).note).sort(), ['distinct 0', 'distinct 1', 'distinct 2', 'distinct 3', 'distinct 4', 'distinct 5', 'distinct 6']);
});
