import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CmuxTranscripts, CMUX_TIMEOUT_MS } from '../../extensions/subagent/cmux.ts';

const env = { CMUX_WORKSPACE_ID: 'workspace:7', CMUX_SURFACE_ID: 'surface:2' };

/** @param {import('node:test').TestContext} t @param {import('../../extensions/subagent/cmux.ts').CmuxExec} [exec] */
function fixture(t, exec) {
  const transcripts = new CmuxTranscripts();
  t.after(() => transcripts.shutdown());
  /** @type {string[][]} */
  const calls = [];
  const pane = transcripts.create({ env, label: "agent 'quoted'", exec: exec ?? (async (args, capturedEnv) => {
    calls.push(args);
    assert.deepEqual(capturedEnv, env);
    return JSON.stringify({ pane_id: 'pane-id', pane_ref: 'pane:3', surface_id: 'surface:9' });
  }) });
  assert.ok(pane);
  return { transcripts, pane, calls };
}

// Execute the exact command sent to the pane, including shell quoting.
/** @param {string} command */
function follow(command) {
  const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  const done = once(proc, 'close').then(([code]) => { assert.equal(code, 0); return output; });
  return { proc, done };
}

test('missing cmux environment creates no pane and never invokes cmux', () => {
  const transcripts = new CmuxTranscripts();
  assert.equal(transcripts.create({ env: {}, label: 'agent', exec: async () => { assert.fail('unexpected cmux'); } }), undefined);
  transcripts.shutdown();
});

test('private files, targeted calls, quoting, events and terminal status', { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cmux quote's "));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(root, { recursive: true, force: true }); });
  const { pane, calls } = fixture(t);
  await pane.ready;
  assert.equal(statSync(path.dirname(pane.file)).mode & 0o777, 0o700);
  for (const file of [pane.file, path.join(path.dirname(pane.file), 'follow.cjs')]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(calls[0], ['--json', 'new-split', 'right', '--focus', 'false', '--workspace', 'workspace:7', '--surface', 'surface:2']);
  assert.deepEqual(calls[1].slice(0, -1), ['--json', 'send', '--workspace', 'workspace:7', '--surface', 'surface:9']);
  assert.deepEqual(calls[2], ['--json', 'rename-tab', '--workspace', 'workspace:7', '--surface', 'surface:9', "Subagent: agent 'quoted'"]);
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
  assert.equal(await follow(calls[1][calls[1].length - 1]).done, expected);
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

test('cmux errors, malformed replies and hung commands clean private resources without rejecting', { timeout: 6000 }, async (t) => {
  for (const exec of [async () => { throw new Error('missing cmux'); }, async () => 'not json', async () => '{}', async () => new Promise(() => {})]) {
    const { pane } = fixture(t, exec);
    const started = Date.now();
    await pane.ready;
    assert.ok(Date.now() - started < CMUX_TIMEOUT_MS + 2000);
    assert.equal(existsSync(path.dirname(pane.file)), false);
    pane.event(null);
    pane.finish('Failed');
  }
});

test('failed send removes files and its split; failed rename keeps the working transcript', async (t) => {
  for (const failedCommand of ['send', 'rename-tab']) {
    /** @type {string[][]} */
    const closed = [];
    const { pane } = fixture(t, async (args, _env, signal) => {
      if (args[1] === 'close-surface') {
        assert.equal(signal.aborted, false, 'Cleanup needs a fresh signal');
        closed.push(args);
      }
      if (args[1] === failedCommand) throw new Error('surface closed');
      return JSON.stringify({ pane_ref: 'pane:3', surface_ref: 'surface:9' });
    });
    await pane.ready;
    assert.equal(existsSync(pane.file), failedCommand === 'rename-tab');
    assert.deepEqual(closed, failedCommand === 'send' ? [['--json', 'close-surface', '--workspace', 'workspace:7', '--surface', 'surface:9']] : []);
    pane.finish('Completed');
  }
});

test('shutdown during split creation cleans files even after a late reply', async (t) => {
  /** @type {(value: string) => void} */
  let reply = () => { assert.fail('split not started'); };
  /** @type {string[]} */
  const calls = [];
  const { pane, transcripts } = fixture(t, async (args) => {
    calls.push(args[1]);
    if (args[1] === 'new-split') return new Promise((resolve) => { reply = resolve; });
    return '{}';
  });
  await Promise.resolve();
  transcripts.shutdown();
  reply(JSON.stringify({ pane_id: 'pane-late', surface_id: 'surface:late' }));
  await pane.ready;
  assert.equal(existsSync(path.dirname(pane.file)), false);
  assert.deepEqual(calls, ['new-split', 'close-surface']);
});

for (const concurrent of [true, false]) {
  test(`${concurrent ? 'concurrent' : 'sequential'} runs share one split and allocate background tabs`, async (t) => {
    const transcripts = new CmuxTranscripts();
    t.after(() => transcripts.shutdown());
    /** @type {string[][]} */
    const calls = [];
    /** @type {(() => void) | undefined} */
    let release;
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    /** @type {import('../../extensions/subagent/cmux.ts').CmuxExec} */
    const exec = async (args) => {
      calls.push(args);
      if (args[1] === 'new-split') {
        if (concurrent) await gate;
        return JSON.stringify({ pane_id: 'stable-pane', pane_ref: 'pane:3', surface_id: 'stable-surface', surface_ref: 'surface:9' });
      }
      if (args[1] === 'new-surface') return JSON.stringify({ surface_id: `tab-${calls.length}` });
      return '{}';
    };
    const first = transcripts.create({ env, label: 'first', exec });
    assert.ok(first);
    if (!concurrent) { await first.ready; first.finish('Completed'); }
    const second = transcripts.create({ env, label: 'second', exec });
    const third = transcripts.create({ env, label: 'third', exec });
    assert.ok(second && third);
    second.write('child output before allocation');
    assert.match(readFileSync(second.file, 'utf8'), /child output before allocation/);
    if (concurrent) {
      await Promise.resolve();
      assert.deepEqual(calls.map((args) => args[1]), ['new-split']);
      release?.();
    }
    await Promise.all([first.ready, second.ready, third.ready]);
    assert.equal(calls.filter((args) => args[1] === 'new-split').length, 1);
    assert.deepEqual(calls.filter((args) => args[1] === 'new-surface'), Array.from({ length: 2 }, () =>
      ['--json', 'new-surface', '--type', 'terminal', '--pane', 'stable-pane', '--workspace', 'workspace:7', '--focus', 'false']));
    assert.equal(calls.find((args) => args[1] === 'send')?.[5], 'stable-surface');
    for (const pane of [first, second, third]) { pane.finish('Completed'); assert.ok(existsSync(pane.file)); }
    assert.ok(calls.every((args) => ['new-split', 'new-surface', 'send', 'rename-tab'].includes(args[1])));
  });
}

for (const state of ['missing', 'present', 'query-error', 'malformed', 'unknown-identifiers', 'bad-tab-reply']) {
  test(`failed tab allocation only recreates a confirmed missing pane: ${state}`, async (t) => {
    /** @type {string[][]} */
    const calls = [];
    /** @type {import('../../extensions/subagent/cmux.ts').CmuxExec} */
    const exec = async (args) => {
      calls.push(args);
      if (args[1] === 'new-split') return JSON.stringify({ pane_id: 'stable-pane', pane_ref: 'pane:3', surface_id: 'surface:9' });
      if (args[1] === 'new-surface') {
        if (state === 'bad-tab-reply') return 'not json';
        throw new Error('arbitrary cmux error');
      }
      if (args[1] === 'list-panes') {
        assert.deepEqual(args, ['--json', 'list-panes', '--workspace', 'workspace:7']);
        if (state === 'query-error') throw new Error('query failed');
        if (state === 'malformed') return '{}';
        if (state === 'unknown-identifiers') return JSON.stringify({ panes: [{}] });
        return JSON.stringify({ panes: [{ ref: state === 'present' ? 'pane:3' : 'pane:other' }] });
      }
      return '{}';
    };
    const { transcripts, pane: first } = fixture(t, exec);
    await first.ready;
    first.finish('Completed');
    const next = transcripts.create({ env, label: 'next', exec });
    assert.ok(next);
    await next.ready;
    assert.equal(calls.filter((args) => args[1] === 'new-split').length, state === 'missing' ? 2 : 1);
    assert.equal(existsSync(next.file), state === 'missing');
    assert.ok(existsSync(first.file), 'A tab failure must not remove another transcript');
  });
}

test('slow send does not hold the surface allocation queue', async (t) => {
  /** @type {(() => void) | undefined} */
  let release;
  const gate = new Promise((resolve) => { release = () => resolve('{}'); });
  /** @type {string[]} */
  const calls = [];
  const { transcripts, pane: first } = fixture(t, async (args) => {
    calls.push(args[1]);
    if (args[1] === 'send') return /** @type {Promise<string>} */ (gate);
    return JSON.stringify({ pane_ref: 'pane:3', surface_ref: 'surface:first' });
  });
  const second = transcripts.create({ env, label: 'second', exec: async (args) => {
    calls.push(args[1]);
    return JSON.stringify({ surface_ref: 'surface:second' });
  } });
  assert.ok(second);
  await second.ready;
  assert.equal(calls.filter((cmd) => cmd === 'new-split').length, 1);
  assert.equal(calls.filter((cmd) => cmd === 'new-surface').length, 1);
  release?.();
  await first.ready;
});

test('shutdown skips queued allocations and closes a late-created tab', async (t) => {
  /** @type {(value: string) => void} */
  let reply = () => assert.fail('tab not started');
  /** @type {string[]} */
  const calls = [];
  const { transcripts, pane: first } = fixture(t);
  await first.ready;
  /** @type {import('../../extensions/subagent/cmux.ts').CmuxExec} */
  const exec = async (args) => {
    calls.push(args[1]);
    if (args[1] === 'new-surface') return new Promise((resolve) => { reply = resolve; });
    assert.equal(args[5], 'surface:late');
    return '{}';
  };
  const second = transcripts.create({ env, label: 'second', exec });
  const third = transcripts.create({ env, label: 'third', exec });
  assert.ok(second && third);
  await Promise.resolve();
  transcripts.shutdown();
  reply(JSON.stringify({ surface_ref: 'surface:late' }));
  await Promise.all([second.ready, third.ready]);
  assert.deepEqual(calls, ['new-surface', 'close-surface']);
  for (const pane of [first, second, third]) assert.equal(existsSync(pane.file), false);
});

test('allocation timeout cleans a surface that arrives after ready settles', { timeout: 4000 }, async (t) => {
  /** @type {(value: string) => void} */
  let reply = () => assert.fail('split not started');
  /** @type {string[]} */
  const calls = [];
  const { pane } = fixture(t, async (args) => {
    calls.push(args[1]);
    if (args[1] === 'new-split') return new Promise((resolve) => { reply = resolve; });
    return '{}';
  });
  await pane.ready;
  assert.equal(existsSync(pane.file), false);
  reply(JSON.stringify({ surface_id: 'surface:late' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['new-split', 'close-surface']);
});

test('a closed tab does not stop another transcript or discard the shared pane', async (t) => {
  const { transcripts, pane: first } = fixture(t);
  await first.ready;
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../../extensions/subagent/cmux.ts').CmuxExec} */
  const exec = async (args) => {
    calls.push(args);
    if (args[1] === 'send') throw new Error('user closed tab');
    return JSON.stringify({ surface_ref: 'surface:closed' });
  };
  const closed = transcripts.create({ env, label: 'closed', exec });
  assert.ok(closed);
  await closed.ready;
  first.write('still running');
  first.finish('Completed');
  assert.match(readFileSync(first.file, 'utf8'), /still running\n\[Completed\]/);
  const next = transcripts.create({ env, label: 'next', exec: async (args) => {
    calls.push(args);
    return JSON.stringify({ surface_ref: 'surface:next' });
  } });
  assert.ok(next);
  await next.ready;
  assert.ok(existsSync(next.file));
  assert.equal(calls.filter((args) => args[1] === 'new-surface').length, 2);
  assert.equal(calls.filter((args) => args[1] === 'new-split').length, 0);
  assert.deepEqual(calls.filter((args) => args[1] === 'close-surface'),
    [['--json', 'close-surface', '--workspace', 'workspace:7', '--surface', 'surface:closed']]);
});

test('immediate shutdown never allocates queued surfaces', async (t) => {
  const { transcripts, pane, calls } = fixture(t);
  transcripts.shutdown();
  await pane.ready;
  assert.deepEqual(calls, []);
  assert.equal(existsSync(pane.file), false);
});

test('shutdown removes transcripts and prevents new panes', async (t) => {
  const { pane, transcripts } = fixture(t);
  await pane.ready;
  transcripts.shutdown();
  assert.equal(existsSync(pane.file), false);
  assert.equal(transcripts.create({ env, label: 'late' }), undefined);
});
