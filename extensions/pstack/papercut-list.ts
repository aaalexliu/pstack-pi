import { formatBytes, formatDuration, type PapercutRecord } from './papercut-model.ts';

export type PapercutScope = Readonly<{ kind: 'project'; cwd: string } | { kind: 'all' }>;

export type PapercutsCommand = Readonly<
  | { kind: 'list'; scope: PapercutScope }
  | { kind: 'invalid'; message: string }
>;

const commandUsage = 'Usage: /papercuts [all]';

export function parsePapercutsCommand(args: string, cwd: string): PapercutsCommand {
  const word = args.trim();
  if (word === '') return { kind: 'list', scope: { kind: 'project', cwd } };
  if (word === 'all') return { kind: 'list', scope: { kind: 'all' } };
  return { kind: 'invalid', message: commandUsage };
}

export function selectPapercuts(records: readonly PapercutRecord[], scope: PapercutScope): PapercutRecord[] {
  return scope.kind === 'all' ? [...records] : records.filter((record) => record.cwd === scope.cwd);
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
