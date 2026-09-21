import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CmuxTranscripts, CMUX_TIMEOUT_MS } from '../../extensions/subagent/cmux.ts';

const env = { CMUX_WORKSPACE_ID: 'workspace:7', CMUX_SURFACE_ID: 'surface:2' };
const identity = (pane = 'pane:parent') => JSON.stringify({
  caller: { workspace_ref: env.CMUX_WORKSPACE_ID, surface_ref: env.CMUX_SURFACE_ID, pane_ref: pane },
  focused: { pane_ref: 'pane:unrelated' },
});

/** @param {import('node:test').TestContext} t @param {import('../../extensions/subagent/cmux.ts').CmuxExec} [exec] */
function fixture(t, exec) {
  const transcripts = new CmuxTranscripts();
  t.after(() => transcripts.shutdown());
  /** @type {string[][]} */
  const calls = [];
  const pane = transcripts.create({ env, label: "agent 'quoted'", exec: exec ?? (async (args, capturedEnv) => {
    calls.push(args);
    assert.deepEqual(capturedEnv, env);
    return args[1] === 'identify' ? identity() : JSON.stringify({ surface_ref: 'surface:9' });
  }) });
  assert.ok(pane);
  return { transcripts, pane, calls };
}

/** @param {string} command */
function follow(command) {
  const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  const done = once(proc, 'close').then(([code]) => { assert.equal(code, 0); return output; });
  return { proc, done };
}

test('missing workspace or parent surface skips display; both enable it', async (t) => {
  const { transcripts, pane } = fixture(t);
  await pane.ready;
  assert.equal(readFileSync(pane.file, 'utf8'), "Subagent: agent 'quoted'\n");
  for (const missing of [{}, { CMUX_WORKSPACE_ID: 'workspace:7' }, { CMUX_SURFACE_ID: 'surface:2' }]) {
    assert.equal(transcripts.create({ env: missing, label: 'agent', exec: async () => { assert.fail('unexpected cmux'); } }), undefined);
  }
});

test('private files, parent-targeted background tab, quoting, events and terminal status', { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cmux quote's "));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(root, { recursive: true, force: true }); });
  const { pane, calls } = fixture(t);
  await pane.ready;
  assert.equal(statSync(path.dirname(pane.file)).mode & 0o777, 0o700);
  for (const file of [pane.file, path.join(path.dirname(pane.file), 'follow.cjs')]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(calls[0], ['--json', 'identify', '--id-format', 'both', '--workspace', 'workspace:7', '--surface', 'surface:2']);
  assert.deepEqual(calls[1], ['--json', 'new-surface', '--type', 'terminal', '--pane', 'pane:parent', '--workspace', 'workspace:7', '--focus', 'false']);
  assert.deepEqual(calls[2].slice(0, -1), ['--json', 'send', '--workspace', 'workspace:7', '--surface', 'surface:9']);
  assert.deepEqual(calls[3], ['--json', 'rename-tab', '--workspace', 'workspace:7', '--surface', 'surface:9', "Subagent: agent 'quoted'"]);
  pane.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer ✓' }, { type: 'thinking', thinking: 'hidden' }, { type: 'toolCall', name: 'bash', arguments: { command: 'echo hi' } }] } });
  pane.event({ type: 'message_end', message: { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'oops' }, { type: 'image', data: 'secret-image' }] } });
  pane.write('\x1bterminal-control');
  pane.finish('Completed: exit 0');
  pane.finish('duplicate');
  pane.write('too late');
  assert.equal(statSync(pane.file + '.done').mode & 0o777, 0o600);
  const expected = readFileSync(pane.file, 'utf8');
  assert.match(expected, /answer ✓/);
  assert.match(expected, /Tool: bash/);
  assert.match(expected, /Result: bash \(error\)/);
  assert.match(expected, /\[image omitted\]/);
  assert.match(expected, /\[Completed: exit 0\]/);
  assert.doesNotMatch(expected, /hidden|secret-image|duplicate|too late|\x1b/);
  assert.equal(await follow(calls[2][calls[2].length - 1]).done, expected);
  pane.cleanup();
  pane.cleanup();
  assert.equal(existsSync(path.dirname(pane.file)), false);
});

test('follower drains and exits on unlink or dead parent', { timeout: 5000 }, async (t) => {
  for (const reason of ['unlink', 'parent']) {
    const { pane } = fixture(t);
    await pane.ready;
    pane.write('last bytes ✓');
    const proc = spawn(process.execPath, [path.join(path.dirname(pane.file), 'follow.cjs'), pane.file, String(reason === 'parent' ? 2147483647 : process.pid)]);
    t.after(() => { if (proc.exitCode === null) proc.kill(); });
    let output = '';
    proc.stdout.on('data', (chunk) => { output += chunk; });
    const done = once(proc, 'close');
    if (reason === 'unlink') {
      await once(proc.stdout, 'data');
      pane.cleanup();
    }
    assert.equal((await done)[0], 0);
    assert.match(output, /last bytes ✓/);
  }
});

for (const concurrent of [true, false]) {
  test(`${concurrent ? 'concurrent' : 'sequential'} allocations resolve the current parent pane, including moves`, async (t) => {
    /** @type {string[]} */
    const targets = [];
    let parent = 'pane:original';
    const { transcripts, pane: first } = fixture(t, async (args) => {
      if (args[1] === 'identify') return identity(parent);
      if (args[1] === 'new-surface') { targets.push(args[5]); parent = 'pane:moved'; }
      return JSON.stringify({ surface_ref: 'surface:first' });
    });
    if (!concurrent) await first.ready;
    const second = transcripts.create({ env, label: 'second', exec: async (args) => {
      if (args[1] === 'identify') return identity(parent);
      if (args[1] === 'new-surface') targets.push(args[5]);
      return JSON.stringify({ surface_ref: 'surface:second' });
    } });
    assert.ok(second);
    second.write('output before allocation');
    await Promise.all([first.ready, second.ready]);
    assert.deepEqual(targets, ['pane:original', 'pane:moved']);
    assert.equal(readFileSync(second.file, 'utf8'), 'Subagent: second\noutput before allocation');
    assert.ok(existsSync(first.file));
  });
}

test('UUID caller identity targets its pane ID rather than the focused pane', async (t) => {
  const transcripts = new CmuxTranscripts();
  t.after(() => transcripts.shutdown());
  /** @type {string[]} */
  const targets = [];
  const pane = transcripts.create({ env: { CMUX_WORKSPACE_ID: 'workspace-uuid', CMUX_SURFACE_ID: 'surface-uuid' }, label: 'uuid', exec: async (args) => {
    if (args[1] === 'identify') return JSON.stringify({ caller: { workspace_id: 'workspace-uuid', surface_id: 'surface-uuid', pane_id: 'pane-uuid' }, focused: { pane_id: 'wrong' } });
    if (args[1] === 'new-surface') targets.push(args[5]);
    return JSON.stringify({ surface_id: 'tab-uuid' });
  } });
  assert.ok(pane);
  await pane.ready;
  assert.deepEqual(targets, ['pane-uuid']);
  assert.equal(readFileSync(pane.file, 'utf8'), 'Subagent: uuid\n');
});

test('unresolved parent and failed allocation never fall back; a later child can recover', { timeout: 6000 }, async (t) => {
  for (const reply of ['not json', '{}', 'null', JSON.stringify({ focused: { pane_ref: 'pane:wrong' } }), identity(''),
    JSON.stringify({ caller: { pane_ref: 'pane:wrong', surface_ref: 'surface:other', workspace_ref: 'workspace:7' } }),
    JSON.stringify({ caller: { pane_ref: 'pane:wrong', surface_ref: 'surface:2', workspace_ref: 'workspace:other' } }), 'error', 'hung', 'allocation-error', 'allocation-malformed']) {
    /** @type {string[]} */
    const calls = [];
    const { transcripts, pane } = fixture(t, async (args) => {
      calls.push(args[1]);
      if (reply === 'error' || args[1] === 'new-surface' && reply === 'allocation-error') throw new Error('cmux failed');
      if (reply === 'hung') return new Promise(() => {});
      if (reply.startsWith('allocation-')) return args[1] === 'identify' ? identity() : 'not json';
      return reply;
    });
    const started = Date.now();
    await pane.ready;
    assert.ok(Date.now() - started < CMUX_TIMEOUT_MS + 2000);
    assert.equal(existsSync(pane.file), false);
    assert.deepEqual(calls, reply.startsWith('allocation-') ? ['identify', 'new-surface'] : ['identify']);
    const next = transcripts.create({ env, label: 'recovered', exec: async (args) => args[1] === 'identify' ? identity() : JSON.stringify({ surface_ref: 'surface:next' }) });
    assert.ok(next);
    await next.ready;
    assert.equal(readFileSync(next.file, 'utf8'), 'Subagent: recovered\n');
  }
});

test('failed send closes only its tab; failed rename keeps the transcript', async (t) => {
  for (const failedCommand of ['send', 'rename-tab']) {
    /** @type {string[][]} */
    const closed = [];
    const { pane } = fixture(t, async (args, _env, signal) => {
      if (args[1] === 'identify') return identity();
      if (args[1] === 'close-surface') {
        assert.equal(signal.aborted, false);
        closed.push(args);
      }
      if (args[1] === failedCommand) throw new Error('surface closed');
      return JSON.stringify({ surface_ref: 'surface:9' });
    });
    await pane.ready;
    assert.equal(existsSync(pane.file), failedCommand === 'rename-tab');
    assert.deepEqual(closed, failedCommand === 'send' ? [['--json', 'close-surface', '--workspace', 'workspace:7', '--surface', 'surface:9']] : []);
  }
});

test('slow send does not hold the allocation queue', async (t) => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve('{}'); });
  const { transcripts, pane: first } = fixture(t, async (args) => {
    if (args[1] === 'identify') return identity();
    if (args[1] === 'send') return gate;
    return JSON.stringify({ surface_ref: 'surface:first' });
  });
  const second = transcripts.create({ env, label: 'second', exec: async (args) => args[1] === 'identify' ? identity() : JSON.stringify({ surface_ref: 'surface:second' }) });
  assert.ok(second);
  await second.ready;
  assert.equal(readFileSync(second.file, 'utf8'), 'Subagent: second\n');
  release();
  await first.ready;
});

for (const phase of ['identify', 'new-surface']) {
  test(`shutdown during ${phase} skips queued allocations and cleans late resources`, async (t) => {
    /** @type {(value: string) => void} */
    let reply = () => assert.fail('command not started');
    let started = () => {};
    const gate = new Promise((resolve) => { started = () => resolve(undefined); });
    /** @type {string[]} */
    const calls = [];
    const { transcripts, pane } = fixture(t, async (args) => {
      calls.push(args[1]);
      if (args[1] === phase) { started(); return new Promise((resolve) => { reply = resolve; }); }
      return identity();
    });
    const queued = transcripts.create({ env, label: 'queued', exec: async () => { assert.fail('queued allocation'); } });
    assert.ok(queued);
    await gate;
    transcripts.shutdown();
    reply(phase === 'identify' ? identity() : JSON.stringify({ surface_ref: 'surface:late' }));
    await Promise.all([pane.ready, queued.ready]);
    assert.deepEqual(calls, phase === 'identify' ? ['identify'] : ['identify', 'new-surface', 'close-surface']);
    assert.equal(existsSync(pane.file), false);
    assert.equal(existsSync(queued.file), false);
    assert.equal(transcripts.create({ env, label: 'late' }), undefined);
  });
}

test('allocation timeout closes a surface that arrives after ready settles', { timeout: 4000 }, async (t) => {
  /** @type {(value: string) => void} */
  let reply = () => assert.fail('allocation not started');
  /** @type {string[]} */
  const closed = [];
  const { pane } = fixture(t, async (args) => {
    if (args[1] === 'identify') return identity();
    if (args[1] === 'new-surface') return new Promise((resolve) => { reply = resolve; });
    if (args[1] === 'close-surface') closed.push(args[5]);
    return '{}';
  });
  await pane.ready;
  assert.equal(existsSync(pane.file), false);
  reply(JSON.stringify({ surface_id: 'surface:late' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ['surface:late']);
});

test('immediate shutdown never allocates queued surfaces', async (t) => {
  const { transcripts, pane, calls } = fixture(t);
  transcripts.shutdown();
  await pane.ready;
  assert.deepEqual(calls, []);
  assert.equal(existsSync(pane.file), false);
});
