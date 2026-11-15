import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundledAgentsDirectories, parseAgent } from '../../extensions/subagent/agents.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const installedSkill = path.join(repoRoot, 'skills/poteto-mode/SKILL.md');

/** @param {string} name @param {string} [extra] @param {string} [body] */
const agentFile = (name, extra = '', body = `Prompt for ${name}.`) => `---\nname: ${name}\ndescription: ${name} agent.\n${extra}---\n${body}\n`;

async function bundledAgents() {
  const agents = [];
  for (const dir of bundledAgentsDirectories) {
    for (const name of (await readdir(dir)).filter((file) => file.endsWith('.md'))) {
      agents.push({ ...parseAgent(await readFile(path.join(dir, name), 'utf8')), filePath: path.join(dir, name) });
    }
  }
  return agents;
}

test('bundled agents parse with their tool lists and prompts', async () => {
  const agents = await bundledAgents();
  assert.deepEqual(agents.map((a) => a.name).sort(), ['comment-sicko', 'general-purpose', 'poteto-agent', 'pr-reviewer', 'sub-lead']);
  assert.ok(agents.every((a) => a.systemPrompt.trim()));
  assert.deepEqual(agents.find((a) => a.name === 'poteto-agent')?.tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
  assert.equal(agents.find((a) => a.name === 'general-purpose')?.filePath, path.join(repoRoot, 'additions/agents/general-purpose.md'));
});

test('bundled poteto-agent names the installed poteto-mode skill', async () => {
  await access(installedSkill);
  const prompt = (await bundledAgents()).find((agent) => agent.name === 'poteto-agent')?.systemPrompt ?? '';
  assert.equal(prompt.includes(installedSkill), true);
  assert.equal(prompt.includes('{{PSTACK_ROOT}}'), false);
});

test('parseAgent accepts both tool spellings and rejects files without a name or description', () => {
  assert.deepEqual(parseAgent(agentFile('a', 'tools: read, bash\nmodel: fixture/model\n')).tools, ['read', 'bash']);
  assert.deepEqual(parseAgent(agentFile('a', 'tools: [read, bash]\n')).tools, ['read', 'bash']);
  assert.equal(parseAgent(agentFile('a', 'model: fixture/model\n')).model, 'fixture/model');
  assert.equal(parseAgent(agentFile('a')).tools, undefined);
  assert.throws(() => parseAgent('---\ndescription: no name\n---\nbody'), /name/);
  assert.throws(() => parseAgent('---\nname: x\n---\nbody'), /description/);
});
