import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import { parseDocument } from 'yaml';
import { agentDefinitionSchema, type Agent, type AgentCatalog, type AgentDefinition, type AgentProvenance, type CatalogDiagnostic } from './domain.ts';

const MAX_AGENT_BYTES = 64 * 1024;
const MAX_AGENTS = 128;
export const bundledAgentsDirectory = fileURLToPath(new URL('../../agents/', import.meta.url));

export function parseAgent(text: string): AgentDefinition {
  if (Buffer.byteLength(text) > MAX_AGENT_BYTES) throw new Error('Agent exceeds 64 KiB');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) throw new Error('Missing agent frontmatter');
  const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) throw new Error('Invalid agent YAML');
  const metadata: unknown = document.toJS({ maxAliasCount: 0 });
  if (!Check(agentDefinitionSchema, metadata)) throw new Error('Invalid agent fields or explicit tools list');
  const systemPrompt = text.slice(match[0].length).trim();
  if (!systemPrompt) throw new Error('Empty agent system prompt');
  return { ...metadata, systemPrompt };
}

export async function realDirectory(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a real directory: ${current}`);
  }
  return realpath(absolute);
}

export async function discoverAgents({ bundledDir = bundledAgentsDirectory, userDir }: { bundledDir?: string; userDir: string }): Promise<AgentCatalog> {
  const selected = new Map<string, Agent>();
  const shadowed: { agent: Agent; replacedBy: AgentProvenance }[] = [];
  const diagnostics: CatalogDiagnostic[] = [];
  const sources: { kind: AgentProvenance['kind']; directory: string; optional: boolean }[] = [
    { kind: 'bundled', directory: bundledDir, optional: false },
    { kind: 'user', directory: userDir, optional: true },
  ];
  for (const source of sources) {
    try {
      try { await lstat(source.directory); }
      catch (error) {
        if (source.optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      const directory = await realDirectory(source.directory);
      const entries = (await readdir(directory)).sort();
      if (entries.length > MAX_AGENTS) throw new Error('Agent directory exceeds 128 entries');
      const local = new Map<string, Agent>();
      for (const entry of entries) {
        const filename = path.join(directory, entry);
        try {
          const stat = await lstat(filename);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Agent entry must be a regular file');
          if (!entry.endsWith('.md')) continue;
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(entry)) throw new Error('Invalid agent filename');
          const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes: Buffer;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size > MAX_AGENT_BYTES) throw new Error('Agent must be a regular file of at most 64 KiB');
            const buffer = Buffer.alloc(MAX_AGENT_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_AGENT_BYTES) throw new Error('Agent exceeds 64 KiB');
            bytes = buffer.subarray(0, bytesRead);
          } finally { await handle.close(); }
          const definition = parseAgent(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          if (local.has(definition.name)) throw new Error(`Duplicate agent name: ${definition.name}`);
          const agent: Agent = { ...definition, provenance: { kind: source.kind, path: filename, sha256: createHash('sha256').update(bytes).digest('hex') } };
          local.set(agent.name, agent);
        } catch (error) {
          diagnostics.push({ path: filename, message: String(error).slice(0, 1024) });
        }
      }
      for (const [name, agent] of local) {
        const previous = selected.get(name);
        if (previous) shadowed.push({ agent: previous, replacedBy: agent.provenance });
        selected.set(name, agent);
      }
    } catch (error) {
      diagnostics.push({ path: source.directory, message: String(error).slice(0, 1024) });
    }
  }
  return { selected: new Map([...selected].sort(([a], [b]) => a.localeCompare(b, 'en'))), shadowed, diagnostics };
}
