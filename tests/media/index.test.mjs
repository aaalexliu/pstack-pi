import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { getCapabilities, Image, setCapabilities } from '@earendil-works/pi-tui';
import media from '../../extensions/media/index.ts';
import { mediaEntryType } from '../../extensions/media/media.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vYQAAAAASUVORK5CYII=', 'base64');
const plain = { fg: (/** @type {string} */ _color, /** @type {string} */ text) => text };
const active = new Set();
afterEach(async () => { for (const session of active) await session.shutdown(); active.clear(); });

/** @param {string} text @param {string} [id] */
function reply(text, id = 'reply-1') {
  return { type: 'message', id, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '/tmp/hidden.png' }, { type: 'text', text }] } };
}

/** @param {string} root @param {string} cwd @param {{mode?: string, branch?: any[], limit?: number, renderer?: boolean}} [options] */
function harness(root, cwd, { mode = 'tui', branch = [], limit = 1024 ** 3, renderer = true } = {}) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  /** @type {Map<string, Function>} */
  const renderers = new Map();
  /** @type {string[]} */
  const rules = [];
  const pi = {
    on(/** @type {string} */ name, /** @type {Function} */ handler) { handlers.set(name, handler); },
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
    registerCommand(/** @type {string} */ _name, /** @type {any} */ _definition) {},
    appendEntry(/** @type {string} */ customType, /** @type {any} */ data) { branch.push({ type: 'custom', customType, data }); },
    ...(renderer ? { registerEntryRenderer(/** @type {string} */ name, /** @type {Function} */ render) { renderers.set(name, render); } } : {}),
  };
  media(/** @type {any} */ (pi), root, limit);
  const ctx = { mode, cwd, sessionManager: { getBranch: () => branch } };
  const session = {
    branch, rules, renderers,
    start() { handlers.get('before_agent_start')?.({ systemPromptOptions: { promptGuidelines: rules } }, ctx); },
    settle(/** @type {boolean} */ aborted = false) { return handlers.get('agent_settled')?.({ aborted }, ctx); },
    shutdown() { return handlers.get('session_shutdown')?.({}, ctx); },
    turns() { return branch.filter((entry) => entry.customType === mediaEntryType).map((entry) => entry.data); },
  };
  active.add(session);
  return session;
}

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-media-test-'));
  const store = join(cwd, 'store');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, store };
}

test('one settled reply keeps the before/after pair, video and PDF in citation order', async (t) => {
  const { cwd, store } = await fixture(t);
  for (const [name, bytes] of /** @type {Array<[string, Buffer]>} */ ([['before.png', png], ['after.jpg', Buffer.from('after')], ['clip.mp4', Buffer.from('video')], ['report.pdf', Buffer.from('pdf')]])) await writeFile(join(cwd, name), bytes);
  const pi = harness(store, cwd, { branch: [reply(`![before](${join(cwd, 'before.png')} "title") [after](<${join(cwd, 'after.jpg')}>) [clip](./clip.mp4) [report](./report.pdf)`)] });
  await pi.settle();
  assert.equal(pi.turns().length, 1);
  const turn = pi.turns()[0];
  assert.equal(turn.replyId, 'reply-1');
  assert.ok(!Number.isNaN(Date.parse(turn.at)));
  assert.deepEqual(turn.items.map((/** @type {any} */ item) => [item.kind, item.mime, item.caption, item.name]), [
    ['image', 'image/png', 'before', 'before.png'],
    ['image', 'image/jpeg', 'after', 'after.jpg'],
    ['video', 'video/mp4', 'clip', 'clip.mp4'],
    ['pdf', 'application/pdf', 'report', 'report.pdf'],
  ]);
  for (const item of turn.items) {
    const bytes = await readFile(join(store, item.object));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.object, `${createHash('sha256').update(bytes).digest('hex')}.${item.name.split('.').at(-1)}`);
  }
});

test('citations include inline code and bare paths but not fenced code, URLs, or missing files', async (t) => {
  const { cwd, store } = await fixture(t);
  await mkdir(join(cwd, 'images'));
  await writeFile(join(cwd, 'images', 'one.webp'), png);
  await writeFile(join(cwd, 'two.gif'), png);
  const text = [
    '```md', '![not cited](./two.gif)', '```', '~~~', './two.gif', '~~~',
    '🖼️ `./images/one.webp`, [again](./images/one.webp) and ../missing.pdf',
    `file://${join(cwd, 'two.gif')}, https://example.com/no.png, [remote](https://example.com/no.pdf)`,
    './two.gif. [again](./two.gif)',
  ].join('\n');
  const pi = harness(store, cwd, { branch: [reply(text)] });
  await pi.settle();
  assert.deepEqual(pi.turns()[0].items.map((/** @type {any} */ item) => [item.name, item.caption]), [['one.webp', 'one.webp'], ['two.gif', 'two.gif']]);
});

test('tilde paths resolve from HOME, relative paths resolve from cwd, and first caption wins', async (t) => {
  const { cwd, store } = await fixture(t);
  const home = process.env.HOME;
  process.env.HOME = cwd;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  await writeFile(join(cwd, 'home.png'), png);
  await mkdir(join(cwd, 'child'));
  await writeFile(join(cwd, 'child', 'child.png'), png);
  const pi = harness(store, join(cwd, 'child'), { branch: [reply('![Home](~/home.png) [ignored](../home.png) ../home.png ./child.png [Child](./child.png)')] });
  await pi.settle();
  assert.deepEqual(pi.turns()[0].items.map((/** @type {any} */ item) => [item.name, item.caption]), [['home.png', 'Home'], ['child.png', 'child.png']]);
});

test('the supported formats get their expected MIME types and other extensions are ignored', async (t) => {
  const { cwd, store } = await fixture(t);
  const formats = [
    ['png', 'image', 'image/png'], ['jpg', 'image', 'image/jpeg'], ['jpeg', 'image', 'image/jpeg'],
    ['gif', 'image', 'image/gif'], ['webp', 'image', 'image/webp'],
    ['mp4', 'video', 'video/mp4'], ['mov', 'video', 'video/quicktime'], ['webm', 'video', 'video/webm'],
    ['pdf', 'pdf', 'application/pdf'],
  ];
  for (const [ext] of formats) await writeFile(join(cwd, `sample.${ext}`), png);
  await writeFile(join(cwd, 'ignored.svg'), png);
  const pi = harness(store, cwd, { branch: [reply([...formats.map(([ext]) => `./sample.${ext}`), './ignored.svg'].join(' '))] });
  await pi.settle();
  assert.deepEqual(pi.turns()[0].items.map((/** @type {any} */ item) => [item.kind, item.mime]), formats.map(([, kind, mime]) => [kind, mime]));
});

test('snapshot objects retain old bytes after overwrite and share identical content', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'one.png'), png);
  await writeFile(join(cwd, 'two.png'), png);
  const pi = harness(store, cwd, { branch: [reply('![one](./one.png) ![two](./two.png)')] });
  await pi.settle();
  const [one, two] = pi.turns()[0].items;
  assert.equal(one.object, two.object);
  assert.equal((await readdir(store)).length, 1);
  await writeFile(join(cwd, 'one.png'), Buffer.from('changed'));
  assert.deepEqual(await readFile(join(store, one.object)), png);
  pi.branch.push(reply('![new](./one.png)', 'reply-2'));
  await pi.settle();
  assert.equal(pi.turns().length, 2);
  assert.notEqual(pi.turns()[1].items[0].object, one.object);
  assert.deepEqual(await readFile(join(store, one.object)), png);
});

test('size limit and non-regular files are skipped and named', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'large.png'), Buffer.alloc(200));
  await writeFile(join(cwd, 'small.png'), png);
  await mkdir(join(cwd, 'directory.pdf'));
  const pi = harness(store, cwd, { limit: png.length, branch: [reply('![small](./small.png) ./large.png ./directory.pdf')] });
  await pi.settle();
  assert.deepEqual(pi.turns()[0].skipped, ['large.png', 'directory.pdf']);
  const render = pi.renderers.get(mediaEntryType);
  assert.ok(render);
  assert.match(render(pi.branch.at(-1), {}, plain).render(120)[0], /skipped: large.png, directory.pdf/u);
  assert.deepEqual(pi.turns()[0].items.map((/** @type {any} */ item) => item.name), ['small.png']);
  pi.branch.push(reply('./large.png', 'reply-2'));
  await pi.settle();
  assert.deepEqual(pi.turns()[1].skipped, ['large.png']);
});

test('aborted, non-TUI and repeat settles do not append another entry', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'a.png'), png);
  const branch = [reply('./a.png')];
  await harness(store, cwd, { branch, mode: 'json' }).settle();
  const pi = harness(store, cwd, { branch });
  await pi.settle(true);
  assert.equal(pi.turns().length, 0);
  await pi.settle();
  await pi.settle();
  assert.equal(pi.turns().length, 1);
  assert.equal((await readdir(store)).length, 1);
});

test('guideline is added once and old Pi without a renderer still records media', async (t) => {
  const { cwd, store } = await fixture(t);
  const pi = harness(store, cwd, { renderer: false });
  pi.start();
  pi.start();
  assert.equal(pi.rules.length, 1);
  assert.match(pi.rules[0], /!\[before\]\(\/tmp\/before\.png\)/u);
  await writeFile(join(cwd, 'a.png'), png);
  pi.branch.push(reply('./a.png'));
  await pi.settle();
  assert.equal(pi.turns().length, 1);
});

test('renderer shows only the header without images and bounded thumbnails with images', async (t) => {
  const { cwd, store } = await fixture(t);
  for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']) await writeFile(join(cwd, name), png);
  const pi = harness(store, cwd, { branch: [reply('![A](./a.png) ./b.png ./c.png ./d.png ./e.png')] });
  await pi.settle();
  const render = pi.renderers.get(mediaEntryType);
  assert.ok(render);
  const entry = pi.branch.at(-1);
  const original = getCapabilities();
  t.after(() => setCapabilities(original));
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const off = render(entry, { expanded: false }, plain);
  assert.equal(off.children.length, 1);
  assert.match(off.render(160)[0], /▣ .*5 files: A, b.png, c.png, d.png, e.png/u);
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
  const on = render(entry, { expanded: false }, plain);
  assert.equal(on.children.filter((/** @type {any} */ child) => child instanceof Image).length, 4);
  assert.match(on.render(80).join('\n'), /\+1 more/u);
  const all = render(entry, { expanded: true }, plain);
  assert.equal(all.children.filter((/** @type {any} */ child) => child instanceof Image).length, 5);
  assert.doesNotMatch(all.render(80).join('\n'), /more/u);
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  assert.equal(render(entry, { expanded: false }, plain).render(30).length, 1);
  assert.match(render(entry, { expanded: true }, plain).render(30).join(' '), /e\.png/u);
  assert.ok(on.children.filter((/** @type {any} */ child) => child instanceof Image).every((/** @type {Image} */ image) => image.render(80).length <= 14));
  await rm(join(store, pi.turns()[0].items[0].object));
  const missing = render(entry, { expanded: false }, plain);
  assert.match(missing.render(200)[0], /A \(missing\)/u);
  assert.doesNotMatch(missing.render(80)[0], new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.equal(render({ data: {} }, {}, plain), undefined);
  assert.equal(render({ data: { replyId: 'bad', at: 'now', items: [{ name: 'x', caption: 'x', bytes: 1, object: 3 }] } }, {}, plain), undefined);
});

test('a symlinked file is saved and an unreadable file is skipped without dropping the turn', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'real.png'), png);
  await symlink(join(cwd, 'real.png'), join(cwd, 'link.png'));
  await writeFile(join(cwd, 'locked.png'), png);
  await chmod(join(cwd, 'locked.png'), 0o000);
  const pi = harness(store, cwd, { branch: [reply('![link](./link.png) ![locked](./locked.png)')] });
  await pi.settle();
  const [turn] = pi.turns();
  assert.deepEqual(turn.items.map((/** @type {any} */ item) => item.name), ['link.png']);
  assert.deepEqual(turn.skipped, ['locked.png']);
});

test('Markdown destinations keep parentheses and a longer extension is not cut to a media one', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'plot(1).png'), png);
  await writeFile(join(cwd, 'plot(outer(1)).png'), png);
  await writeFile(join(cwd, 'a.png'), png);
  await writeFile(join(cwd, 'a.png.bak'), png);
  const pi = harness(store, cwd, { branch: [reply(`![plot](${join(cwd, 'plot(1).png')}) [nested](${join(cwd, 'plot(outer(1)).png')} "title") and ${join(cwd, 'a.png.bak')}, see.`)] });
  await pi.settle();
  assert.deepEqual(pi.turns()[0].items.map((/** @type {any} */ item) => [item.caption, item.name]), [['plot', 'plot(1).png'], ['nested', 'plot(outer(1)).png']]);
  pi.branch.push(reply(`then ${join(cwd, 'a.png')}.`, 'reply-2'));
  await pi.settle();
  assert.deepEqual(pi.turns()[1].items.map((/** @type {any} */ item) => item.name), ['a.png']);
});

test('a reply whose only file is skipped still says so under the reply', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'huge.mov'), Buffer.alloc(64));
  const pi = harness(store, cwd, { branch: [reply('[clip](./huge.mov)')], limit: 8 });
  await pi.settle();
  assert.deepEqual(pi.turns(), [{ replyId: 'reply-1', at: pi.turns()[0].at, items: [], skipped: ['huge.mov'] }]);
  const render = pi.renderers.get(mediaEntryType);
  assert.ok(render);
  assert.match(render(pi.branch.at(-1), {}, plain).render(160)[0], /▣ .*skipped: huge\.mov/u);
});

test('media is not attached when the user moves to another branch while files copy', async (t) => {
  const { cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'a.png'), png);
  const branch = [reply('./a.png')];
  const pi = harness(store, cwd, { branch });
  const settling = pi.settle();
  branch.splice(0, branch.length, reply('other branch', 'reply-2'));
  await settling;
  assert.equal(pi.turns().length, 0);
});
