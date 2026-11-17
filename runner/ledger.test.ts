import assert from 'node:assert/strict';
import { test } from 'node:test';
import { code, configFields, ledger, readme, runner, tables } from './ledger.ts';

const ticks = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const all = (pattern: RegExp, text: string) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))];
const sorted = (names: string[]) => [...names].sort();

test('the ledger lists every Config field, and no field that is gone', () => {
  const fields = configFields();
  assert.ok(fields.length > 10, 'the Config fields did not parse');
  assert.deepEqual(sorted(tables.config.map((row) => ticks(row[0])[0])), sorted(fields));
});

test('the ledger lists every state file the runner names', () => {
  const names = [
    ...all(/\brf\(w, '([^']+)'\)/g, runner),
    ...all(/'\.runner', '([^']+)'/g, runner),
    ...all(/path\.join\(config\.worktreeRoot, '([^']+)'/g, runner),
  ];
  assert.ok(names.includes('started') && names.includes('running.json') && names.includes('.attempts'), 'the state file names did not parse');
  const listed = tables.facts.map((row) => row[0]).join('\n');
  for (const name of new Set(names)) assert.ok(listed.includes(name), `the ledger has no row for the state file "${name}"`);
});

test('the ledger lists every Linear mutation and every tmux command that changes something', () => {
  const listed = tables.writes.map((row) => row[0]).join('\n');
  const mutations = all(/mutation \w+\([^)]*\) \{ (\w+)\(/g, code);
  assert.ok(mutations.includes('issueCreate'), 'the Linear mutations did not parse');
  for (const name of mutations) assert.ok(listed.includes(`\`${name}\``), `the ledger has no row for the Linear mutation ${name}`);
  const readOnly = ['has-session', 'list-sessions'];
  const tmux = [...all(/bin\('tmux'\), \['([a-z-]+)'/g, runner), ...all(/\b(set-environment)\b/g, runner)];
  assert.ok(tmux.includes('new-session'), 'the tmux commands did not parse');
  for (const name of tmux.filter((verb) => !readOnly.includes(verb))) assert.ok(listed.includes(`\`${name}`), `the ledger has no row for tmux ${name}`);
});

test('every function a ledger row names is still in the code', () => {
  for (const row of Object.values(tables).flat()) {
    assert.equal(row.length, 4, `the row "${row[0]}" needs 4 cells`);
    const where = ticks(row[1]);
    assert.ok(where.length, `the row "${row[0]}" names no function`);
    for (const name of where) assert.match(code, new RegExp(`\\b${name}\\b`), `the row "${row[0]}" names ${name}, which the code no longer has`);
  }
});

test('the counts the README states match the ledger rows', () => {
  const total = /(\d+) writes and processes, (\d+) facts, (\d+) config fields, (\d+) other inputs and (\d+) timers/.exec(ledger);
  assert.ok(total, 'the ledger states no totals');
  assert.deepEqual(total.slice(1).map(Number), [tables.writes, tables.facts, tables.config, tables.inputs, tables.timers].map((t) => t.length));
  assert.equal(Number(/makes (\d+) kinds of write and process start/.exec(readme)?.[1]), tables.writes.length);
  const kept = /keeps (\d+) facts: (\d+) files, (\d+) tmux option, (\d+) marks in Linear and (\d+) in memory/.exec(readme);
  assert.ok(kept, 'the README does not say how many facts the runner keeps');
  const kind = (start: string) => tables.facts.filter((row) => row[0].startsWith(start)).length;
  const [tmux, linear, memory] = [kind('tmux'), kind('Linear:'), kind('Memory:')];
  assert.deepEqual(kept.slice(1).map(Number), [tables.facts.length, tables.facts.length - tmux - linear - memory, tmux, linear, memory]);
});
