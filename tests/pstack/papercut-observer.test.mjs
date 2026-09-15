import assert from 'node:assert/strict';
import test from 'node:test';
import { countToolResultBytes, formatToolTrailer, PapercutObserver } from '../../extensions/pstack/papercut-observer.ts';

test('measures a tool call and formats a trailer the agent can copy', () => {
  const observer = new PapercutObserver();
  observer.start('call-1', 'bash', 1000);
  const observation = observer.finish({ toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'done' }], isError: false, finishedAt: 62_000 });
  assert.deepEqual(observation, {
    evidence: { tool: 'bash', durationMs: 61_000, outputBytes: 4, isError: false },
    trailer: '[pstack: bash 61000ms 4B]',
  });
});

test('marks failed calls in the trailer', () => {
  assert.equal(formatToolTrailer({ tool: 'bash', durationMs: 22, outputBytes: 80, isError: true }), '[pstack: bash 22ms 80B failed]');
});

test('tracks concurrent calls by id, not by completion order', () => {
  const observer = new PapercutObserver();
  observer.start('cat', 'bash', 0);
  observer.start('sleep', 'bash', 0);
  const sleep = observer.finish({ toolCallId: 'sleep', toolName: 'bash', content: [], isError: false, finishedAt: 2000 });
  const cat = observer.finish({ toolCallId: 'cat', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(51_338) }], isError: false, finishedAt: 2500 });
  assert.equal(sleep?.trailer, '[pstack: bash 2000ms 0B]');
  assert.equal(cat?.trailer, '[pstack: bash 2500ms 51338B]');
  assert.equal(observer.finish({ toolCallId: 'cat', toolName: 'bash', content: [], isError: false, finishedAt: 3000 }), undefined);
});

test('ignores results that have no matching start event', () => {
  const observer = new PapercutObserver();
  assert.equal(observer.finish({ toolCallId: 'unknown', toolName: 'read', content: [], isError: true, finishedAt: 2000 }), undefined);
});

test('counts text and inline data but not other content', () => {
  assert.equal(countToolResultBytes([{ type: 'text', text: 'héllo' }, { type: 'image', data: 'abcd' }, null, 3]), 10);
  assert.equal(countToolResultBytes('not an array'), 0);
});
