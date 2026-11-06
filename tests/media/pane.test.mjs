import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getCapabilities, setCapabilities } from '@earendil-works/pi-tui';
import media from '../../extensions/media/index.ts';
import { mediaEntryType } from '../../extensions/media/media.ts';

const plain = { fg: (/** @type {string} */ _color, /** @type {string} */ text) => text };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vYQAAAAASUVORK5CYII=', 'base64');
const reply = (/** @type {string} */ id, /** @type {string} */ text) => ({ type: 'message', id, message: { role: 'assistant', content: [{ type: 'text', text }] } });

/** @param {import('node:test').TestContext} t @param {string | undefined} socket @param {(command: string, args: string[]) => Promise<any>} exec */
async function setup(t, socket, exec) {
  const original = { socket: process.env.CMUX_SOCKET_PATH, workspace: process.env.CMUX_WORKSPACE_ID, capabilities: getCapabilities() };
  if (socket === undefined) delete process.env.CMUX_SOCKET_PATH;
  else process.env.CMUX_SOCKET_PATH = socket;
  process.env.CMUX_WORKSPACE_ID = 'workspace:1';
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-media-pane-'));
  const store = join(cwd, 'store');
  await writeFile(join(cwd, 'a.png'), png);
  /** @type {any[]} */
  let branch = [];
  const hooks = new Map();
  const renders = new Map();
  const commands = new Map();
  /** @type {string[]} */
  const notices = [];
  const pi = {
    on: (/** @type {string} */ name, /** @type {Function} */ handler) => hooks.set(name, handler),
    registerEntryRenderer: (/** @type {string} */ name, /** @type {Function} */ render) => renders.set(name, render),
    registerCommand: (/** @type {string} */ name, /** @type {any} */ command) => commands.set(name, command),
    appendEntry: (/** @type {string} */ customType, /** @type {any} */ data) => branch.push({ type: 'custom', customType, data }),
  };
  media(/** @type {any} */ (pi), store, 1024 ** 3, /** @type {any} */ (exec));
  const ctx = { mode: 'tui', cwd, sessionManager: { getBranch: () => branch }, ui: { notify: (/** @type {string} */ value) => notices.push(value) } };
  t.after(async () => {
    await hooks.get('session_shutdown')?.({}, ctx);
    await rm(cwd, { recursive: true, force: true });
    if (original.socket === undefined) delete process.env.CMUX_SOCKET_PATH; else process.env.CMUX_SOCKET_PATH = original.socket;
    if (original.workspace === undefined) delete process.env.CMUX_WORKSPACE_ID; else process.env.CMUX_WORKSPACE_ID = original.workspace;
    setCapabilities(original.capabilities);
  });
  return {
    notices,
    async start() { await hooks.get('session_start')?.({}, ctx); },
    seed(/** @type {any[]} */ entries) { branch = entries; },
    async tree(/** @type {any[]} */ entries) { branch = entries; await hooks.get('session_tree')?.({}, ctx); },
    async add(/** @type {string} */ id, text = './a.png') { branch.push(reply(id, text)); await hooks.get('agent_settled')?.({}, ctx); },
    async command() { await commands.get('media').handler('', ctx); },
    header() { return renders.get(mediaEntryType)(branch.at(-1), {}, plain).render(500)[0]; },
    async feed() { const url = /http:\/\/127\.0\.0\.1:\d+\/[\w-]+\//u.exec(this.header())?.[0] || notices.at(-1); return { url, response: await fetch(`${url}feed.json`) }; },
    shutdown: () => hooks.get('session_shutdown')?.({}, ctx),
    entry: (/** @type {string} */ id, /** @type {string} */ text, /** @type {any} */ data) => [reply(id, text), { type: 'custom', customType: mediaEntryType, data }],
  };
}

test('resume rebuilds the feed, tree navigation replaces it, and shutdown closes the server', async (t) => {
  const session = await setup(t, undefined, async () => { throw Error('not in cmux'); });
  const turn = { replyId: 'old', at: '2026-01-01T00:00:00Z', items: [], skipped: ['oversize.pdf'] };
  session.seed(session.entry('old', 'Old\u0007 reply\nsecond line', turn));
  await session.start();
  const { url, response } = await session.feed();
  assert.equal(response.status, 200);
  assert.equal((/** @type {any} */ (await response.json())).turns[0].excerpt, 'Old reply');
  assert.match(session.header(), /#turn-old/u);
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  assert.match(session.header(), /\u001b\]8;;http:\/\/127\.0\.0\.1:/u);
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  await session.tree([]);
  assert.deepEqual((/** @type {any} */ (await (await fetch(`${url}feed.json`)).json())).turns, []);
  await session.shutdown();
  await session.shutdown();
  assert.ok(url);
  await assert.rejects(fetch(url));
});

test('tree navigation to media starts the server from an empty session', async (t) => {
  const session = await setup(t, undefined, async () => { throw Error('not in cmux'); });
  await session.start();
  const turn = { replyId: 'old', at: '2026-01-01T00:00:00Z', items: [], skipped: ['oversize.pdf'] };
  await session.tree(session.entry('old', 'Old reply', turn));
  assert.equal((await session.feed()).response.status, 200);
});

test('local pane opens once, reuses its URL, and reopens when the surface is gone', async (t) => {
  /** @type {Array<[string, string[]]>} */
  const calls = [];
  let available = true;
  const session = await setup(t, '/tmp/cmux.sock', async (command, args) => {
    calls.push([command, args]);
    if (args.includes('get-url')) return { code: available ? 0 : 1, stdout: available ? JSON.stringify({ url: calls[0][1][3] }) : '', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ surface_ref: `surface:${calls.length}` }), stderr: '' };
  });
  await session.start();
  await session.add('one');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 3), ['--json', 'browser', 'open-split']);
  assert.deepEqual(calls[0][1].slice(-4), ['--workspace', 'workspace:1', '--focus', 'false']);
  await session.add('two');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].slice(0, 3), ['--json', 'browser', 'surface:1']);
  available = false;
  await session.command();
  assert.equal(calls.length, 4);
  assert.equal(calls[3][1][2], 'open-split');
  assert.match(session.notices[0], /^http:\/\/127\.0\.0\.1:/u);
});

test('a failed local open keeps the link and retries on the next media turn', async (t) => {
  let calls = 0;
  const session = await setup(t, '/tmp/cmux.sock', async () => {
    calls++;
    return calls === 1 ? { code: 1, stdout: '', stderr: 'unavailable' }
      : { code: 0, stdout: JSON.stringify({ surface_ref: 'surface:next' }), stderr: '' };
  });
  await session.add('one');
  assert.match(session.header(), /http:\/\/127\.0\.0\.1:/u);
  await session.add('two');
  assert.equal(calls, 2);
});

test('remote relay never executes and denial stops later open attempts', async (t) => {
  const remoteCalls = [];
  const remote = await setup(t, '127.0.0.1:8765', async (...args) => { remoteCalls.push(args); throw Error('remote executed'); });
  await remote.add('one');
  await remote.command();
  assert.equal(remoteCalls.length, 0);
});

test('a denied open stays a link and never retries after the relay rejects it', async (t) => {
  let calls = 0;
  const session = await setup(t, '/tmp/cmux.sock', async () => { calls++; return { code: 1, stdout: '', stderr: 'remote_relay_denied' }; });
  await session.add('one');
  await session.add('two');
  await session.command();
  assert.equal(calls, 1);
  assert.match(session.header(), /http:\/\/127\.0\.0\.1:/u);
});
