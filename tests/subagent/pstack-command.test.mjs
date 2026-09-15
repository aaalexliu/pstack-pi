import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pstack from '../../extensions/pstack/index.ts';

test('/pstack shows fresh config and edit path without writing or calling a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-command-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const commands = new Map();
    pstack(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ (/** @type {unknown} */ ({
      on() {}, registerTool() {},
      /** @param {string} name @param {unknown} command */
      registerCommand(name, command) { commands.set(name, command); },
    })));
    const command = commands.get('pstack');
    assert.ok(command);
    /** @type {{text: string, level: string}[]} */
    const messages = [];
    const latest = () => {
      const message = messages.at(-1);
      assert.ok(message);
      return message;
    };
    const ctx = { ui: {
      /** @param {string} text @param {string} level */
      notify(text, level) { messages.push({ text, level }); },
    } };
    const path = join(root, 'pstack-pi', 'models.json');
    await command.handler('', ctx);
    assert.ok(latest().text.includes(path));
    assert.ok(latest().text.includes('"roles": {}'));
    await assert.rejects(readFile(path), { code: 'ENOENT' });

    await mkdir(join(root, 'pstack-pi'));
    const config = JSON.stringify({ version: 1, roles: { review: ['inherit-parent', 'test/model', 'test/model'] } });
    await writeFile(path, config);
    await command.handler('', ctx);
    assert.ok(latest().text.includes(JSON.stringify(JSON.parse(config), null, 2)));
    assert.equal(await readFile(path, 'utf8'), config);

    await writeFile(path, '{broken');
    await command.handler('', ctx);
    assert.equal(latest().level, 'error');
    assert.ok(latest().text.includes(path));
    assert.ok(latest().text.includes('Cannot read pstack config'));
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
