import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

export type AgentDefinition = {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /** A role from pstack-pi/models.json, tried before `model`. */
  role?: string;
  systemPrompt: string;
};

export const packageRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// `agents/` holds agents generated from upstream pstack. `additions/agents/` holds Pi-owned agents.
export const bundledAgentsDirectories = [path.join(packageRoot, 'agents'), path.join(packageRoot, 'additions', 'agents')];

type AgentFrontmatter = { name?: unknown; description?: unknown; tools?: unknown; model?: unknown; role?: unknown };

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
    role: typeof frontmatter.role === 'string' ? frontmatter.role : undefined,
    systemPrompt: body.replaceAll('{{PSTACK_ROOT}}', packageRoot),
  };
}
