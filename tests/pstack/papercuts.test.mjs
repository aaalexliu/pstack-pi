import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import { papercutToolName, registerPapercuts } from '../../extensions/pstack/papercuts.ts';

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
    sessionManager: { getSessionId: () => 'session-1' },
    ui: { notify(/** @type {string} */ message, /** @type {string} */ level) { notifications.push({ message, level }); } },
  };
  return { pi, handlers, tools, commands, notifications, ctx };
}

test('registers scoped tool hooks, one strict tool, and one command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-papercuts-'));
  const f = fakeExtension();
  registerPapercuts(/** @type {any} */ (f.pi), root);
  assert.deepEqual([...f.handlers.keys()], ['tool_execution_start', 'tool_result']);
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
