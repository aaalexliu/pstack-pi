import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFields, read, runner, tables } from './ledger.ts';

const budget: { counts: Record<string, number>; ceilings: Record<string, number> } = JSON.parse(read('./budget.json'));
const wayOut = 'get Alex to raise it in the decision log of ~/dev/agent-orchestration/README.md, then raise it in runner/budget.json';

/** Strict, one in one out. The first three count rows of the mechanism ledger in the README; the last counts the `Config` type. */
const counts: Record<string, { one: string; many: string; count: number }> = {
  writes: { one: 'write or process', many: 'writes and processes in the ledger', count: tables.writes.length },
  facts: { one: 'remembered fact', many: 'remembered facts in the ledger', count: tables.facts.length },
  timers: { one: 'timer or schedule', many: 'timers and schedules in the ledger', count: tables.timers.length },
  configFields: { one: 'config field', many: 'fields in the Config type of runner/runner.ts', count: configFields().length },
};

/** Loose alarms, set well above today's size, so an ordinary change never meets them. */
const sizes: Record<string, { what: string; size: number }> = {
  runnerLines: { what: 'lines in runner/runner.ts', size: runner.split('\n').length - 1 },
  leadPromptWords: { what: 'words in runner/prompts/lead.md', size: read('./prompts/lead.md').split(/\s+/).filter(Boolean).length },
};

test('budget.json names exactly the counts and sizes this test measures', () => {
  assert.deepEqual(Object.keys(budget.counts).sort(), Object.keys(counts).sort());
  assert.deepEqual(Object.keys(budget.ceilings).sort(), Object.keys(sizes).sort());
});

test('config.example.json shows every field of the Config type, so the field count is the real one', () => {
  assert.deepEqual(Object.keys(JSON.parse(read('./config.example.json'))), configFields());
});

for (const [key, { one, many, count }] of Object.entries(counts)) {
  test(`${many} stay within the ${key} budget`, () => {
    assert.ok(count > 0, `Found no ${many}, so this test no longer measures anything. Fix the count in runner/budget.test.ts.`);
    const max = budget.counts[key];
    assert.ok(count <= max, `${count} ${many}, and the budget is ${max} (counts.${key} in runner/budget.json). This change adds a ${one}. Remove ${count - max} of the same kind in the same PR, or ${wayOut}.`);
  });
}

for (const [key, { what, size }] of Object.entries(sizes)) {
  test(`${what} stay under the ${key} ceiling`, () => {
    assert.ok(size > 0, `Found no ${what}, so this test no longer measures anything. Fix the size in runner/budget.test.ts.`);
    const max = budget.ceilings[key];
    assert.ok(size <= max, `${size} ${what}, and the ceiling is ${max} (ceilings.${key} in runner/budget.json). Cut ${size - max}, or ${wayOut}.`);
  });
}
