import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Reads the mechanism ledger in the README and the code it describes, for `ledger.test.ts` and `budget.test.ts`. */
export const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
export const runner = read('./runner.ts');
export const code = runner + read('./routines.ts');
export const readme = read('./README.md');
export const ledger = readme.slice(readme.indexOf('\n## Mechanism ledger\n'), readme.indexOf('\n## Config\n'));

/** The rows of the ledger table under one `###` heading, each as its cells. */
function rows(heading: string): string[][] {
  const start = ledger.indexOf(`\n### ${heading}\n`);
  assert.notEqual(start, -1, `the ledger has no "${heading}" table`);
  const end = ledger.indexOf('\n### ', start + 1);
  return ledger.slice(start, end === -1 ? undefined : end).split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Mechanism') && !line.startsWith('| ---'))
    .map((line) => line.slice(2, -2).split(' | '));
}

export const tables = {
  writes: rows('Writes and processes'),
  facts: rows('State and remembered facts'),
  config: rows('Config fields'),
  inputs: rows('Other inputs'),
  timers: rows('Timers and schedules'),
};

/** The top-level fields of the `Config` type, read from the source. Nested fields such as `models.lead` do not count. */
export function configFields(): string[] {
  const type = /^export type Config = \{\n(.*?)^\};$/ms.exec(runner)?.[1] ?? '';
  return [...type.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}
