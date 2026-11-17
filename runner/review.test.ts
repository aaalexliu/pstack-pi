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
const PR = { url: 'https://github.com/owner/repo/pull/7', number: 7, headRefOid: HEAD, baseRefOid: BASE_TIP };

/**
 * A fake `gh` that serves one PR and its reviews from files, and a fake `pi` reviewer that posts a record the way
 * prompts/review.md says, built from its own --session-id and the facts in its task. STUB_REVIEW bends that record:
 * `must-fix`, `other-head` (it reviewed some other commit), or `none` (it posted nothing).
 */
function setup(stub = 'clean') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const file = (name: string) => path.join(dir, name);
  for (const folder of ['bin', 'job-ale-9-thing/.runner', 'job-ale-9-thing-unit/src']) mkdirSync(file(folder), { recursive: true });
  writeFileSync(file('pr.json'), JSON.stringify(PR));
  writeFileSync(file('reviews.json'), '[]');
  writeFileSync(file('job-ale-9-thing/.runner/work.json'), JSON.stringify({ key: 'ALE-9', title: 'Make the thing', url: 'https://linear.app/x/issue/ALE-9', description: 'The ticket body.', models: { lead: 'lead/model', review: 'review/model' } }));
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
      env: { ...process.env, PATH: `${file('bin')}:${process.env.PATH}`, JOB_RUNNER_PI: file('bin/pi'), PI_SESSION_ID: LEAD, STUB_REVIEW: stub, ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const pi = () => JSON.parse(readFileSync(file('pi.json'), 'utf8')) as string[];
  const records = () => (JSON.parse(readFileSync(file('reviews.json'), 'utf8')) as { body: string }[]).map((r) => r.body);
  return { review, pi, records };
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
  assert.match(args.at(-1)!, /^Review PR https:\/\/github.com\/owner\/repo\/pull\/7 for ALE-9, round 1, trigger first\. Head commit: a{40}\. asked_by: 11111111-2222-3333-4444-555555555555\. Goal: Make the thing \(https:\/\/linear.app\/x\/issue\/ALE-9\)\. Follow \S+\/prompts\/review.md\.\n\nThe ticket:\n\nThe ticket body\.$/);
  assert.equal(r.out.trim(), record);
});

test("a sub-lead's worktree, the lead's path plus -<unit>, finds the lead's ticket; an unrelated folder does not", () => {
  const t = setup();
  const r = t.review(['7', '--round', '1', '--trigger', 'first'], {}, 'job-ale-9-thing-unit/src');
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
