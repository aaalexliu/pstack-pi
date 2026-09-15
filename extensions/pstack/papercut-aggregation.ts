import { formatBytes, formatDuration, normalizePapercutNote, type PapercutRecord } from './papercut-model.ts';

export type PapercutScope = Readonly<{ kind: 'project'; cwd: string } | { kind: 'all' }>;

export type PapercutsCommand = Readonly<
  | { kind: 'list'; scope: PapercutScope }
  | { kind: 'aggregate' }
  | { kind: 'invalid'; message: string }
>;

const commandUsage = 'Usage: /papercuts [all | aggregate]';

export function parsePapercutsCommand(args: string, cwd: string): PapercutsCommand {
  const word = args.trim();
  if (word === '') return { kind: 'list', scope: { kind: 'project', cwd } };
  if (word === 'all') return { kind: 'list', scope: { kind: 'all' } };
  if (word === 'aggregate') return { kind: 'aggregate' };
  return { kind: 'invalid', message: commandUsage };
}

export function selectPapercuts(records: readonly PapercutRecord[], scope: PapercutScope): PapercutRecord[] {
  return scope.kind === 'all' ? [...records] : records.filter((record) => record.cwd === scope.cwd);
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function formatTimestamp(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z');
}

function formatEvidence(record: PapercutRecord): string {
  if (!record.evidence) return '';
  const failed = record.evidence.isError ? ', failed' : '';
  return `${record.evidence.tool}, ${formatDuration(record.evidence.durationMs)}, ${formatBytes(record.evidence.outputBytes)}${failed}`;
}

export function formatRecentPapercuts(records: readonly PapercutRecord[], scope: PapercutScope, limit = 20): string {
  const selected = selectPapercuts(records, scope).slice(-limit).reverse();
  if (selected.length === 0) return scope.kind === 'all' ? 'No papercuts' : 'No papercuts for this project';
  return selected.map((record) => {
    const project = scope.kind === 'all' ? ` | ${record.cwd}` : '';
    const evidence = formatEvidence(record);
    return `${formatTimestamp(record.at)}${project} | ${record.kind} | ${record.note}${evidence ? ` | ${evidence}` : ''}`;
  }).join('\n');
}

type KindSummary = { kind: string; count: number; projects: Set<string>; firstSeen: string; lastSeen: string };
type NoteSummary = { cwd: string; kind: string; note: string; count: number; tools: Set<string>; maxDurationMs: number; maxOutputBytes: number };

function summarizeKinds(records: readonly PapercutRecord[]): KindSummary[] {
  const summaries = new Map<string, KindSummary>();
  for (const record of records) {
    const existing = summaries.get(record.kind);
    if (existing) {
      existing.count += 1;
      existing.projects.add(record.cwd);
      if (record.at < existing.firstSeen) existing.firstSeen = record.at;
      if (record.at > existing.lastSeen) existing.lastSeen = record.at;
      continue;
    }
    summaries.set(record.kind, { kind: record.kind, count: 1, projects: new Set([record.cwd]), firstSeen: record.at, lastSeen: record.at });
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}

function summarizeNotes(records: readonly PapercutRecord[]): NoteSummary[] {
  const summaries = new Map<string, NoteSummary>();
  for (const record of records) {
    const note = normalizePapercutNote(record.note);
    const key = `${record.cwd}\u0000${record.kind}\u0000${note.toLocaleLowerCase()}`;
    const existing = summaries.get(key);
    if (existing) {
      existing.count += 1;
      if (record.evidence) {
        existing.tools.add(record.evidence.tool);
        existing.maxDurationMs = Math.max(existing.maxDurationMs, record.evidence.durationMs);
        existing.maxOutputBytes = Math.max(existing.maxOutputBytes, record.evidence.outputBytes);
      }
      continue;
    }
    summaries.set(key, {
      cwd: record.cwd,
      kind: record.kind,
      note,
      count: 1,
      tools: new Set(record.evidence ? [record.evidence.tool] : []),
      maxDurationMs: record.evidence?.durationMs ?? 0,
      maxOutputBytes: record.evidence?.outputBytes ?? 0,
    });
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind) || left.note.localeCompare(right.note));
}

export function renderPapercutAggregation(records: readonly PapercutRecord[], generatedAt: Date): string {
  const projects = new Set(records.map((record) => record.cwd));
  const lines = [
    '# Papercut aggregation',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    `Records: ${records.length}`,
    `Projects: ${projects.size}`,
    '',
    '## Summary',
    '',
    '| Kind | Count | Projects | First seen | Last seen |',
    '|---|---:|---:|---|---|',
  ];
  for (const summary of summarizeKinds(records)) {
    lines.push(`| ${escapeMarkdownCell(summary.kind)} | ${summary.count} | ${summary.projects.size} | ${formatTimestamp(summary.firstSeen)} | ${formatTimestamp(summary.lastSeen)} |`);
  }
  if (records.length === 0) lines.push('| _None_ | 0 | 0 |  |  |');
  lines.push('', '## Notes', '', '| Project | Kind | Note | Count | Tools | Max duration | Max output |', '|---|---|---|---:|---|---:|---:|');
  for (const summary of summarizeNotes(records)) {
    const tools = escapeMarkdownCell([...summary.tools].sort().join(', '));
    const duration = summary.maxDurationMs ? formatDuration(summary.maxDurationMs) : '';
    const output = summary.maxOutputBytes ? formatBytes(summary.maxOutputBytes) : '';
    lines.push(`| ${escapeMarkdownCell(summary.cwd)} | ${escapeMarkdownCell(summary.kind)} | ${escapeMarkdownCell(summary.note)} | ${summary.count} | ${tools} | ${duration} | ${output} |`);
  }
  if (records.length === 0) lines.push('| _None_ |  |  | 0 |  |  |  |');
  return `${lines.join('\n')}\n`;
}

export function createAggregationFilename(generatedAt: Date): string {
  return `${generatedAt.toISOString().replaceAll(':', '-').replace('.', '-')}.md`;
}
