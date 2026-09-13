import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsage, aggregateUsage, parseUsage, usageReport, zeroUsage } from '../../extensions/subagent/usage.ts';

const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, totalTokens: 123, reasoning: 2, cacheWrite1h: 1,
  cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 1, total: 8 } };

test('usage preserves Pi primary values and optional subsets without pricing or equality assumptions', () => {
  assert.deepEqual(parseUsage(usage), usage);
  const doubled = addUsage(usage, usage);
  assert.deepEqual(doubled, { input: 22, output: 14, cacheRead: 6, cacheWrite: 10, totalTokens: 246, reasoning: 4, cacheWrite1h: 2,
    cost: { input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 2, total: 16 } });
  assert.equal(zeroUsage().reasoning, undefined);
  assert.equal(addUsage(zeroUsage(), { ...zeroUsage(), reasoning: 0 }).reasoning, 0);
});

test('unsafe tokens, costs, extra fields, missing fields, and overflow fail validation', () => {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoning', 'cacheWrite1h']) {
    for (const value of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', null]) assert.throws(() => parseUsage({ ...usage, [key]: value }));
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    for (const value of [-1, Infinity, NaN, '1', null]) assert.throws(() => parseUsage({ ...usage, cost: { ...usage.cost, [key]: value } }));
  }
  for (const value of [null, [], {}, { ...usage, extra: 1 }, { ...usage, cost: {} }, { ...usage, input: undefined }]) assert.throws(() => parseUsage(value));
  assert.throws(() => addUsage({ ...usage, input: Number.MAX_SAFE_INTEGER }, usage));
  assert.throws(() => addUsage({ ...usage, cost: { ...usage.cost, total: Number.MAX_VALUE } }, { ...usage, cost: { ...usage.cost, total: Number.MAX_VALUE } }));
});

test('reports distinguish known zero, provisional known amounts, and unsupported descendants', () => {
  const empty = usageReport();
  assert.equal(empty.direct.kind, 'complete');
  assert.equal(empty.descendant.kind, 'complete');
  const partial = usageReport({ committed: usage, provisional: usage, reasons: ['cancelled'], unexpectedDescendant: true, descendant: usage });
  assert.equal(partial.direct.kind, 'partial');
  if (partial.direct.kind !== 'partial') throw new Error('Expected partial');
  assert.deepEqual(partial.direct.provisional, usage);
  assert.deepEqual(partial.direct.reasons, ['cancelled', 'unfinished-assistant']);
  assert.equal(partial.direct.usage.input, 22);
  assert.deepEqual(aggregateUsage([empty, partial]), { usage: addUsage(addUsage(usage, usage), usage), overflow: false });
});

test('batch aggregation follows input order and preserves representable prior usage on overflow', () => {
  const huge = { ...zeroUsage(), input: Number.MAX_SAFE_INTEGER };
  const result = aggregateUsage([usageReport({ committed: huge }), usageReport({ committed: usage })]);
  assert.equal(result.overflow, true);
  assert.deepEqual(result.usage, huge);
});
