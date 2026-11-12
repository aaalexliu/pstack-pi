import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import pstack from '../../extensions/pstack/index.ts';
import { readEnoentNote, suggestCloseMatches } from '../../extensions/pstack/read-suggestions.ts';

/** @param {string} cwd @param {string} path */
async function readMiss(cwd, path) {
  const tool = createReadTool(cwd);
  try {
    await tool.execute('read-miss', { path });
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return /** @type {Error} */ (error).message;
  }
  assert.fail(`read ${path} should fail`);
}

/** @param {string} message @param {string} path @param {string} [toolName] */
function missEvent(message, path, toolName = 'read') {
  return {
    toolName,
    isError: true,
    input: { path },
    content: [{ type: 'text', text: message }],
  };
}

test('suggests the other extension before a closer name, and skips names farther than 3', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  try {
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'widget.js'), 'js');
    await writeFile(join(cwd, 'src', 'widget.mjs'), 'mjs');
    await writeFile(join(cwd, 'src', 'widget'), 'bare');
    await writeFile(join(cwd, 'src', 'widgat.ts'), 'one edit');
    await writeFile(join(cwd, 'src', 'abcget.ts'), 'three edits');
    await writeFile(join(cwd, 'src', 'abcdet.ts'), 'four edits');
    await writeFile(join(cwd, 'src', 'widget.ts.bak'), 'longer');
    await writeFile(join(cwd, 'src', 'unrelated.ts'), 'no');
    const message = await readMiss(cwd, 'src/widget.ts');
    assert.match(message, /^ENOENT:/u);
    assert.equal(readEnoentNote(missEvent(message, 'src/widget.ts'), cwd), [
      'Close matches:',
      'src/widget',
      'src/widget.js',
      'src/widget.mjs',
      'src/widgat.ts',
      'src/abcget.ts',
    ].join('\n'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('walks to the nearest existing parent and marks directories', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  try {
    await mkdir(join(cwd, 'extensions'));
    await writeFile(join(cwd, 'extensions', 'index.ts'), 'ts');
    await symlink(join(cwd, 'extensions', 'index.ts'), join(cwd, 'index.js'));
    const message = await readMiss(cwd, 'additions/extensions');
    assert.equal(readEnoentNote(missEvent(message, 'additions/extensions'), cwd), 'Close matches:\nextensions/');
    const nested = await readMiss(cwd, 'gone/nested/index.ts');
    assert.equal(readEnoentNote(missEvent(nested, 'gone/nested/index.ts'), cwd), 'Close matches:\nindex.js');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('keeps absolute requests absolute and strips one @ prefix', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  try {
    await writeFile(join(cwd, 'notes.md'), 'md');
    const absolute = join(cwd, 'notes.ts');
    const message = await readMiss(cwd, absolute);
    assert.deepEqual(suggestCloseMatches(absolute, cwd), [join(cwd, 'notes.md')]);
    assert.equal(readEnoentNote(missEvent(message, '@notes.ts'), cwd), 'Close matches:\nnotes.md');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('caps at 10 and spends the cap on same-stem matches first', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  try {
    const stem = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map((letter) => `target.${letter}`);
    for (const name of stem) await writeFile(join(cwd, name), name);
    for (const name of ['targeX.ts', 'targat.ts', 'targbt.ts']) await writeFile(join(cwd, name), name);
    const matches = suggestCloseMatches('target.ts', cwd);
    assert.deepEqual(matches, stem.slice(0, 10));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('leaves other failures and other tools unchanged', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  try {
    await writeFile(join(cwd, 'notes.md'), 'line\n');
    const tool = createReadTool(cwd);
    const offset = await tool.execute('offset', { path: 'notes.md', offset: 9 }).then(() => '', (/** @type {Error} */ error) => error.message);
    assert.match(offset, /beyond end of file/u);
    assert.equal(readEnoentNote(missEvent(String(offset), 'notes.md'), cwd), undefined);
    assert.equal(readEnoentNote(missEvent('EACCES: permission denied, access \'/secret\'', 'notes.ts'), cwd), undefined);
    assert.equal(readEnoentNote(missEvent('ENOENT: no such file or directory, open \'/missing\'', 'notes.ts', 'grep'), cwd), undefined);
    assert.equal(readEnoentNote({ toolName: 'read', isError: false, input: { path: 'notes.ts' }, content: [{ type: 'text', text: 'ENOENT: mentioned in the file' }] }, cwd), undefined);
    assert.equal(readEnoentNote(missEvent('ENOENT: no such file or directory, access \'/missing\'', ''), cwd), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('returns no note when the parent cannot be listed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  const secret = join(cwd, 'secret');
  try {
    await mkdir(secret);
    await writeFile(join(secret, 'hidden.js'), 'js');
    await chmod(secret, 0);
    assert.deepEqual(suggestCloseMatches('secret/hidden.ts', cwd), []);
  } finally {
    await chmod(secret, 0o700);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('pstack appends the matches ahead of the papercut trailer', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pstack-read-suggest-'));
  try {
    await writeFile(join(cwd, 'widget.js'), 'js');
    const message = await readMiss(cwd, 'widget.ts');
    /** @type {Record<string, ((event: any, ctx?: any) => any)[]>} */
    const handlers = {};
    pstack(/** @type {any} */ ({
      on(/** @type {string} */ name, /** @type {any} */ handler) {
        (handlers[name] ??= []).push(handler);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    }));
    const event = { type: 'tool_result', toolCallId: 'read-1', ...missEvent(message, 'widget.ts') };
    for (const handler of handlers.tool_execution_start ?? []) handler({ toolCallId: 'read-1', toolName: 'read' });
    let content = event.content;
    for (const handler of handlers.tool_result ?? []) {
      const patch = await handler({ ...event, content }, { cwd });
      if (patch?.content) content = patch.content;
    }
    const text = content.map((/** @type {{text?: string}} */ block) => block.text ?? '').join('\n');
    assert.match(text, /^ENOENT:.*\nClose matches:\nwidget\.js\n\[pstack: read \d+ms \d+B failed\]$/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
