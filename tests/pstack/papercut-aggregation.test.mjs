import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAggregationFilename,
  formatRecentPapercuts,
  parsePapercutsCommand,
  renderPapercutAggregation,
  selectPapercuts,
} from '../../extensions/pstack/papercut-aggregation.ts';

/** @type {import('../../extensions/pstack/papercut-model.ts').PapercutRecord[]} */
const records = [
  {
    version: 1, source: 'agent', at: '2026-09-14T20:00:00.000Z', cwd: '/work/alpha', sessionId: 'session-1',
    kind: 'tool.slow', note: 'The focused test took too long.',
    evidence: { tool: 'bash', durationMs: 61_000, outputBytes: 4, isError: false },
  },
  {
    version: 1, source: 'agent', at: '2026-09-14T20:10:00.000Z', cwd: '/work/alpha', sessionId: 'session-2',
    kind: 'tool.slow', note: 'The focused test took too long.',
    evidence: { tool: 'bash', durationMs: 72_000, outputBytes: 8, isError: false },
  },
  {
    version: 1, source: 'agent', at: '2026-09-14T20:20:00.000Z', cwd: '/work/beta', sessionId: 'session-3',
    kind: 'docs.confusing', note: 'The docs used an | undefined term.',
  },
];

test('parses the three command forms and rejects the rest', () => {
  assert.deepEqual(parsePapercutsCommand('', '/work/alpha'), { kind: 'list', scope: { kind: 'project', cwd: '/work/alpha' } });
  assert.deepEqual(parsePapercutsCommand('all', '/work/alpha'), { kind: 'list', scope: { kind: 'all' } });
  assert.deepEqual(parsePapercutsCommand(' aggregate ', '/work/alpha'), { kind: 'aggregate' });
  assert.equal(parsePapercutsCommand('aggregate all', '/work/alpha').kind, 'invalid');
  assert.equal(parsePapercutsCommand('list', '/work/alpha').kind, 'invalid');
});

test('lists recent papercuts newest first, scoped to the project unless asked for all', () => {
  assert.deepEqual(selectPapercuts(records, { kind: 'project', cwd: '/work/alpha' }).map((record) => record.kind), ['tool.slow', 'tool.slow']);
  const project = formatRecentPapercuts(records, { kind: 'project', cwd: '/work/alpha' });
  assert.equal(project.split('\n')[0], '2026-09-14 20:10:00Z | tool.slow | The focused test took too long. | bash, 1m 12s, 8 B');
  assert.match(formatRecentPapercuts(records, { kind: 'all' }), /\| \/work\/beta \| docs\.confusing \|/u);
  assert.equal(formatRecentPapercuts(records, { kind: 'project', cwd: '/work/gamma' }), 'No papercuts for this project');
  assert.equal(formatRecentPapercuts([], { kind: 'all' }), 'No papercuts');
});

test('aggregates repeated notes and evidence into a timestamped Markdown snapshot', () => {
  const generatedAt = new Date('2026-09-14T20:30:00.000Z');
  const markdown = renderPapercutAggregation(records, generatedAt);
  assert.match(markdown, /Generated: 2026-09-14T20:30:00\.000Z\nRecords: 3\nProjects: 2/u);
  assert.match(markdown, /\| tool\.slow \| 2 \| 1 \| 2026-09-14 20:00:00Z \| 2026-09-14 20:10:00Z \|/u);
  assert.match(markdown, /\| \/work\/alpha \| tool\.slow \| The focused test took too long\. \| 2 \| bash \| 1m 12s \| 8 B \|/u);
  assert.match(markdown, /\| \/work\/beta \| docs\.confusing \| The docs used an \\\| undefined term\. \| 1 \|  \|  \|  \|/u);
  assert.equal(createAggregationFilename(generatedAt), '2026-09-14T20-30-00-000Z.md');
});

test('renders an explicit empty snapshot', () => {
  const markdown = renderPapercutAggregation([], new Date('2026-09-14T20:30:00.000Z'));
  assert.match(markdown, /Records: 0\nProjects: 0/u);
  assert.match(markdown, /\| _None_ \| 0 \| 0 \|/u);
});
