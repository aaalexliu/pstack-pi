import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const REVIEW = path.join(import.meta.dirname, 'review.ts');
const HEAD = 'a'.repeat(40);
const BASE_TIP = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const LEAD = '11111111-2222-3333-4444-555555555555';
const PR = { url: 'https://github.com/owner/repo/pull/7', number: 7, headRefOid: HEAD, baseRefOid: BASE_TIP, body: 'Makes the thing.' };
const SUB_ISSUES = [
  { identifier: 'ALE-10', title: 'Make the first half', url: 'https://linear.app/x/issue/ALE-10', description: 'Goal: the first half.', state: { name: 'In Progress', type: 'started' } },
  { identifier: 'ALE-11', title: 'Make the second half', url: 'https://linear.app/x/issue/ALE-11', description: 'Goal: the second half.', state: { name: 'Todo', type: 'unstarted' } },
  { identifier: 'ALE-12', title: 'Make a third half', url: 'https://linear.app/x/issue/ALE-12', description: 'Goal: dropped.', state: { name: 'Canceled', type: 'canceled' } },
];

/**
 * A fake `gh` that serves one PR and its reviews from files, and a fake `pi` reviewer that posts a record the way
 * prompts/review.md says, built from its own --session-id and the facts in its task. STUB_REVIEW bends that record:
 * `must-fix`, `other-head` (it reviewed some other commit), or `none` (it posted nothing). Linear, reached through a
 * fetch the command loads with --import, serves ALE-9's sub-issues, or a 500 with `linear: 'down'`. `reviews` seeds the PR's earlier reviews.
 */
function setup(stub = 'clean', o: { body?: string; linear?: 'down'; reviews?: string[] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const file = (name: string) => path.join(dir, name);
  for (const folder of ['bin', 'job-ale-9-thing/.runner', 'job-ale-9-thing-ALE-10/src']) mkdirSync(file(folder), { recursive: true });
  writeFileSync(file('pr.json'), JSON.stringify({ ...PR, body: o.body ?? PR.body }));
  writeFileSync(file('reviews.json'), JSON.stringify((o.reviews ?? []).map((body) => ({ body }))));
  writeFileSync(file('job-ale-9-thing/.runner/work.json'), JSON.stringify({ id: 'ale-9-id', key: 'ALE-9', title: 'Make the thing', url: 'https://linear.app/x/issue/ALE-9', description: 'The ticket body.', models: { lead: 'lead/model', review: 'review/model' } }));
  writeFileSync(file('config.json'), JSON.stringify({ linearTokenCommand: 'echo token', team: 'ALE', runnerUser: 'runner', askAssignee: 'Alex', repos: {}, models: { lead: 'lead/model', review: 'review/model' }, worktreeRoot: dir }));
  writeFileSync(file('linear.mjs'), `import fs from 'node:fs';
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(${JSON.stringify(file('linear.log'))}, JSON.stringify({ url, variables: JSON.parse(init.body).variables }) + '\\n');
  if (${JSON.stringify(o.linear === 'down')}) return Response.json({ errors: [{ message: 'down' }] }, { status: 500 });
  return Response.json({ data: { issue: { children: { nodes: ${JSON.stringify(SUB_ISSUES)} } } } });
};
`);
  writeFileSync(file('bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args.includes('reviews')) console.log(JSON.stringify({ reviews: JSON.parse(fs.readFileSync(${JSON.stringify(file('reviews.json'))}, 'utf8')) }));
else if (args[0] === 'pr') console.log(fs.readFileSync(${JSON.stringify(file('pr.json'))}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'repos/owner/repo/compare/${BASE_TIP}...${HEAD}') console.log('${MERGE_BASE}');
else { console.error('fake gh: unexpected ' + args.join(' ')); process.exit(1); }
`, { mode: 0o755 });
  writeFileSync(file('bin/pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(file('pi.json'))}, JSON.stringify(args));
const task = args.at(-1);
const fact = (re) => task.match(re)[1];
const mode = process.env.STUB_REVIEW;
if (mode === 'none') { console.log('I could not post.'); process.exit(1); }
const record = ['runner-review v1', 'verdict: ' + (mode === 'must-fix' ? 'must-fix' : 'clean'), 'caused_must_fix: ' + (mode === 'must-fix' ? 1 : 0),
  'head: ' + (mode === 'other-head' ? 'd'.repeat(40) : fact(/Head commit: (\\w+)\\./)), 'round: ' + fact(/round (\\d+),/), 'trigger: ' + fact(/trigger (.+?)\\. Head/),
  'agent: reviewer', 'model: review/model', 'session_id: ' + args[args.indexOf('--session-id') + 1], 'session_path: /tmp/x.jsonl',
  'session_title: ' + args[args.indexOf('--name') + 1], 'asked_by: ' + fact(/asked_by: ([\\w-]+)\\./), '', '[]'].join('\\n');
const file = ${JSON.stringify(file('reviews.json'))};
fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, 'utf8')), { body: record }]));
console.log(record.split('\\n').slice(0, 4).join('\\n'));
`, { mode: 0o755 });
  /** Runs the command in the lead's worktree, or in `cwd` under the temp folder. */
  const review = (args: string[], env: Record<string, string | undefined> = {}, cwd = 'job-ale-9-thing') => {
    const r = spawnSync(REVIEW, args, {
      encoding: 'utf8', cwd: file(cwd),
      env: {
        ...process.env, PATH: `${file('bin')}:${process.env.PATH}`, JOB_RUNNER_PI: file('bin/pi'), JOB_RUNNER_CONFIG: file('config.json'),
        NODE_OPTIONS: `--import ${file('linear.mjs')}`, PI_SESSION_ID: LEAD, STUB_REVIEW: stub, ...env,
      },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const pi = () => JSON.parse(readFileSync(file('pi.json'), 'utf8')) as string[];
  const records = () => (JSON.parse(readFileSync(file('reviews.json'), 'utf8')) as { body: string }[]).map((r) => r.body);
  const linearReads = () => { try { return readFileSync(file('linear.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; } };
  return { review, pi, records, linearReads };
}

const field = (body: string, name: string) => body.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1];

test('the record names the PR head the command read, the new session and the asking lead, and the command prints it', () => {
  const t = setup();
  const r = t.review([PR.url, '--round', '1', '--trigger', 'first']);
  assert.equal(r.code, 0, r.err);
  const [record] = t.records();
  assert.equal(field(record, 'head'), PR.headRefOid);
  assert.equal(field(record, 'asked_by'), LEAD);
  const args = t.pi();
  const sessionId = args[args.indexOf('--session-id') + 1];
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(sessionId, LEAD, 'the reviewer gets a session of its own');
  assert.equal(field(record, 'session_id'), sessionId);
  assert.deepEqual(args.slice(0, -1), ['-p', '--session-id', sessionId, '--name', 'review ALE-9 PR 7 round 1', '--model', 'review/model',
    '--append-system-prompt', path.join(import.meta.dirname, 'prompts', 'review.md')]);
  assert.match(args.at(-1)!, /^Review PR https:\/\/github.com\/owner\/repo\/pull\/7 for ALE-9, round 1, trigger first\. Head commit: a{40}\. asked_by: 11111111-2222-3333-4444-555555555555\. Base commit: b{40}\. Goal: Make the thing \(https:\/\/linear.app\/x\/issue\/ALE-9\)\. Follow \S+\/prompts\/review.md\.\n\nThe ticket:\n\nThe ticket body\.$/);
  assert.equal(r.out.trim(), record);
});

test('a PR that fixes a sub-issue gets it as the goal, with the ticket and its open sibling sub-issues as context only', () => {
  const t = setup('clean', { body: 'Makes the first half.\n\nFixes [ALE-10](https://linear.app/x/issue/ALE-10)\nPart of [ALE-9](https://linear.app/x/issue/ALE-9)\n' });
  const r = t.review([PR.url, '--round', '1', '--trigger', 'first']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(t.linearReads().map((read) => read.variables), [{ id: 'ale-9-id' }]);
  assert.match(t.pi().at(-1)!, /^Review PR https:\/\/github.com\/owner\/repo\/pull\/7 for ALE-10, part of ALE-9, round 1, trigger first\. Head commit: a{40}\. asked_by: 11111111-2222-3333-4444-555555555555\. Base commit: b{40}\. Goal: Make the first half \(https:\/\/linear.app\/x\/issue\/ALE-10\)\. Follow \S+\/prompts\/review.md\.\n\nThe goal, the sub-issue this PR fixes:\n\nALE-10 \(In Progress\): Make the first half \(https:\/\/linear.app\/x\/issue\/ALE-10\)\n\nGoal: the first half\.\n\nThe parent ticket, context only: ALE-9: Make the thing \(https:\/\/linear.app\/x\/issue\/ALE-9\)\n\nThe ticket body\.\n\nALE-9's other sub-issues, whose work belongs to other PRs:\n\nALE-11 \(Todo\): Make the second half \(https:\/\/linear.app\/x\/issue\/ALE-11\)\n\nGoal: the second half\.$/);
});

test('a PR that fixes only the ticket, or no sub-issue of it, is judged against the ticket', () => {
  for (const [body, note, reads] of [['Makes the thing.', '', 0], ['Fixes ALE-9', '', 0], ['fixes ALE-99\nPart of ALE-9', 'review: ALE-99 is not a sub-issue of ALE-9; the goal is the ticket\n', 1]] as const) {
    const t = setup('clean', { body });
    const r = t.review(['7', '--round', '1', '--trigger', 'first']);
    assert.equal(r.code, 0, r.err);
    assert.equal(t.linearReads().length, reads, body);
    assert.match(t.pi().at(-1)!, /^Review PR \S+ for ALE-9, round 1, trigger first\. .* Goal: Make the thing \(https:\/\/linear.app\/x\/issue\/ALE-9\)\. Follow \S+\n\nThe ticket:\n\nThe ticket body\.$/, body);
    assert.equal(r.err.replace(/^review: review ALE-9 PR 7 round 1, .*\n/m, ''), note, body);
  }
});

test('a sub-issue PR whose sub-issues Linear cannot list fails before any reviewer starts', () => {
  const t = setup('clean', { body: 'Fixes ALE-10', linear: 'down' });
  const r = t.review(['7', '--round', '1', '--trigger', 'first']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^review: could not read ALE-9's sub-issues from Linear: Linear 500/);
  assert.deepEqual(t.records(), []);
});

test("a sub-lead's worktree, the lead's path plus -<sub-issue key>, finds the lead's ticket; an unrelated folder does not", () => {
  const t = setup();
  const r = t.review(['7', '--round', '1', '--trigger', 'first'], {}, 'job-ale-9-thing-ALE-10/src');
  assert.equal(r.code, 0, r.err);
  assert.equal(t.pi()[t.pi().indexOf('--name') + 1], 'review ALE-9 PR 7 round 1');
  const lost = t.review(['7', '--round', '1', '--trigger', 'first'], {}, 'bin');
  assert.equal(lost.code, 1);
  assert.match(lost.err, /^review: no \.runner\/work\.json in \S+\/bin or above it/);
  assert.equal(t.records().length, 1, 'no reviewer ran without a ticket');
});

test('a rebase round names the merge base it sits on', () => {
  const t = setup();
  const r = t.review(['7', '--round', '3', '--trigger', 'rebase']);
  assert.equal(r.code, 0, r.err);
  assert.equal(field(t.records()[0], 'trigger'), `rebase onto ${MERGE_BASE}`);
});

test('a later round names the head the last runner-review record reviewed, so the reviewer can read what changed since', () => {
  const old = (sha: string) => `runner-review v1\nverdict: must-fix\ncaused_must_fix: 1\nhead: ${sha}\nround: 1\n\n[]`;
  const t = setup('clean', { reviews: [old('e'.repeat(40)), 'Looks good to me.', old('f'.repeat(40))] });
  const r = t.review(['7', '--round', '2', '--trigger', 'fix']);
  assert.equal(r.code, 0, r.err);
  assert.match(t.pi().at(-1)!, /^Review PR \S+ for ALE-9, round 2, trigger fix\. Head commit: a{40}\. asked_by: \S+\. Base commit: b{40}\. Last reviewed head: f{40}\. Goal:/);
});

test('a must-fix verdict exits 2 and still prints the record', () => {
  const t = setup('must-fix');
  const r = t.review(['7', '--round', '1', '--trigger', 'first']);
  assert.equal(r.code, 2);
  assert.match(r.out, /^runner-review v1\nverdict: must-fix\n/);
});

test('a record for another head fails and says to ask again', () => {
  const t = setup('other-head');
  const r = t.review(['7', '--round', '2', '--trigger', 'fix']);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`head is d{40}, not ${HEAD}\\. Ask for a new round\\.`));
  assert.equal(r.out, '');
});

test('no record fails and shows what the reviewer said', () => {
  const t = setup('none');
  const r = t.review(['7', '--round', '1', '--trigger', 'first']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no runner-review record with session_id [0-9a-f-]{36} on https:\/\/github.com\/owner\/repo\/pull\/7\. The reviewer exited 1 and said:\nI could not post\./);
});

test('bad use prints usage, and a missing PI_SESSION_ID is refused before any reviewer starts', () => {
  const t = setup();
  for (const args of [['7'], ['7', '--round', '0', '--trigger', 'first'], ['7', '--round', '1', '--trigger', 'later']]) {
    const r = t.review(args);
    assert.equal(r.code, 64, args.join(' '));
    assert.match(r.err, /^review: usage: review.ts <pr url or number> --round <n> --trigger first\|fix\|rebase/);
  }
  const r = t.review(['7', '--round', '1', '--trigger', 'first'], { PI_SESSION_ID: '' });
  assert.equal(r.code, 64);
  assert.match(r.err, /PI_SESSION_ID is not set/);
  assert.deepEqual(t.records(), []);
});
