import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { decodePapercutRecord, formatBytes, formatDuration, normalizePapercutNote, papercutParameters } from '../../extensions/pstack/papercut-model.ts';

const record = {
  version: 1,
  source: 'agent',
  at: '2026-09-14T20:00:00.000Z',
  cwd: '/work/project',
  sessionId: 'session-1',
  kind: 'docs.confusing',
  note: 'The event order was unclear.',
  evidence: { tool: 'read', durationMs: 1250, outputBytes: 42, isError: false },
};

test('accepts user-defined kinds and rejects malformed records at the storage boundary', () => {
  assert.deepEqual(decodePapercutRecord(record), record);
  const { evidence: _evidence, ...bare } = record;
  assert.deepEqual(decodePapercutRecord(bare), bare);
  for (const invalid of [
    { ...record, version: 2 },
    { ...record, kind: 'Not Valid' },
    { ...record, note: '' },
    { ...record, at: 'yesterday' },
    { ...record, evidence: { tool: 'read' } },
    { ...record, evidence: { ...record.evidence, durationMs: -1 } },
    { ...record, extra: true },
  ]) assert.equal(decodePapercutRecord(invalid), null, JSON.stringify(invalid));
});

test('strict tool parameters reject shape drift before execution', () => {
  for (const valid of [
    { note: 'Slow test run' },
    { kind: 'tool.slow', note: 'Slow test run' },
    { note: 'x', evidence: { tool: 'bash', durationMs: 24, outputBytes: 51338 } },
    { note: 'x', evidence: { tool: 'bash', durationMs: 24, outputBytes: 80, isError: true } },
  ]) assert.equal(Check(papercutParameters, valid), true, JSON.stringify(valid));
  for (const invalid of [
    {}, { note: '   ' }, { kind: 'Tool Slow', note: 'x' }, { note: 'x', includeLastTool: true },
    { note: 'x', evidence: { tool: 'bash' } }, { note: 'x', evidence: { tool: 'bash', durationMs: 1.5, outputBytes: 0 } },
  ]) assert.equal(Check(papercutParameters, invalid), false, JSON.stringify(invalid));
});

test('formats notes, durations, and sizes for humans', () => {
  assert.equal(normalizePapercutNote('  too \n many   spaces '), 'too many spaces');
  assert.equal(formatDuration(19), '19ms');
  assert.equal(formatDuration(2017), '2s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatBytes(80), '80 B');
  assert.equal(formatBytes(51_338), '50.1 KiB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB');
});
