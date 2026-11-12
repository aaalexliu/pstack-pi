import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, opendir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { registerReadCloseMatches } from '../../extensions/pstack/read-close-matches.ts';

function handler() {
  /** @type {Map<string, (event: any, ctx: any) => Promise<any>>} */
  const handlers = new Map();
  registerReadCloseMatches(/** @type {any} */ ({
    on(/** @type {string} */ name, /** @type {any} */ fn) { handlers.set(name, fn); },
  }));
  const fn = handlers.get('tool_result');
  assert.ok(fn);
  return fn;
}

const onReadError = handler();

/** @param {string} cwd @param {string} requestPath */
async function readFailure(cwd, requestPath) {
  const tool = createReadTool(cwd);
  try {
    await tool.execute('call', { path: requestPath });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail(`read succeeded: ${requestPath}`);
}

/** @param {string} requestPath @param {string} message */
function enoentEvent(requestPath, message) {
  return {
    type: 'tool_result',
    toolName: 'read',
    toolCallId: 'call',
    input: { path: requestPath },
    content: [{ type: 'text', text: message }],
    details: undefined,
    isError: true,
  };
}

/** @param {(root: string) => Promise<void>} fn */
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'read-close-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** @param {string} directory */
async function directoryOrder(directory) {
  const names = [];
  const handle = await opendir(directory);
  for await (const entry of handle) names.push(entry.name);
  return names;
}

/** @param {string} name */
function stemOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** @param {any} result */
function suggested(result) {
  assert.equal(result.content.length, 2);
  const lines = result.content[1].text.split('\n');
  assert.equal(lines[0], 'Closest existing paths:');
  return lines.slice(1);
}

test('a .ts guess for an existing .js file lists the .js path first', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'widget.js'), 'export const n = 1;\n');
    await writeFile(join(root, 'widget.md'), '# widget\n');
    await writeFile(join(root, 'widgt.ts'), 'export const n = 2;\n');
    await writeFile(join(root, 'readme.txt'), 'far\n');
    const message = await readFailure(root, 'widget.ts');
    assert.match(message, /^ENOENT: no such file or directory, access '/u);
    const event = enoentEvent('widget.ts', message);
    const result = await onReadError(event, { cwd: root });
    assert.equal(result.content[0].text, message);
    assert.equal(result.isError, undefined);
    assert.deepEqual(suggested(result), ['widget.js', 'widget.md', 'widgt.ts']);
  });
});

test('a path containing a quote still lists the same-stem file', async () => {
  await withRoot(async (root) => {
    const folder = join(root, "qu'ote");
    await mkdir(folder);
    await writeFile(join(folder, 'widget.js'), 'export const n = 1;\n');
    const requestPath = "qu'ote/widget.ts";
    const message = await readFailure(root, requestPath);
    const result = await onReadError(enoentEvent(requestPath, message), { cwd: root });
    assert.deepEqual(suggested(result), ["qu'ote/widget.js"]);
  });
});

test('a missing middle folder ranks the missing segment, not a file from higher up', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'src', 'foo', 'bar'), { recursive: true });
    await mkdir(join(root, 'foo'));
    await writeFile(join(root, 'src', 'foo', 'a.ts'), 'ts\n');
    await writeFile(join(root, 'src', 'foo', 'bar', 'a.ts'), 'ts\n');
    await writeFile(join(root, 'src', 'index.js'), 'js\n');
    await writeFile(join(root, 'src', 'widget.js'), 'js\n');
    await writeFile(join(root, 'index.js'), 'js\n');
    await writeFile(join(root, 'foo', 'a.ts'), 'other tree\n');

    const typo = await readFailure(root, 'src/fo/a.ts');
    assert.match(typo, /^ENOENT: no such file or directory, access '/u);
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/fo/a.ts', typo), { cwd: root })), ['src/foo/']);

    const slash = await readFailure(root, 'src/fo/');
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/fo/', slash), { cwd: root })), ['src/foo/']);

    const wrongDepth = await readFailure(root, 'src/bar/index.ts');
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/bar/index.ts', wrongDepth), { cwd: root })), ['src/foo/']);

    const exactLeaf = await readFailure(root, 'src/bar/index.js');
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/bar/index.js', exactLeaf), { cwd: root })), ['src/foo/']);

    const deeper = await readFailure(root, 'src/foo/ba/a.ts');
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/foo/ba/a.ts', deeper), { cwd: root })), ['src/foo/bar/']);

    const leafFile = await readFailure(root, 'src/foo/missing/a.ts');
    assert.equal(await onReadError(enoentEvent('src/foo/missing/a.ts', leafFile), { cwd: root }), undefined);

    const asDir = await readFailure(root, 'src/widget.ts/extra');
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/widget.ts/extra', asDir), { cwd: root })), ['src/widget.js']);
  });
});

test('a missing folder under a wrong parent lists that folder with a trailing slash', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'library'));
    await writeFile(join(root, 'library', 'note.txt'), 'x\n');
    const message = await readFailure(root, 'wrong-parent/library');
    const result = await onReadError(enoentEvent('wrong-parent/library', message), { cwd: root });
    assert.deepEqual(suggested(result), ['library/']);
  });
});

test('a directory suggestion ends with a slash and a file suggestion does not', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'widget'));
    await writeFile(join(root, 'widget.js'), 'js\n');
    const message = await readFailure(root, 'widget.ts');
    const result = await onReadError(enoentEvent('widget.ts', message), { cwd: root });
    assert.deepEqual(suggested(result), ['widget/', 'widget.js']);
  });
});

test('a folder that is both a close name and the exact leaf is listed once', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'foo'));
    const message = await readFailure(root, 'fx/foo');
    const result = await onReadError(enoentEvent('fx/foo', message), { cwd: root });
    assert.deepEqual(suggested(result), ['foo/']);
  });
});

test('a broken symlink is never a close folder, and a live folder symlink is', async () => {
  await withRoot(async (root) => {
    const src = join(root, 'src');
    await mkdir(src);
    await symlink('missing-target', join(src, 'foo'));
    const danglingFolder = await readFailure(root, 'src/fo/a.ts');
    assert.equal(await onReadError(enoentEvent('src/fo/a.ts', danglingFolder), { cwd: root }), undefined);

    await rm(join(src, 'foo'));
    await mkdir(join(root, 'real-foo'));
    await symlink(join(root, 'real-foo'), join(src, 'foo'));
    const liveFolder = await readFailure(root, 'src/fo/a.ts');
    assert.deepEqual(suggested(await onReadError(enoentEvent('src/fo/a.ts', liveFolder), { cwd: root })), ['src/foo/']);

    await symlink('missing-target', join(root, 'extensions'));
    const danglingLeaf = await readFailure(root, 'additions/extensions');
    assert.equal(await onReadError(enoentEvent('additions/extensions', danglingLeaf), { cwd: root }), undefined);

    await rm(join(root, 'extensions'));
    await mkdir(join(root, 'real-ext'));
    await symlink(join(root, 'real-ext'), join(root, 'extensions'));
    const liveLeaf = await readFailure(root, 'additions/extensions');
    assert.deepEqual(suggested(await onReadError(enoentEvent('additions/extensions', liveLeaf), { cwd: root })), ['extensions/']);
  });
});

test('a missing file with no near names adds nothing past the list cap', async () => {
  await withRoot(async (root) => {
    for (let i = 0; i < 12; i++) await writeFile(join(root, `aaaaaaaa${i}.ts`), 'far\n');
    const message = await readFailure(root, 'zzzzzzzz.ts');
    const event = enoentEvent('zzzzzzzz.ts', message);
    assert.equal(await onReadError(event, { cwd: root }), undefined);
  });
});

test('a same-stem file past the first 1024 directory entries is listed first', async () => {
  await withRoot(async (root) => {
    /** @param {string} prefix @param {number} count @param {string} ext */
    const writeSet = async (prefix, count, ext) => {
      const batch = 64;
      for (let offset = 0; offset < count; offset += batch) {
        const size = Math.min(batch, count - offset);
        await Promise.all(Array.from({ length: size }, (_, index) => {
          const id = offset + index;
          return writeFile(join(root, `${prefix}-${String(id).padStart(5, '0')}.${ext}`), 'x\n');
        }));
      }
    };
    await writeSet('pad', 1024, 'txt');
    await writeSet('kept', 1026, 'js');
    const names = await directoryOrder(root);
    const sameStemName = names.find((name, index) => index > 1024 && stemOf(name).startsWith('kept-'));
    assert.equal(typeof sameStemName, 'string', `directory order did not place a kept name past index 1024`);
    const keptName = /** @type {string} */ (sameStemName);
    const index = names.indexOf(keptName);
    assert.ok(index > 1024, `directory order placed ${keptName} at index ${index}`);
    assert.deepEqual(names.filter((name) => stemOf(name) === stemOf(keptName)), [keptName]);
    const missing = `${stemOf(keptName)}.ts`;
    const message = await readFailure(root, missing);
    const result = await onReadError(enoentEvent(missing, message), { cwd: root });
    assert.equal(suggested(result)[0], keptName);
  });
});

test('a dangling same-stem symlink is omitted and a live symlink is listed', async () => {
  await withRoot(async (root) => {
    await symlink('missing-target', join(root, 'widget.js'));
    const ownMessage = await readFailure(root, 'widget.js');
    assert.equal(await onReadError(enoentEvent('widget.js', ownMessage), { cwd: root }), undefined);
    await writeFile(join(root, 'real.js'), 'export const n = 1;\n');
    await symlink('real.js', join(root, 'widget.md'));
    const message = await readFailure(root, 'widget.ts');
    const result = await onReadError(enoentEvent('widget.ts', message), { cwd: root });
    assert.deepEqual(suggested(result), ['widget.md']);
    const again = await onReadError(enoentEvent('widget.js', ownMessage), { cwd: root });
    assert.deepEqual(suggested(again), ['widget.md']);
  });
});

test('same-stem matches stop at 10 paths', async () => {
  await withRoot(async (root) => {
    const names = Array.from({ length: 12 }, (_, index) => `item.${String.fromCharCode(97 + index)}`);
    for (const name of names) await writeFile(join(root, name), 'x\n');
    const message = await readFailure(root, 'item.ts');
    const result = await onReadError(enoentEvent('item.ts', message), { cwd: root });
    assert.deepEqual(suggested(result), names.slice(0, 10));
  });
});

test('a special relative suggestion reads the fixture, not a rewritten path', async () => {
  /** @param {string} root @param {string} requestPath */
  const readSuggested = async (root, requestPath) => {
    const message = await readFailure(root, requestPath);
    const result = await onReadError(enoentEvent(requestPath, message), { cwd: root });
    const tool = createReadTool(root);
    const read = await tool.execute('call', { path: suggested(result)[0] });
    return /** @type {{ text: string }} */ (read.content[0]).text;
  };
  await withRoot(async (root) => {
    await writeFile(join(root, '@config.js'), 'at-config\n');
    await writeFile(join(root, 'config.js'), 'plain-config\n');
    assert.equal(await readSuggested(root, './@config.ts'), 'at-config\n');
  });
  await withRoot(async (root) => {
    await writeFile(join(root, '~'), 'tilde-file\n');
    assert.equal(await readSuggested(root, '~.ts'), 'tilde-file\n');
  });
  await withRoot(async (root) => {
    const folder = join(root, '~');
    await mkdir(folder);
    await writeFile(join(folder, 'widget.js'), 'tilde-dir\n');
    assert.equal(await readSuggested(root, './~/widget.ts'), 'tilde-dir\n');
  });
});

test('an absolute missing path lists absolute close paths', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'widget.js'), 'export const n = 1;\n');
    const requestPath = join(root, 'widget.ts');
    const message = await readFailure(root, requestPath);
    const result = await onReadError(enoentEvent(requestPath, message), { cwd: root });
    assert.deepEqual(suggested(result), [join(root, 'widget.js')]);
  });
  await withRoot(async (root) => {
    await mkdir(join(root, 'src', 'foo'), { recursive: true });
    const requestPath = join(root, 'src', 'fo', 'a.ts');
    const message = await readFailure(root, requestPath);
    const result = await onReadError(enoentEvent(requestPath, message), { cwd: root });
    assert.deepEqual(suggested(result), [`${join(root, 'src', 'foo')}/`]);
  });
});

test('a successful read is untouched, including text that mentions ENOENT', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'ok.txt'), "ENOENT: no such file or directory, access '/tmp/nope'\n");
    const tool = createReadTool(root);
    const read = await tool.execute('call', { path: 'ok.txt' });
    const event = {
      type: 'tool_result',
      toolName: 'read',
      toolCallId: 'call',
      input: { path: 'ok.txt' },
      content: read.content,
      details: read.details,
      isError: false,
    };
    assert.equal(await onReadError(event, { cwd: root }), undefined);
  });
});

test('a non-ENOENT read error and a missing path from another tool stay unchanged', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'ok.txt'), 'hi\n');
    await writeFile(join(root, 'ok.js'), 'near\n');
    let offsetMessage = '';
    const tool = createReadTool(root);
    try {
      await tool.execute('call', { path: 'ok.txt', offset: 9 });
    } catch (error) {
      offsetMessage = error instanceof Error ? error.message : String(error);
    }
    assert.match(offsetMessage, /beyond end of file/u);
    const offset = {
      type: 'tool_result',
      toolName: 'read',
      toolCallId: 'call',
      input: { path: 'ok.txt', offset: 9 },
      content: [{ type: 'text', text: offsetMessage }],
      isError: true,
    };
    assert.equal(await onReadError(offset, { cwd: root }), undefined);
    const bash = {
      type: 'tool_result',
      toolName: 'bash',
      toolCallId: 'call',
      input: { command: 'cat ok.ts' },
      content: [{ type: 'text', text: `ENOENT: no such file or directory, access '${join(root, 'ok.ts')}'` }],
      isError: true,
    };
    assert.equal(await onReadError(bash, { cwd: root }), undefined);
  });
});

test('an unreadable nearest parent adds nothing', async () => {
  await withRoot(async (root) => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await writeFile(join(root, 'missing.js'), 'would match if the walk skipped locked\n');
    await chmod(locked, 0o000);
    try {
      const message = `ENOENT: no such file or directory, access '${join(locked, 'missing.ts')}'`;
      const result = await onReadError(enoentEvent('locked/missing.ts', message), { cwd: root });
      assert.equal(result, undefined);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

test('an aborted read adds nothing', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'widget.js'), 'export const n = 1;\n');
    const message = await readFailure(root, 'widget.ts');
    const signal = AbortSignal.abort();
    assert.equal(await onReadError(enoentEvent('widget.ts', message), { cwd: root, signal }), undefined);
  });
});
