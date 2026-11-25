import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { decodePapercutRecord, formatBytes, formatDuration, normalizePapercutNote, papercutKey, papercutLabel, papercutParameters } from '../../extensions/pstack/papercut-model.ts';

const v1 = {
  version: 1,
  source: 'agent',
  at: '2026-09-14T20:00:00.000Z',
  cwd: '/work/project',
  sessionId: 'session-1',
  kind: 'docs.confusing',
  note: 'The event order was unclear.',
  evidence: { tool: 'read', durationMs: 1250, outputBytes: 42, isError: false },
};
const v2 = { ...v1, version: 2, host: 'test-mac', model: 'test-provider/test-model' };
/** @type {import('../../extensions/pstack/papercut-model.ts').CurrentPapercutRecord} */
const v3 = {
  version: 3,
  source: 'agent',
  at: '2026-11-25T06:20:11.000Z',
  sessionId: 'session-1',
  callId: 'toolu_01',
  cwd: '/work/project',
  repo: { root: '/work/project', head: '9d5eafe' },
  host: 'test-mac',
  model: 'test-provider/test-model',
  build: 'pstack-pi@0ffc613',
  note: 'read returned the old file right after a write.',
  culprit: { type: 'pi-tool', name: 'read' },
  impact: 'wrong-result',
  fix: 'Read through the write cache.',
};

test('decodes version 1 and version 2 records', () => {
  assert.deepEqual(decodePapercutRecord(v1), v1);
  assert.deepEqual(decodePapercutRecord(v2), v2);
  const { evidence: _evidence, ...bareV1 } = v1;
  assert.deepEqual(decodePapercutRecord(bareV1), bareV1);
  const { host: _host, model: _model, ...bareV2 } = v2;
  assert.deepEqual(decodePapercutRecord(bareV2), bareV2);
  for (const invalid of [
    { ...v1, version: 0 },
    { ...v1, host: 'test-mac' },
    { ...v1, kind: 'Not Valid' },
    { ...v1, note: '' },
    { ...v1, at: 'yesterday' },
    { ...v1, evidence: { tool: 'read' } },
    { ...v2, host: '' },
    { ...v2, culprit: { type: 'self' } },
    { ...v2, extra: true },
  ]) assert.equal(decodePapercutRecord(invalid), null, JSON.stringify(invalid));
});

test('decodes version 3 records, with or without the optional fields', () => {
  assert.deepEqual(decodePapercutRecord(v3), v3);
  const { repo: _repo, host: _host, model: _model, fix: _fix, ...bare } = v3;
  const self = { ...bare, culprit: { type: 'self' } };
  assert.deepEqual(decodePapercutRecord(self), self);
  for (const invalid of [
    { ...v3, version: 4 },
    { ...v3, kind: 'docs.confusing' },
    { ...v3, evidence: v1.evidence },
    { ...v3, culprit: { type: 'person', name: 'x' } },
    { ...v3, culprit: { type: 'command' } },
    { ...v3, culprit: { type: 'doc', name: ' ' } },
    { ...v3, impact: 'annoying' },
    { ...v3, repo: { root: '/work/project' } },
    { ...v3, fix: 'x'.repeat(501) },
    { ...v3, callId: '' },
    { ...v3, build: '' },
  ]) assert.equal(decodePapercutRecord(invalid), null, JSON.stringify(invalid));
});

test('tool parameters take a note, a culprit that names its thing unless it is self or unknown, an impact and an optional fix', () => {
  for (const valid of [
    { note: 'x', culprit: { type: 'pi-tool', name: 'read' }, impact: 'extra-steps' },
    { note: 'x', culprit: { type: 'self' }, impact: 'blocked', fix: 'check the path first' },
    { note: 'x', culprit: { type: 'unknown', name: 'maybe the proxy' }, impact: 'blocked' },
  ]) assert.equal(Check(papercutParameters, valid), true, JSON.stringify(valid));
  for (const invalid of [
    {},
    { note: 'x' },
    { note: '   ', culprit: { type: 'self' }, impact: 'blocked' },
    { note: 'x', culprit: { type: 'self' } },
    { note: 'x', culprit: { type: 'self' }, impact: 'slow' },
    { note: 'x', culprit: 'read', impact: 'blocked' },
    { note: 'x', culprit: { type: 'environment' }, impact: 'blocked' },
    { note: 'x', culprit: { type: 'mcp', name: '  ' }, impact: 'blocked' },
    { note: 'x', culprit: { type: 'self' }, impact: 'blocked', kind: 'tool.slow' },
    { note: 'x', culprit: { type: 'self' }, impact: 'blocked', evidence: { tool: 'bash', durationMs: 1, outputBytes: 2 } },
  ]) assert.equal(Check(papercutParameters, invalid), false, JSON.stringify(invalid));
});

test('labels and keys records by culprit, or by kind for older records', () => {
  assert.equal(papercutLabel(v3), 'pi-tool:read');
  assert.equal(papercutLabel({ culprit: { type: 'self' } }), 'self');
  assert.equal(papercutLabel(v1), 'docs.confusing');
  assert.equal(papercutKey(v3), papercutKey({ ...v3, note: `  ${v3.note.replace(' ', '   ')} ` }));
  assert.notEqual(papercutKey(v3), papercutKey({ ...v3, culprit: { type: 'pi-tool', name: 'write' } }));
  assert.notEqual(papercutKey(v3), papercutKey({ ...v3, sessionId: 'session-2' }));
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
