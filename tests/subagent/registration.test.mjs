import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import extension from '../../extensions/subagent/index.ts';
import { subagentParameters } from '../../extensions/subagent/domain.ts';

function registration() {
  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof subagentParameters>[]} */
  const tools = [];
  /** @type {PropertyKey[]} */
  const calls = [];
  const api = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), {
    get(_target, name) {
      calls.push(name);
      assert.equal(name, 'registerTool', `Forbidden API access: ${String(name)}`);
      return (/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<typeof subagentParameters>} */ tool) => tools.push(tool);
    },
  });
  extension(api);
  assert.deepEqual(calls, ['registerTool']);
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'subagent');
  assert.equal(tool.parameters, subagentParameters);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['agent', 'cwd', 'task']);
  return tool;
}

test('fake ExtensionAPI sees one registerTool and no event, command, flag, or UI access', () => { registration(); });

test('execute rejects unknown agents, malformed user agents, cwd changes, and injected trust fields before spawn', async (t) => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  await mkdir(path.join(profile, 'agents'), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const tool = registration();
  const ctx = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({}), {
    get(_target, name) {
      assert.equal(name, 'cwd', `Runtime reached unexpected context access: ${String(name)}`);
      return root;
    },
  });
  await assert.rejects(tool.execute('call', { agent: 'unknown', task: 'task' }, undefined, undefined, ctx), /Unknown agent/);
  await assert.rejects(tool.execute('call', { agent: 'general-purpose', task: 'task', cwd: profile }, undefined, undefined, ctx), /differs/);
  await assert.rejects(tool.execute('call', JSON.parse('{"agent":"general-purpose","task":"task","confirmProjectAgents":false}'), undefined, undefined, ctx), /Invalid single/);
  await writeFile(path.join(profile, 'agents/general-purpose.md'), 'malformed');
  await assert.rejects(tool.execute('call', { agent: 'general-purpose', task: 'task' }, undefined, undefined, ctx), /Invalid agent catalog/);
});
