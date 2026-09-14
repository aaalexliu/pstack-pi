import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bundledAgents, bundledAgentsDirectory, discoverAgents, parseAgent } from '../../extensions/subagent/agents.ts';

/** @param {string} name @param {string} [extra] @param {string} [body] */
const agentFile = (name, extra = '', body = `Prompt for ${name}.`) => `---\nname: ${name}\ndescription: ${name} agent.\n${extra}---\n${body}\n`;

test('bundled agents parse with their tool lists and prompts', () => {
  const agents = bundledAgents();
  assert.deepEqual(agents.map((a) => a.name).sort(), ['comment-sicko', 'general-purpose', 'poteto-agent']);
  assert.ok(agents.every((a) => a.source === 'bundled' && a.filePath.startsWith(bundledAgentsDirectory) && a.systemPrompt.trim()));
  assert.deepEqual(agents.find((a) => a.name === 'poteto-agent')?.tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
});

test('parseAgent accepts both tool spellings and rejects files without a name or description', () => {
  assert.deepEqual(parseAgent(agentFile('a', 'tools: read, bash\nmodel: fixture/model\n')).tools, ['read', 'bash']);
  assert.deepEqual(parseAgent(agentFile('a', 'tools: [read, bash]\n')).tools, ['read', 'bash']);
  assert.equal(parseAgent(agentFile('a', 'model: fixture/model\n')).model, 'fixture/model');
  assert.equal(parseAgent(agentFile('a')).tools, undefined);
  assert.throws(() => parseAgent('---\ndescription: no name\n---\nbody'), /name/);
  assert.throws(() => parseAgent('---\nname: x\n---\nbody'), /description/);
});

test('discovery layers bundled, user, and project agents by name and skips broken files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agents-'));
  const userDir = path.join(root, 'user');
  const project = path.join(root, 'project', 'nested');
  await mkdir(userDir, { recursive: true });
  await mkdir(path.join(root, 'project', '.pi', 'agents'), { recursive: true });
  await mkdir(project);
  await writeFile(path.join(userDir, 'general-purpose.md'), agentFile('general-purpose', 'tools: [bash]\n', 'USER OVERRIDE'));
  await writeFile(path.join(userDir, 'reviewer.md'), agentFile('reviewer'));
  await writeFile(path.join(userDir, 'broken.md'), '---\nname: [\n---\n');
  await writeFile(path.join(userDir, 'notes.txt'), agentFile('ignored'));
  await writeFile(path.join(root, 'project', '.pi', 'agents', 'reviewer.md'), agentFile('reviewer', '', 'PROJECT OVERRIDE'));
  await writeFile(path.join(root, 'project', '.pi', 'agents', 'local.md'), agentFile('local'));

  const user = discoverAgents(project, 'user', { userDir });
  assert.equal(user.projectAgentsDir, path.join(root, 'project', '.pi', 'agents'));
  assert.deepEqual(user.agents.map((a) => `${a.name}:${a.source}`).sort(), ['comment-sicko:bundled', 'general-purpose:user', 'poteto-agent:bundled', 'reviewer:user']);
  assert.equal(user.agents.find((a) => a.name === 'general-purpose')?.systemPrompt.trim(), 'USER OVERRIDE');

  const both = discoverAgents(project, 'both', { userDir });
  assert.deepEqual(both.agents.map((a) => `${a.name}:${a.source}`).sort(), ['comment-sicko:bundled', 'general-purpose:user', 'local:project', 'poteto-agent:bundled', 'reviewer:project']);
  assert.equal(both.agents.find((a) => a.name === 'reviewer')?.systemPrompt.trim(), 'PROJECT OVERRIDE');

  const projectOnly = discoverAgents(project, 'project', { userDir });
  assert.deepEqual(projectOnly.agents.map((a) => a.name).sort(), ['local', 'reviewer']);

  const none = discoverAgents(root, 'both', { userDir: path.join(root, 'missing') });
  assert.equal(none.projectAgentsDir, null);
  assert.deepEqual(none.agents.map((a) => a.source), ['bundled', 'bundled', 'bundled']);
});
