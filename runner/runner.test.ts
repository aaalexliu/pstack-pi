import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main, type Config, type Finding } from './runner.ts';

type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; state: string; delegate: string | null; labels: string[];
  comments: { id: string; body: string; createdAt: string; user: { name: string } }[];
};

const RUNNER = 'firstmate test';
const caused: Finding = { must_fix: true, caused_by_change: true, where: 'work.txt:1', what: 'breaks the thing', done_when: 'the thing works' };
const preexisting: Finding = { must_fix: true, caused_by_change: false, where: 'old.txt:1', what: 'was already broken', done_when: 'a follow-up fixes it' };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function issue(n: number, fields: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: `id-${n}`, identifier: `ALE-${n}`, title: `Job number ${n}`, description: 'Make it work.\nReport to: lead',
    url: `https://linear.app/x/issue/ALE-${n}`, createdAt: `2026-01-0${n}T00:00:00Z`, team: 'ALE', state: 'Todo',
    delegate: RUNNER, labels: ['pstack-pi'], comments: [], ...fields,
  };
}

function setup(issues: FakeIssue[], reviews: (Finding[] | 'invalid')[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-test-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  mkdirSync(path.join(repo, '.agents'));
  writeFileSync(path.join(repo, '.agents', 'verify'), '#!/bin/sh\necho verify ok\n', { mode: 0o755 });
  writeFileSync(path.join(repo, 'work.txt'), 'start\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');

  const piLog = path.join(root, 'pi.log');
  const ghLog = path.join(root, 'gh.log');
  const pi = path.join(root, 'pi');
  writeFileSync(pi, `#!/usr/bin/env node
const fs = require('node:fs');
const input = process.argv.at(-1);
const reviews = ${JSON.stringify(reviews)};
const review = /findings-(\\d+)\\.json/.exec(input);
let step;
if (process.argv.some((a) => a.endsWith('review.md'))) {
  step = 'review-' + review[1];
  const entry = reviews[review[1] - 1];
  fs.writeFileSync('.runner/findings-' + review[1] + '.json', entry === 'invalid' ? 'looks good to me' : JSON.stringify(entry));
} else {
  step = /Fix round (\\d+)/.test(input) ? 'fix-' + /Fix round (\\d+)/.exec(input)[1] : 'implement';
  fs.appendFileSync('work.txt', step + '\\n');
  fs.writeFileSync('.runner/PROOF.md', 'Ran it: ' + step);
}
fs.appendFileSync(${JSON.stringify(piLog)}, JSON.stringify({ step, input, model: process.argv[process.argv.indexOf('--model') + 1] }) + '\\n');
`, { mode: 0o755 });
  const gh = path.join(root, 'gh');
  writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(ghLog)}\necho https://github.com/example/repo/pull/7\n`, { mode: 0o755 });
  chmodSync(pi, 0o755);
  process.env.JOB_RUNNER_PI = pi;
  process.env.JOB_RUNNER_GH = gh;
  writeFileSync(path.join(root, 'hook-key'), 'hook-secret\n');

  const config: Config = {
    linearTokenCommand: 'echo test-token', team: 'ALE', runnerUser: RUNNER,
    repos: { 'pstack-pi': { path: repo, base: 'main', automerge: false } },
    webhooks: { lead: { url: 'https://hooks.example/lead', keyFile: path.join(root, 'hook-key') } },
    models: { implement: 'impl-model', review: 'review-model' }, thinking: 'high', pollSeconds: 1, slots: 1,
    worktreeRoot: path.join(root, 'worktrees'),
  };
  const hooks: { auth: string; body: Record<string, unknown> }[] = [];
  const stateIds: Record<string, string> = { 'state-todo': 'Todo', 'state-progress': 'In Progress', 'state-review': 'In Review' };
  let nextComment = 0;
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const request = JSON.parse(String(init?.body));
    if (String(url) !== 'https://api.linear.app/graphql') {
      hooks.push({ auth: headers.get('Authorization') ?? '', body: request });
      return Response.json({ ok: true });
    }
    assert.equal(headers.get('Authorization'), 'Bearer test-token');
    const { query, variables: v } = request;
    const op = /^(?:query|mutation) (\w+)/.exec(query)?.[1];
    const find = (id: string) => issues.find((i) => i.id === id)!;
    const toWire = (i: FakeIssue) => ({ ...i, labels: { nodes: i.labels.map((name) => ({ name })) } });
    if (op === 'Issues') {
      const nodes = issues.filter((i) => i.team === v.team && i.state === v.state && i.delegate === v.user);
      return Response.json({ data: { issues: { nodes: nodes.map(toWire) } } });
    }
    if (op === 'States') return Response.json({ data: { workflowStates: { nodes: Object.entries(stateIds).map(([id, name]) => ({ id, name })) } } });
    if (op === 'Update') {
      const target = find(v.id);
      if (v.input.stateId) target.state = stateIds[v.input.stateId];
      if ('delegateId' in v.input) target.delegate = v.input.delegateId;
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    if (op === 'Comment') {
      const id = `comment-${++nextComment}`;
      find(v.input.issueId).comments.push({ id, body: v.input.body, createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, nextComment)).toISOString(), user: { name: RUNNER } });
      return Response.json({ data: { commentCreate: { comment: { id } } } });
    }
    if (op === 'Comments') return Response.json({ data: { issue: { comments: { nodes: find(v.id).comments } } } });
    throw new Error(`unexpected Linear operation ${op}`);
  };
  const lines = (file: string) => { try { return readFileSync(file, 'utf8').trim().split('\n'); } catch { return []; } };
  return {
    config, hooks, origin,
    run: (...argv: string[]) => main(argv, config, fakeFetch as typeof fetch),
    piSteps: () => lines(piLog).map((line) => JSON.parse(line).step),
    piModels: () => lines(piLog).map((line) => JSON.parse(line).model),
    piInput: (step: string) => lines(piLog).map((line) => JSON.parse(line)).find((call) => call.step === step)?.input as string,
    ghCalls: () => lines(ghLog),
    bodies: (i: FakeIssue) => i.comments.map((c) => c.body),
  };
}

test('picks up only the oldest Todo issue delegated to the runner, one per slot', async () => {
  const target = issue(1);
  const newer = issue(2);
  const otherDelegate = issue(3, { delegate: 'someone else' });
  const inReview = issue(4, { state: 'In Review' });
  const otherTeam = issue(5, { team: 'OPS' });
  const t = setup([newer, otherDelegate, inReview, target, otherTeam], [[]]);
  await t.run('--once');
  assert.equal(target.state, 'In Review');
  for (const untouched of [newer, otherDelegate, otherTeam]) {
    assert.equal(untouched.state, 'Todo');
    assert.deepEqual(untouched.comments, []);
  }
  assert.equal(inReview.state, 'In Review');
  assert.deepEqual(inReview.comments, []);
});

test('a clean first review opens a ready PR, hands the issue back, and pings the dispatching bot', async () => {
  const job = issue(1);
  const t = setup([job], [[preexisting]]);
  await t.run('--once');
  assert.deepEqual(t.piSteps(), ['implement', 'review-1']);
  const create = t.ghCalls().find((c) => c.startsWith('pr create'));
  assert.ok(create && !create.includes('--draft'), 'ready PR');
  assert.match(create, /--head job\/ale-1-job-number-1/);
  assert.match(git(t.origin, 'log', '--format=%s', 'job/ale-1-job-number-1'), /ALE-1: implement/);
  assert.equal(job.state, 'In Review');
  assert.equal(job.delegate, null);
  assert.ok(t.bodies(job).some((b) => b.startsWith('PR ready for review: https://github.com/example/repo/pull/7')));
  assert.ok(!t.bodies(job).some((b) => b.startsWith('Needs decision:')));
  assert.deepEqual(t.hooks, [{ auth: 'Bearer hook-secret', body: { issue: 'ALE-1', url: job.url, state: 'ready', pr: 'https://github.com/example/repo/pull/7' } }]);
});

test('with the default one round, a caused must-fix gets one fix that ships once verify passes', async () => {
  const job = issue(1);
  const t = setup([job], [[caused]]);
  await t.run('--once');
  assert.deepEqual(t.piSteps(), ['implement', 'review-1', 'fix-1']);
  assert.ok(!t.ghCalls().find((c) => c.startsWith('pr create'))?.includes('--draft'));
  assert.ok(t.bodies(job).some((b) => b.startsWith('Review round 1: 1 findings, 1 caused must-fix.')));
  assert.equal(job.state, 'In Review');
});

test('with Rounds: 3, every fix is reviewed again until a review comes back clean', async () => {
  const job = issue(1, { description: 'Make it work.\nRounds: 3' });
  const t = setup([job], [[caused], []]);
  await t.run('--once');
  assert.deepEqual(t.piSteps(), ['implement', 'review-1', 'fix-1', 'review-2']);
  assert.ok(!t.ghCalls().find((c) => c.startsWith('pr create'))?.includes('--draft'));
  assert.ok(!t.bodies(job).some((b) => b.startsWith('Needs decision:')));
});

test('hitting the round cap with open findings opens a draft PR and asks for a decision', async () => {
  const job = issue(1, { description: 'Make it work.\nRounds: 3\nReport to: lead' });
  const t = setup([job], [[caused], [caused], [caused]]);
  await t.run('--once');
  assert.deepEqual(t.piSteps(), ['implement', 'review-1', 'fix-1', 'review-2', 'fix-2', 'review-3']);
  assert.ok(t.ghCalls().find((c) => c.startsWith('pr create'))?.includes('--draft'));
  assert.equal(job.state, 'In Review');
  assert.equal(job.delegate, null);
  const decision = t.bodies(job).find((b) => b.startsWith('Needs decision:'));
  assert.match(decision ?? '', /work\.txt:1: breaks the thing/);
  assert.equal(t.hooks[0].body.state, 'needs-decision');
});

test('no job runs more than 3 review rounds, whatever its Rounds line says', async () => {
  const job = issue(1, { description: 'Make it work.\nRounds: 9' });
  const t = setup([job], [[caused], [caused], [caused], [caused]]);
  await t.run('--once');
  assert.deepEqual(t.piSteps(), ['implement', 'review-1', 'fix-1', 'review-2', 'fix-2', 'review-3']);
  assert.ok(t.bodies(job).some((b) => b.startsWith('Needs decision:') && b.includes('after 3 review rounds')));
});

test('model lines in the issue override the configured models', async () => {
  const job = issue(1, { description: 'Make it work.\nReview model: openai/gpt-6.1-sol\nImplement model: xai/grok-4.7' });
  const t = setup([job], [[caused]]);
  await t.run('--once');
  assert.deepEqual(t.piModels(), ['xai/grok-4.7', 'openai/gpt-6.1-sol', 'xai/grok-4.7']);
});

test('steps see human comments once, as new comments', async () => {
  const job = issue(1, { comments: [{ id: 'human-1', body: 'Keep the old flag.', createdAt: '2026-01-01T01:00:00Z', user: { name: 'Alex' } }] });
  const t = setup([job], [[]]);
  await t.run('--once');
  assert.match(t.piInput('implement'), /New comments on the issue:\n- Alex: Keep the old flag\./);
  assert.doesNotMatch(t.piInput('review-1'), /Keep the old flag|Picked up by/);
});

test('a review that writes no valid JSON is a failed step, not a clean review', async () => {
  const job = issue(1);
  const t = setup([job], ['invalid']);
  await t.run('--once');
  assert.ok(t.bodies(job).some((b) => b.startsWith('Needs decision:') && b.includes('no valid findings JSON')));
  assert.equal(job.state, 'In Review');
  assert.equal(job.delegate, null);
  assert.ok(!t.ghCalls().some((c) => c.startsWith('pr create')));
  assert.deepEqual(t.hooks.map((h) => h.body.state), ['needs-decision']);
});

test('an issue with no repo label is skipped with a comment and handed back', async () => {
  const job = issue(1, { labels: ['Papercut'] });
  const t = setup([job], [[]]);
  await t.run('--once');
  assert.deepEqual(t.piSteps(), []);
  assert.equal(job.state, 'Todo');
  assert.equal(job.delegate, null);
  assert.match(t.bodies(job)[0], /No repo label.*pstack-pi/);
});

test('on start, a stale In Progress job goes back to Todo and runs again', async () => {
  const stale = issue(1, { state: 'In Progress' });
  const notOurs = issue(2, { state: 'In Progress', delegate: 'someone else' });
  const t = setup([stale, notOurs], [[]]);
  await t.run('--once');
  assert.match(t.bodies(stale)[0], /restarted.*back to Todo/);
  assert.match(t.bodies(stale)[1], /^Picked up by/);
  assert.equal(stale.state, 'In Review');
  assert.equal(notOurs.state, 'In Progress');
  assert.deepEqual(notOurs.comments, []);
});

test('--dry-run reports what it would do and writes nothing', async () => {
  const job = issue(1);
  const stale = issue(2, { state: 'In Progress' });
  const t = setup([job, stale], [[]]);
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try { await t.run('--dry-run'); } finally { console.log = log; }
  assert.ok(printed.includes('Would pick up ALE-1 (pstack-pi): Job number 1'));
  assert.ok(printed.includes('Would reset to Todo: ALE-2 Job number 2'));
  assert.equal(job.state, 'Todo');
  assert.equal(stale.state, 'In Progress');
  assert.deepEqual([...job.comments, ...stale.comments], []);
  assert.deepEqual(t.piSteps(), []);
});
