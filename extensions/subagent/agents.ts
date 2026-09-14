import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';

export type AgentScope = 'user' | 'project' | 'both';
export type AgentSource = 'bundled' | 'user' | 'project';

export type AgentDefinition = {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
};

export type AgentConfig = AgentDefinition & { source: AgentSource; filePath: string };

export type AgentDiscoveryResult = { agents: AgentConfig[]; projectAgentsDir: string | null };

export const bundledAgentsDirectory = fileURLToPath(new URL('../../agents/', import.meta.url));

type AgentFrontmatter = { name?: unknown; description?: unknown; tools?: unknown; model?: unknown };

// Both `tools: read, bash` and `tools: [read, bash]` are in use.
function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const tools = raw.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

export function parseAgent(content: string): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) throw new Error('Agent frontmatter needs a name');
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) throw new Error('Agent frontmatter needs a description');
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseToolList(frontmatter.tools),
    model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
    systemPrompt: body,
  };
}

// One bad file must not take down the other agents in the same directory.
function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return agents; }
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      agents.push({ ...parseAgent(fs.readFileSync(filePath, 'utf-8')), source, filePath });
    } catch { continue; }
  }
  return agents;
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); }
  catch { return false; }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, 'agents');
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function bundledAgents(bundledDir = bundledAgentsDirectory): AgentConfig[] {
  return loadAgentsFromDir(bundledDir, 'bundled');
}

// Later sources override earlier ones by name: bundled < user < project.
export function discoverAgents(cwd: string, scope: AgentScope, { bundledDir = bundledAgentsDirectory, userDir = path.join(getAgentDir(), 'agents') } = {}): AgentDiscoveryResult {
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const layers: AgentConfig[][] = [];
  if (scope !== 'project') layers.push(loadAgentsFromDir(bundledDir, 'bundled'), loadAgentsFromDir(userDir, 'user'));
  if (scope !== 'user' && projectAgentsDir) layers.push(loadAgentsFromDir(projectAgentsDir, 'project'));
  const agentMap = new Map<string, AgentConfig>();
  for (const layer of layers) for (const agent of layer) agentMap.set(agent.name, agent);
  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
