import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const lines = (name: string) => read(name).split('\n').length - 1;
const budget: Record<string, number> = JSON.parse(read('budget.json'));

/** The top-level fields of the `Config` type, read from the source. Nested fields such as `models.lead` do not count. */
function configFields(): string[] {
  const body = /^export type Config = \{\n(.*?)^\};$/ms.exec(read('runner.ts'))?.[1] ?? '';
  return [...body.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
}

const sizes: Record<string, { what: string; size: number }> = {
  runnerLines: { what: 'lines in runner/runner.ts', size: lines('runner.ts') },
  leadPromptLines: { what: 'lines in runner/prompts/lead.md', size: lines('prompts/lead.md') },
  configFields: { what: 'fields in the Config type of runner/runner.ts', size: configFields().length },
};

test('the size budgets name exactly the sizes this test measures', () => {
  assert.deepEqual(Object.keys(budget).sort(), Object.keys(sizes).sort());
});

for (const [key, { what, size }] of Object.entries(sizes)) {
  test(`${what} stay within the ${key} budget`, () => {
    assert.ok(size > 0, `Found no ${what}, so this test no longer measures anything. Fix the count in runner/budget.test.ts.`);
    assert.ok(size <= budget[key], `${size} ${what}, and the budget is ${budget[key]} (${key} in runner/budget.json). Cut ${size - budget[key]}, or get Alex to raise the budget in the decision log of ~/dev/agent-orchestration/README.md, then raise it here.`);
  });
}
