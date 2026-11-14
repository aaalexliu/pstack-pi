import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commands, main, marker, observe, parseEnding, put, quietMinutes, readEnding, renderDecision, renderStatus, startBlock, turns, type Config, type Finding, type Work } from './runner.ts';

type FakeComment = { id: string; body: string; createdAt: string; user: { name: string } };
type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; state: string; delegate: string | null; assignee?: string; labels: string[]; comments: FakeComment[];
};
type Lead = { append?: string; proof?: string; startNote?: string; ending?: unknown; exit?: number };
type Plan = { leads: Lead[]; reviews: (Finding[] | 'invalid')[]; judge?: { decision: string; why: string } };

const RUNNER = 'runner test';
const ALEX = 'Alex Example';
const caused: Finding = { must_fix: true, caused_by_change: true, where: 'work.txt:1', what: 'breaks the thing', done_when: 'the thing works' };
const preexisting: Finding = { must_fix: true, caused_by_change: false, where: 'old.txt:1', what: 'was already broken', done_when: 'a follow-up fixes it' };
const changeEnding = (fullSuite = false) => ({ kind: 'change', full_suite: fullSuite, full_suite_why: 'docs only' });
const change = (fullSuite = false): Lead => ({ append: 'work', proof: 'Ran it and saw it work.', ending: changeEnding(fullSuite) });
const report: Lead = { ending: { kind: 'report', body: 'The answer is 42. Evidence: ran the script.' } };
const ask = { kind: 'decision', question: 'Which storage?', recommendation: 'SQLite, because it is already a dependency.', options: [{ option: 'SQLite', pick_this_if: 'one Mac is enough' }, { option: 'Postgres', pick_this_if: 'two Macs share it' }] };
const STATE_TYPES: Record<string, string> = { Todo: 'unstarted', 'In Progress': 'started', 'In Review': 'started', Done: 'completed', Canceled: 'canceled' };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);

function issue(n: number, fields: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: `id-${n}`, identifier: `ALE-${n}`, title: `Job number ${n}`, description: 'Make it work.\nReport to: desk',
    url: `https://linear.app/x/issue/ALE-${n}`, createdAt: `2026-01-0${n}T00:00:00Z`, team: 'ALE', state: 'Todo',
    delegate: RUNNER, labels: ['pstack-pi'], comments: [], ...fields,
  };
}

const human = (id: string, body: string, minute = 1): FakeComment => ({ id, body, createdAt: `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`, user: { name: 'Alex' } });

function setup(issues: FakeIssue[], plan: Plan, options: { verify?: boolean; repo?: Partial<Config['repos'][string]>; maxLeads?: number; stallMinutes?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-test-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  if (options.verify !== false) {
    mkdirSync(path.join(repo, '.agents'));
    writeFileSync(path.join(repo, '.agents', 'verify'), '#!/bin/sh\nif [ "$(tail -1 work.txt)" = broken ]; then echo verify failed; exit 1; fi\necho verify ok\n', { mode: 0o755 });
  }
  writeFileSync(path.join(repo, 'work.txt'), 'start\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');

  const file = (name: string) => path.join(root, name);
  writeFileSync(file('plan.json'), JSON.stringify(plan));
  writeFileSync(file('pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(file('plan.json'))}, 'utf8'));
const count = (name) => { const f = ${JSON.stringify(root)} + '/count-' + name; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); return n; };
const prompt = args[args.indexOf('--append-system-prompt') + 1];
const model = args[args.indexOf('--model') + 1];
let entry;
let code = 0;
if (prompt.endsWith('lead.md')) {
  const at = args.find((a) => a.startsWith('@'));
  const lead = plan.leads[count('lead')] ?? {};
  if (lead.append) fs.appendFileSync('work.txt', lead.append + '\\n');
  if (lead.proof) fs.writeFileSync('.runner/PROOF.md', lead.proof);
  if (lead.startNote) fs.writeFileSync('.runner/start.md', lead.startNote);
  const input = at ? fs.readFileSync(at.slice(1), 'utf8') : '';
  if (lead.ending !== undefined) fs.writeFileSync(/End this turn by writing (\\S+)\\.$/m.exec(input)[1], typeof lead.ending === 'string' ? lead.ending : JSON.stringify(lead.ending));
  code = lead.exit ?? 0;
  entry = { step: 'lead', input, model, session: args[args.indexOf('--session-id') + 1], cwd: process.cwd(),
    extension: args[args.indexOf('-e') + 1], autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, activity: process.env.PI_SUBAGENT_ACTIVITY_FILE, inherited: process.env.PI_SUBAGENT_NAME ?? null };
} else if (prompt.endsWith('review.md')) {
  const input = args.at(-1);
  const review = plan.reviews[count('review')];
  fs.writeFileSync(/Write the findings to (\\S+)\\.$/m.exec(input)[1], review === 'invalid' ? 'looks good to me' : JSON.stringify(review));
  entry = { step: 'review', input, model };
} else {
  const input = args.at(-1);
  fs.writeFileSync(/verdict to (\\S+)\\.$/m.exec(input)[1], JSON.stringify(plan.judge));
  entry = { step: 'judge', input, model };
}
fs.appendFileSync(${JSON.stringify(file('pi.log'))}, JSON.stringify(entry) + '\\n');
process.exit(code);
`, { mode: 0o755 });
  // Fake tmux: runs a new session to completion. live.json fakes a lead already running in tmux.
  writeFileSync(file('tmux'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const liveFile = ${JSON.stringify(file('live.json'))};
fs.appendFileSync(${JSON.stringify(file('tmux.log'))}, JSON.stringify(args) + '\\n');
const lead = fs.existsSync(liveFile) && JSON.parse(fs.readFileSync(liveFile, 'utf8'));
const target = args[args.indexOf('-t') + 1]?.replace(/^=|:$/g, '');
const mine = lead && lead.name === target;
const finish = () => {
  fs.writeFileSync(lead.dir + '/.runner/turn-' + lead.turn + '/ending.json', JSON.stringify(lead.ending));
  fs.writeFileSync(lead.dir + '/.runner/turn-' + lead.turn + '/exit', '0');
  fs.rmSync(liveFile);
};
if (args[0] === 'new-session') { try { execFileSync('sh', ['-c', args.at(-1)], { cwd: args[args.indexOf('-c') + 1], stdio: 'ignore' }); } catch {} }
else if (args[0] === 'has-session') {
  if (mine && lead.ticks !== undefined) { if (lead.ticks <= 0) { finish(); process.exit(1); } fs.writeFileSync(liveFile, JSON.stringify({ ...lead, ticks: lead.ticks - 1 })); }
  process.exit(mine ? 0 : 1);
}
else if (args[0] === 'kill-session') process.exit(1);
else if (args[0] === 'paste-buffer' && mine && lead.pasteFails) { fs.rmSync(liveFile); process.exit(1); }
else if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && mine) finish();
`, { mode: 0o755 });
  writeFileSync(file('gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const read = (name, fallback) => fs.existsSync(${JSON.stringify(root)} + '/' + name) ? fs.readFileSync(${JSON.stringify(root)} + '/' + name, 'utf8') : fallback;
fs.appendFileSync(${JSON.stringify(file('gh.log'))}, args.join(' ') + '\\n');
const command = args.slice(0, 2).join(' ');
if (command === 'pr list') console.log(read('prs.json', '[]'));
else if (command === 'pr create') console.log('https://github.com/example/repo/pull/7');
else if (command === 'pr view') console.log(read('view.json', '{"state":"OPEN"}'));
else if (command === 'pr merge' && fs.existsSync(${JSON.stringify(file('auto-fails'))})) { console.error('auto-merge is not allowed for this repository'); process.exit(1); }
`, { mode: 0o755 });
  writeFileSync(file('memory_pressure'), `#!/bin/sh\necho "System-wide memory free percentage: $(cat ${JSON.stringify(file('free'))} 2>/dev/null || echo 60)%"\n`, { mode: 0o755 });
  Object.assign(process.env, { JOB_RUNNER_PI: file('pi'), JOB_RUNNER_GH: file('gh'), JOB_RUNNER_TMUX: file('tmux'), JOB_RUNNER_MEMORY_PRESSURE: file('memory_pressure'), PI_SUBAGENT_NAME: 'outer session' });
  writeFileSync(file('hook-key'), 'hook-secret\n');

  const config: Config = {
    linearTokenCommand: 'echo test-token', team: 'ALE', runnerUser: RUNNER, decisionAssignee: ALEX,
    repos: { 'pstack-pi': { path: repo, base: 'main', automerge: false, ...options.repo } },
    webhooks: { desk: { url: 'https://hooks.example/desk', keyFile: file('hook-key') } },
    models: { lead: 'lead-model', review: 'review-model' }, thinking: 'high', pollSeconds: 0.01, maxLeads: options.maxLeads ?? 1,
    minFreeMemoryPercent: 20, stallMinutes: options.stallMinutes ?? 30, host: 'test-host', worktreeRoot: file('worktrees'),
  };
  const hooks: { auth: string; body: Record<string, unknown> }[] = [];
  const relations: { issueId: string; relatedIssueId: string; type: string }[] = [];
  const stateIds: Record<string, string> = Object.fromEntries(Object.keys(STATE_TYPES).map((name) => [`state-${name}`, name]));
  let nextId = 0;
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
    const data = (value: unknown) => Response.json({ data: value });
    if (op === 'Issues') return data({ issues: { nodes: issues.filter((i) => i.team === v.team && i.state === v.state && i.delegate === v.user).map(toWire) } });
    if (op === 'States') return data({ workflowStates: { nodes: Object.entries(stateIds).map(([id, name]) => ({ id, name })) } });
    if (op === 'Team') return data({ teams: { nodes: v.key === 'ALE' ? [{ id: 'team-ale' }] : [] } });
    if (op === 'User') return data({ users: { nodes: v.name === ALEX ? [{ id: 'user-alex' }] : [] } });
    if (op === 'Update') {
      const target = find(v.id);
      if (v.input.stateId) target.state = stateIds[v.input.stateId];
      if ('delegateId' in v.input) target.delegate = v.input.delegateId;
      return data({ issueUpdate: { success: true } });
    }
    if (op === 'Comment') {
      const id = `comment-${++nextId}`;
      find(v.input.issueId).comments.push({ id, body: v.input.body, createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, nextId)).toISOString(), user: { name: RUNNER } });
      return data({ commentCreate: { comment: { id } } });
    }
    if (op === 'EditComment') {
      issues.flatMap((i) => i.comments).find((c) => c.id === v.id)!.body = v.input.body;
      return data({ commentUpdate: { success: true } });
    }
    if (op === 'Comments') return data({ issue: { comments: { nodes: find(v.id).comments } } });
    const wireIssue = (i: FakeIssue) => ({ id: i.id, identifier: i.identifier, url: i.url, state: { type: STATE_TYPES[i.state] },
      relations: { nodes: relations.filter((r) => r.issueId === i.id).map((r) => ({ type: r.type, relatedIssue: { id: r.relatedIssueId } })) } });
    if (op === 'FindMarked') return data({ issues: { nodes: issues.filter((i) => i.team === v.team && i.description.includes(v.mark)).slice(0, 1).map(wireIssue) } });
    if (op === 'CreateIssue') {
      assert.equal(v.input.teamId, 'team-ale');
      const n = 100 + ++nextId;
      const created = issue(n, { id: `id-${n}`, identifier: `ALE-${n}`, title: v.input.title, description: v.input.description, url: `https://linear.app/x/issue/ALE-${n}`,
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, nextId)).toISOString(), delegate: null, labels: [], assignee: v.input.assigneeId });
      issues.push(created);
      return data({ issueCreate: { issue: wireIssue(created) } });
    }
    if (op === 'Relate') { relations.push(v.input); return data({ issueRelationCreate: { success: true } }); }
    throw new Error(`unexpected Linear operation ${op}`);
  };
  const calls = () => lines(file('pi.log')).map((line) => JSON.parse(line));
  const dirOf = (n: number) => path.join(config.worktreeRoot, `job-ale-${n}-job-number-${n}`);
  return {
    config, hooks, relations, origin, root, file, dirOf,
    run: (...argv: string[]) => main(argv, config, fakeFetch as typeof fetch),
    steps: () => calls().map((c) => c.step as string),
    leads: () => calls().filter((c) => c.step === 'lead'),
    inputs: (step: string) => calls().filter((c) => c.step === step).map((c) => c.input as string),
    gh: () => lines(file('gh.log')),
    tmux: () => lines(file('tmux.log')).map((line) => JSON.parse(line) as string[]),
    decisions: () => issues.filter((i) => Number(i.identifier.slice(4)) > 100),
    bodies: (i: FakeIssue) => i.comments.map((c) => c.body),
    setFreeMemory: (percent: number) => writeFileSync(file('free'), `${percent}\n`),
    goLive: (lead: Record<string, unknown>) => writeFileSync(file('live.json'), JSON.stringify(lead)),
    /** A worktree as an earlier runner left it, with the given `.runner/` files. */
    worktree: (n: number, files: Record<string, string>) => {
      const dir = dirOf(n);
      git(repo, 'worktree', 'add', '-q', '-b', `job/ale-${n}-job-number-${n}`, dir, 'origin/main');
      mkdirSync(path.join(dir, '.runner'));
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, '.runner', name)), { recursive: true });
        writeFileSync(path.join(dir, '.runner', name), content);
      }
      return dir;
    },
  };
}

test('picks up only the oldest Todo issue delegated to the runner, one per lead slot', async () => {
  const target = issue(1);
  const newer = issue(2);
  const otherDelegate = issue(3, { delegate: 'someone else' });
  const inReview = issue(4, { state: 'In Review' });
  const otherTeam = issue(5, { team: 'OPS' });
  const t = setup([newer, otherDelegate, inReview, target, otherTeam], { leads: [change()], reviews: [[]] });
  await t.run('--once');
  assert.equal(target.state, 'In Review');
  for (const untouched of [newer, otherDelegate, otherTeam]) {
    assert.equal(untouched.state, 'Todo');
    assert.deepEqual(untouched.comments, []);
  }
  assert.deepEqual(inReview.comments, []);
});

test('the lead runs in a tmux session named for the issue, with the saved session id, auto-exit and an activity file', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [{ ...change(), startNote: 'Goal: make it work. Not doing: docs.' }], reviews: [[preexisting]] });
  await t.run('--once');
  const [lead] = t.leads();
  const dir = t.dirOf(1);
  assert.equal(lead.session, readFileSync(path.join(dir, '.runner', 'session-id'), 'utf8'));
  assert.match(lead.session, /^[0-9a-f-]{36}$/);
  assert.equal(lead.cwd, realpathSync(dir));
  assert.equal(lead.autoExit, '1');
  assert.equal(lead.activity, path.join(dir, '.runner', 'activity.json'));
  assert.ok(existsSync(lead.extension) && lead.extension.endsWith('subagent-done.ts'));
  assert.equal(lead.inherited, null, 'Pi variables from the tmux server environment are dropped');
  const started = t.tmux().find((args) => args[0] === 'new-session')!;
  assert.deepEqual(started.slice(0, 4), ['new-session', '-d', '-s', 'ALE-1']);
  assert.equal(started[started.indexOf('-c') + 1], dir);
  assert.equal(job.comments.filter((c) => c.body.startsWith('Start note from the lead:')).length, 1);
  const status = job.comments.filter((c) => c.body.startsWith('**Runner:**'));
  assert.equal(status.length, 1, 'one status comment, edited in place');
  assert.match(status[0].body, /^\*\*Runner:\*\* PR ready for review: https:\/\/github.com\/example\/repo\/pull\/7/);
  assert.ok(status[0].body.includes(`Session id: \`${lead.session}\``));
  assert.ok(status[0].body.includes("ssh -t test-host 'tmux attach -t =ALE-1'"));
  const create = t.gh().find((c) => c.startsWith('pr create'))!;
  assert.match(create, /--head job\/ale-1-job-number-1/);
  assert.match(git(t.origin, 'log', '--format=%s', 'job/ale-1-job-number-1'), /ALE-1: Job number 1/);
  assert.equal(job.state, 'In Review');
  assert.equal(job.delegate, null);
  assert.deepEqual(t.hooks, [{ auth: 'Bearer hook-secret', body: { issue: 'ALE-1', url: job.url, state: 'ready', pr: 'https://github.com/example/repo/pull/7' } }]);
  assert.deepEqual(turns({ dir }), [1], 'one turn: the task');
  assert.equal(readFileSync(path.join(dir, '.runner', 'turn-1', 'exit'), 'utf8').trim(), '0');
  assert.match(readFileSync(path.join(dir, '.runner', 'turn-1', 'input.md'), 'utf8'), /End this turn by writing \.runner\/turn-1\/ending\.json\.$/);
});

test('a caused must-fix resumes the same lead session, and round 2 reviews only the fix', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [change(), change()], reviews: [[caused], []] });
  await t.run('--once');
  assert.deepEqual(t.steps(), ['lead', 'review', 'lead', 'review']);
  const [first, second] = t.leads();
  assert.equal(second.session, first.session);
  assert.match(second.input, /^Review round 1 found problems your change caused/);
  assert.match(second.input, /breaks the thing/);
  assert.match(t.inputs('review')[1], /Review round 2\. Review only the latest fix: git diff [0-9a-f]{40}\.\.HEAD/);
  assert.equal(job.state, 'In Review');
});

test('at the round cap the judge may only cut or ask, never ship', async (s) => {
  const rounds = { leads: [change(), change(), change(), change()], reviews: [[caused], [caused], [caused], [caused]] };
  await s.test('cut resumes the lead for a fresh review round, and findings after that go to Alex', async () => {
    const job = issue(1);
    const t = setup([job], { ...rounds, judge: { decision: 'cut', why: 'drop the second screen' } });
    await t.run('--once');
    assert.deepEqual(t.steps(), ['lead', 'review', 'lead', 'review', 'lead', 'review', 'judge', 'lead', 'review']);
    assert.match(t.leads()[3].input, /says cut scope: drop the second screen/);
    assert.match(t.inputs('review')[3], /Review round 4\. Review only the latest fix/);
    assert.match(t.decisions()[0].title, /after the judge cut the scope/);
    assert.ok(!t.gh().some((c) => c.startsWith('pr ')));
  });
  await s.test('ask files a Decision issue, opens no PR, and keeps the verdict outside the worktree', async () => {
    const job = issue(1);
    const t = setup([job], { ...rounds, judge: { decision: 'ask', why: 'scope call' } });
    await t.run('--once');
    assert.match(t.decisions()[0].description, /\*\*Recommendation:\*\* scope call/);
    assert.ok(!t.gh().some((c) => c.startsWith('pr ')));
    assert.equal(job.state, 'In Progress');
    assert.match(t.inputs('judge')[0], new RegExp(`verdict to ${path.join(t.config.worktreeRoot, '.judge', 'ALE-1-3.json').replaceAll('.', '\\.')}\\.`));
    assert.ok(existsSync(path.join(t.config.worktreeRoot, '.judge', 'ALE-1-3.json')), 'the verdict sits outside the lead\'s worktree');
  });
  await s.test('ship is not a verdict: it files a Decision issue and opens no PR', async () => {
    const job = issue(1);
    const t = setup([job], { ...rounds, judge: { decision: 'ship', why: 'small and safe' } });
    await t.run('--once');
    assert.match(t.decisions()[0].description, /no valid verdict/);
    assert.ok(!t.gh().some((c) => c.startsWith('pr ')));
  });
});

test('a report ending posts the body and marks the ticket Done', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [report], reviews: [] });
  await t.run('--once');
  assert.deepEqual(t.steps(), ['lead']);
  assert.ok(t.bodies(job).includes('The answer is 42. Evidence: ran the script.'));
  assert.equal(job.state, 'Done');
  assert.equal(job.delegate, null);
  assert.deepEqual(t.gh(), []);
  assert.equal(t.hooks[0].body.state, 'done');
});

test('a decision ending waits without a slot, then a Done Decision resumes the same session with Alex\'s comments', async () => {
  const job = issue(1);
  const next = issue(2);
  const t = setup([job, next], { leads: [{ ending: ask }, report, report], reviews: [] });
  await t.run('--once');
  const [decision] = t.decisions();
  assert.equal(decision.assignee, 'user-alex');
  assert.equal(decision.title, 'Decision for ALE-1: Which storage?');
  assert.match(decision.description, /\*\*Recommendation:\*\* SQLite[\s\S]*1\. \*\*SQLite\*\*\. Pick this if one Mac is enough\n2\. \*\*Postgres\*\*/);
  assert.deepEqual(t.relations, [{ issueId: decision.id, relatedIssueId: 'id-1', type: 'blocks' }]);
  assert.equal(job.state, 'In Progress');
  assert.equal(job.delegate, RUNNER);

  await t.run('--once');
  assert.equal(next.state, 'Done', 'the waiting ticket held no slot');
  assert.equal(t.leads().length, 2);
  assert.equal(t.decisions().length, 1, 'a replay files no second Decision issue');

  decision.comments.push({ id: 'alex-1', body: 'Go with SQLite.', createdAt: '2026-03-02T00:00:00Z', user: { name: ALEX } });
  decision.state = 'Done';
  await t.run('--once');
  const resumed = t.leads()[2];
  assert.equal(resumed.session, t.leads()[0].session);
  assert.match(resumed.input, /Decision issue ALE-\d+ .* is Done\. The comments on it:\n- Alex Example: Go with SQLite\./);
  assert.equal(job.state, 'Done');
});

test('a Decision issue filed but never linked is found by its marker, linked, and not filed again', async () => {
  const job = issue(1, { state: 'In Progress' });
  const orphan = issue(150, { title: 'Decision for ALE-1: Which storage?', description: `Filed before a crash.\n\n${marker('decision', 'ALE-1', 1)}`, delegate: null, labels: [] });
  const t = setup([job, orphan], { leads: [], reviews: [] });
  t.worktree(1, { 'session-id': 'session-1', 'turn-1/input.md': 'Do it.', 'turn-1/launched': 'x', 'turn-1/exit': '0', 'turn-1/ending.json': JSON.stringify(ask) });
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual(t.decisions().map((d) => d.identifier), ['ALE-150']);
  assert.deepEqual(t.relations, [{ issueId: 'id-150', relatedIssueId: 'id-1', type: 'blocks' }]);
  assert.equal(job.state, 'In Progress');
  assert.deepEqual(t.steps(), []);
});

test('a Canceled Decision stops the ticket and hands it back instead of resuming the lead', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [{ ending: ask }, report], reviews: [] });
  await t.run('--once');
  t.decisions()[0].state = 'Canceled';
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(job.state, 'Todo');
  assert.equal(job.delegate, null);
  assert.ok(t.bodies(job).some((b) => /ALE-\d+ was canceled, so the runner stopped ALE-1/.test(b)));
});

test('a missing or invalid ending, or a Pi that exited with an error, becomes a Decision issue', async (s) => {
  for (const [name, lead, pattern] of [
    ['missing', {}, /exited without writing \.runner\/ending\.json/],
    ['invalid', { ending: changeEnding() }, /needs a non-empty \.runner\/PROOF\.md/],
    ['failed Pi', { ...change(), exit: 3 }, /Pi exited with code 3/],
  ] as const) {
    await s.test(name, async () => {
      const job = issue(1);
      const t = setup([job], { leads: [lead], reviews: [] });
      await t.run('--once');
      assert.match(t.decisions()[0].description, pattern);
      assert.deepEqual(t.steps(), ['lead']);
      assert.equal(job.state, 'In Progress');
      assert.deepEqual(t.gh(), []);
    });
  }
});

test('verify fails closed: no .agents/verify means no merge unless the repo says CI is the gate', async (s) => {
  await s.test('without ciGate', async () => {
    const t = setup([issue(1)], { leads: [change()], reviews: [[]] }, { verify: false, repo: { automerge: true } });
    await t.run('--once');
    assert.deepEqual(t.steps(), ['lead']);
    assert.match(t.decisions()[0].title, /no executable \.agents\/verify, so the runner will not merge/);
    assert.deepEqual(t.gh(), []);
  });
  await s.test('with ciGate', async () => {
    const t = setup([issue(1)], { leads: [change()], reviews: [[]] }, { verify: false, repo: { automerge: true, ciGate: true } });
    await t.run('--once');
    assert.match(t.inputs('review')[0], /Verify: no \.agents\/verify; CI is the gate/);
    assert.deepEqual(t.gh().filter((c) => c.startsWith('pr merge')), ['pr merge https://github.com/example/repo/pull/7 --auto --squash']);
  });
});

test('when auto-merge will not turn on and checks are pending, the runner never merges directly', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [change()], reviews: [[]] }, { repo: { automerge: true } });
  writeFileSync(t.file('auto-fails'), '');
  await t.run('--once');
  assert.deepEqual(t.gh().filter((c) => c.startsWith('pr merge')), ['pr merge https://github.com/example/repo/pull/7 --auto --squash']);
  assert.match(t.decisions()[0].title, /would not turn on auto-merge/);
  assert.match(t.decisions()[0].description, /auto-merge is not allowed for this repository/);
  assert.equal(job.state, 'In Progress');
});

test('an open PR for the branch is reused, not opened again', async () => {
  const t = setup([issue(1)], { leads: [change()], reviews: [[]] });
  writeFileSync(t.file('prs.json'), JSON.stringify([{ url: 'https://github.com/example/repo/pull/5', state: 'OPEN' }]));
  await t.run('--once');
  assert.ok(!t.gh().some((c) => c.startsWith('pr create')));
  assert.ok(t.gh().includes('pr edit https://github.com/example/repo/pull/5 --body-file .runner/pr.md'));
});

test('a failed verify goes back to the lead before any review', async () => {
  const t = setup([issue(1)], { leads: [{ ...change(), append: 'broken' }, { ...change(), append: 'fixed' }], reviews: [[]] });
  await t.run('--once');
  assert.deepEqual(t.steps(), ['lead', 'lead', 'review']);
  assert.match(t.leads()[1].input, /^\.agents\/verify failed[\s\S]*verify failed/);
  assert.match(t.inputs('review')[0], /Review round 1\. Review the whole change/);
});

test('the full-suite label goes on the PR only when the lead asks and the repo names one', async () => {
  for (const [fullSuite, label, expected] of [[true, 'full-suite', true], [false, 'full-suite', false], [true, undefined, false]] as const) {
    const t = setup([issue(1)], { leads: [change(fullSuite)], reviews: [[]] }, { repo: { fullSuiteLabel: label } });
    await t.run('--once');
    assert.equal(t.gh().includes('pr edit https://github.com/example/repo/pull/7 --add-label full-suite'), expected);
  }
});

test('model lines in the issue override the configured models', async () => {
  const job = issue(1, { description: 'Make it work.\nReview model: openai/gpt-6.1-sol\nLead model: xai/grok-4.7' });
  const t = setup([job], { leads: [change()], reviews: [[]] });
  await t.run('--once');
  assert.deepEqual(t.leads().map((c) => c.model), ['xai/grok-4.7']);
  assert.equal(JSON.parse(lines(t.file('pi.log'))[1]).model, 'openai/gpt-6.1-sol');
});

test('the lead sees human comments once, never the runner\'s own', async () => {
  const job = issue(1, { comments: [human('human-1', 'Keep the old flag.')] });
  const t = setup([job], { leads: [change(), change()], reviews: [[caused], []] });
  await t.run('--once');
  assert.match(t.leads()[0].input, /New comments on the issue:\n- Alex: Keep the old flag\./);
  assert.doesNotMatch(t.leads()[1].input, /Keep the old flag|Runner:/);
});

test('a review that writes no valid JSON is a Decision issue, not a clean review', async () => {
  const t = setup([issue(1)], { leads: [change()], reviews: ['invalid'] });
  await t.run('--once');
  assert.match(t.decisions()[0].description, /no valid findings JSON/);
  assert.ok(!t.gh().some((c) => c.startsWith('pr create')));
});

test('an issue with no repo label is skipped with a comment and handed back', async () => {
  const job = issue(1, { labels: ['Papercut'] });
  const t = setup([job], { leads: [], reviews: [] });
  await t.run('--once');
  assert.deepEqual(t.steps(), []);
  assert.equal(job.delegate, null);
  assert.match(t.bodies(job)[0], /No repo label.*pstack-pi/);
});

test('the runner rebuilds each ticket from its worktree, tmux and Linear', async (s) => {
  await s.test('a finished ending is consumed before Pi ever starts again', async () => {
    const job = issue(1, { state: 'In Progress' });
    const t = setup([job], { leads: [], reviews: [] });
    t.worktree(1, { 'session-id': 'session-1', 'turn-1/input.md': 'Do it.', 'turn-1/launched': 'x', 'turn-1/exit': '0', 'turn-1/ending.json': JSON.stringify({ kind: 'report', body: 'Already done.' }) });
    await t.run('--once');
    assert.deepEqual(t.steps(), []);
    assert.ok(t.bodies(job).includes('Already done.'));
    assert.equal(job.state, 'Done');
  });
  await s.test('an older turn counts as consumed: only the newest turn is acted on', async () => {
    const job = issue(1, { state: 'In Progress' });
    const t = setup([job], { leads: [report], reviews: [] });
    t.worktree(1, {
      'session-id': 'session-1',
      'turn-1/input.md': 'Do it.', 'turn-1/exit': '0', 'turn-1/ending.json': JSON.stringify({ kind: 'report', body: 'Old report.' }),
      'turn-2/input.md': 'Review round 1 found problems.\n\nEnd this turn by writing .runner/turn-2/ending.json.', 'turn-2/cause.json': '{"cause":"findings","round":1}',
    });
    await t.run('--once');
    assert.match(t.leads()[0].input, /^Review round 1 found problems/);
    assert.ok(!t.bodies(job).includes('Old report.'));
  });
  await s.test('a turn launched but never finished runs again in the same session', async () => {
    const job = issue(1, { state: 'In Progress' });
    const t = setup([job], { leads: [report], reviews: [] });
    t.worktree(1, { 'session-id': 'session-1', 'turn-1/input.md': 'Original task.\n\nEnd this turn by writing .runner/turn-1/ending.json.', 'turn-1/launched': 'x' });
    await t.run('--once');
    const [lead] = t.leads();
    assert.equal(lead.session, 'session-1');
    assert.match(lead.input, /^The runner restarted while you worked on the message below[\s\S]*---\n\nOriginal task\./);
    assert.deepEqual(turns({ dir: t.dirOf(1) }), [1], 'the restart is the same turn, not a new one');
    assert.equal(job.state, 'Done');
  });
  await s.test('a live tmux session is waited on, and new comments are pasted into it', async () => {
    const job = issue(1, { state: 'In Progress', comments: [human('human-1', 'Use the blue icon.')] });
    const t = setup([job], { leads: [], reviews: [] });
    const dir = t.worktree(1, { 'session-id': 'session-1', 'turn-1/input.md': 'Do it.', 'turn-1/launched': 'x' });
    t.goLive({ name: 'ALE-1', dir, turn: 1, ending: { kind: 'report', body: 'Blue icon done.' } });
    await t.run('--once');
    assert.deepEqual(t.steps(), [], 'a live lead is not started again');
    assert.equal(t.tmux().find((args) => args[0] === 'set-buffer')!.at(-1), 'Comment from Alex on ALE-1:\nUse the blue icon.');
    assert.ok(t.tmux().some((args) => args.join(' ') === 'paste-buffer -p -d -b runner-ALE-1 -t =ALE-1:'));
    assert.ok(t.tmux().filter((args) => args[0] === 'has-session').every((args) => args[2] === '=ALE-1'));
    assert.equal(JSON.parse(readFileSync(path.join(dir, '.runner', 'delivered.json'), 'utf8')).id, 'human-1');
    assert.ok(t.bodies(job).includes('Blue icon done.'));
  });
  await s.test('an In Progress ticket with no worktree starts fresh instead of going back to Todo', async () => {
    const job = issue(1, { state: 'In Progress' });
    const t = setup([job], { leads: [report], reviews: [] });
    await t.run('--once');
    assert.match(t.leads()[0].input, /^Issue ALE-1: Job number 1/);
    assert.equal(job.state, 'Done');
  });
  await s.test('an existing worktree is reused, never removed', async () => {
    const job = issue(1);
    const t = setup([job], { leads: [report], reviews: [] });
    const dir = t.worktree(1, {});
    writeFileSync(path.join(dir, 'uncommitted.txt'), 'keep me');
    await t.run('--once');
    assert.equal(readFileSync(path.join(dir, 'uncommitted.txt'), 'utf8'), 'keep me');
    assert.equal(job.state, 'Done');
  });
});

test('a comment whose paste fails stays undelivered and reaches the lead\'s next turn', async () => {
  const job = issue(1, { state: 'In Progress', comments: [human('human-1', 'Use the blue icon.')] });
  const t = setup([job], { leads: [report], reviews: [] });
  const dir = t.worktree(1, { 'session-id': 'session-1', 'turn-1/input.md': 'Do it.\n\nEnd this turn by writing .runner/turn-1/ending.json.', 'turn-1/launched': 'x', 'delivered.json': JSON.stringify({ id: 'old', createdAt: '2026-01-01T00:00:00Z' }) });
  t.goLive({ name: 'ALE-1', dir, turn: 1, ending: {}, pasteFails: true });
  await t.run('--once');
  assert.match(t.leads()[0].input, /New comments on the issue:\n- Alex: Use the blue icon\./);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.runner', 'delivered.json'), 'utf8')).id, 'human-1');
});

test('a lead quiet for stallMinutes gets a status line and one issue for Alex, and keeps running', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { leads: [], reviews: [] }, { stallMinutes: 5 });
  const dir = t.worktree(1, { 'session-id': 'session-1', 'turn-1/input.md': 'Do it.', 'turn-1/launched': 'x', 'activity.json': JSON.stringify({ updatedAt: Date.now() - 10 * 60000 }) });
  const old = new Date(Date.now() - 10 * 60000);
  utimesSync(path.join(dir, '.runner', 'turn-1', 'launched'), old, old);
  t.goLive({ name: 'ALE-1', dir, turn: 1, ending: { kind: 'report', body: 'Finally done.' }, ticks: 3 });
  await t.run('--once');
  const stall = t.decisions().filter((d) => d.title === 'Check ALE-1: the lead looks stuck');
  assert.equal(stall.length, 1);
  assert.match(stall[0].description, /no activity for 10 minutes/);
  assert.ok(stall[0].description.endsWith(marker('stall', 'ALE-1', 1)));
  assert.ok(t.bodies(job).includes('Finally done.'));
});

test('low free memory starts no lead, and the runner says why once', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [report], reviews: [] });
  t.setFreeMemory(12);
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try { await t.run('--once'); } finally { console.log = log; }
  assert.deepEqual(printed, ['Not starting ALE-1 yet: only 12% of memory is free, under the 20% floor']);
  assert.deepEqual(t.steps(), []);
  assert.equal(job.state, 'Todo');
});

test('only one running ticket may need the screen', async () => {
  const first = issue(1, { description: 'Make it work.\nNeeds: screen' });
  const second = issue(2, { description: 'Make it work.\nNeeds: screen' });
  const third = issue(3);
  const t = setup([first, second, third], { leads: [report, report], reviews: [] }, { maxLeads: 3 });
  await t.run('--once');
  assert.deepEqual([first.state, second.state, third.state], ['Done', 'Todo', 'Done']);
});

test('--dry-run reports what it would do and writes nothing', async () => {
  const job = issue(1);
  const fresh = issue(2, { state: 'In Progress' });
  const t = setup([job, fresh], { leads: [], reviews: [] });
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try { await t.run('--dry-run'); } finally { console.log = log; }
  assert.ok(printed.includes('Would pick up ALE-1 (pstack-pi): Job number 1'));
  assert.ok(printed.includes('ALE-2: start'));
  assert.equal(job.state, 'Todo');
  assert.deepEqual([...job.comments, ...fresh.comments], []);
  assert.deepEqual(t.steps(), []);
  assert.ok(!existsSync(t.config.worktreeRoot));
});

const work = (dir: string): Work => ({ id: 'id-7', key: 'ALE-7', title: 'x', url: 'u', description: '', repo: 'r', branch: 'job/ale-7-x', dir, models: { lead: 'l', review: 'r' } });

test('observe reads the next step from the turn folders, tmux and the turn\'s marked Decision issue', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-observe-'));
  const w = work(dir);
  const none = async () => null;
  const files = (entries: Record<string, string>) => {
    for (const [n, c] of Object.entries(entries)) { mkdirSync(path.dirname(path.join(dir, '.runner', n)), { recursive: true }); writeFileSync(path.join(dir, '.runner', n), c); }
  };
  assert.equal((await observe(w, false, none)).kind, 'start');
  files({ 'session-id': 's' });
  assert.equal((await observe(w, false, none)).kind, 'start');
  assert.equal((await observe(w, true, none)).kind, 'running');
  files({ 'turn-1/input.md': 'x' });
  assert.deepEqual(await observe(w, false, none), { kind: 'launch', turn: 1 });
  files({ 'turn-1/launched': 'x' });
  assert.deepEqual(await observe(w, false, none), { kind: 'relaunch', turn: 1 });
  files({ 'turn-1/ending.json': '{}' });
  assert.deepEqual(await observe(w, false, none), { kind: 'consume', turn: 1 }, 'an ending with no exit is consumed, never relaunched');
  files({ 'turn-1/exit': '0' });
  const asked: number[] = [];
  const decision = (state: string) => async (turn: number) => { asked.push(turn); return { id: 'd1', identifier: 'ALE-9', url: 'u', state, blocks: [] }; };
  assert.equal((await observe(w, false, decision('unstarted'))).kind, 'waiting');
  assert.equal((await observe(w, false, decision('completed'))).kind, 'answer');
  assert.equal((await observe(w, false, decision('canceled'))).kind, 'stop');
  assert.deepEqual(asked, [1, 1, 1], 'the Decision issue is looked up by the newest turn');
  files({ 'turn-2/input.md': 'answer' });
  assert.deepEqual(await observe(w, false, decision('completed')), { kind: 'launch', turn: 2 }, 'a new turn consumes the answered one');
});

test('the Decision marker tells turn 3 from turn 30 and ALE-9 from ALE-93', () => {
  assert.equal(marker('decision', 'ALE-93', 3), 'runner-decision ALE-93 turn 3 end');
  assert.ok(!marker('decision', 'ALE-93', 30).includes(marker('decision', 'ALE-93', 3)));
  assert.ok(!marker('decision', 'ALE-93', 3).includes(marker('decision', 'ALE-9', 3)));
});

test('parseEnding and readEnding accept the three endings only from a Pi that exited 0', () => {
  assert.deepEqual(parseEnding('{"kind":"report","body":" hi "}', ''), { kind: 'report', body: 'hi' });
  assert.deepEqual(parseEnding('{"kind":"change","full_suite":true,"full_suite_why":"touches the build"}', 'proof'), { kind: 'change', full_suite: true, full_suite_why: 'touches the build' });
  assert.deepEqual(parseEnding(JSON.stringify(ask), ''), { ...ask });
  assert.deepEqual(parseEnding('{"kind":"decision","question":"Run Touch ID?","recommendation":"Run it on the release build."}', ''),
    { kind: 'decision', question: 'Run Touch ID?', recommendation: 'Run it on the release build.', options: [] });
  for (const [text, proof, error] of [
    [null, '', /without writing/],
    ['not json', '', /not valid JSON/],
    ['{"kind":"done"}', '', /needs "kind"/],
    ['{"kind":"report","body":""}', '', /needs a "body"/],
    ['{"kind":"change","full_suite":false,"full_suite_why":"x"}', '', /PROOF\.md/],
    ['{"kind":"change","full_suite":"no","full_suite_why":"x"}', 'proof', /"full_suite"/],
    ['{"kind":"decision","question":"Q"}', '', /"recommendation"/],
    [JSON.stringify({ ...ask, options: [1, 2, 3, 4].map((n) => ({ option: `o${n}`, pick_this_if: 'x' })) }), '', /at most 3 options/],
    [JSON.stringify({ ...ask, options: [{ option: 'SQLite' }] }), '', /"pick_this_if"/],
  ] as const) {
    const result = parseEnding(text, proof);
    assert.ok('error' in result, `${text} should fail`);
    assert.match(result.error, error);
  }
  const good = '{"kind":"report","body":"hi"}';
  assert.deepEqual(readEnding('0', good, ''), { kind: 'report', body: 'hi' });
  assert.deepEqual(readEnding('1', good, ''), { error: 'Pi exited with code 1' });
  assert.match((readEnding(null, good, '') as { error: string }).error, /without an exit record/);
});

test('status commands survive a worktree path with spaces and an apostrophe in a real shell', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-quote-'));
  const dir = path.join(root, "Work Projects", "it's", 'job-ale-7-x');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'job/ale-7-x');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'init');
  mkdirSync(path.join(dir, '.runner'));
  const fakes = path.join(root, 'bin');
  mkdirSync(fakes);
  // ssh hands its command to the remote shell; this one runs it here.
  writeFileSync(path.join(fakes, 'ssh'), '#!/bin/sh\nshift 2\nexec sh -c "$*"\n', { mode: 0o755 });
  writeFileSync(path.join(fakes, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(root, 'tmux-args'))}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${fakes}:${process.env.PATH}` };
  const c = commands({ key: 'ALE-7', dir, branch: 'job/ale-7-x' }, 'abc-123', 'mini');
  execFileSync('sh', ['-c', c.takeOver], { env });
  assert.ok(existsSync(path.join(dir, '.runner', 'takeover')));
  assert.deepEqual(readFileSync(path.join(root, 'tmux-args'), 'utf8').trim().split('\n'), ['attach', '-t', '=ALE-7']);
  execFileSync('sh', ['-c', c.quiz], { env, stdio: 'ignore' });
  assert.equal(git(`${dir}-quiz`, 'rev-parse', '--abbrev-ref', 'HEAD'), 'job/ale-7-x-quiz');
  assert.deepEqual(readFileSync(path.join(root, 'tmux-args'), 'utf8').trim().split('\n'), ['new', '-s', 'ALE-7-quiz', 'pi', '--fork', 'abc-123']);
  const body = renderStatus({ key: 'ALE-7', dir: '/w/job-ale-7', branch: 'job/ale-7-x' }, 'abc-123', 'mini', 'Lead running');
  assert.equal(body.split('\n')[0], '**Runner:** Lead running');
  assert.ok(body.includes("`ssh -t mini 'tmux attach -t =ALE-7'`"));
});

test('renderDecision keeps the recommendation first, says what Done and Canceled do, and shortens long titles', () => {
  const { title, body } = renderDecision({ key: 'ALE-7', url: 'https://linear.app/x/issue/ALE-7' }, { question: 'Q'.repeat(100), recommendation: 'Do R.', options: [] });
  assert.equal(title.length, 'Decision for ALE-7: '.length + 80);
  assert.ok(body.indexOf('**Recommendation:**') < body.indexOf('mark this issue Done'));
  assert.match(body, /Canceling this issue stops ALE-7 and hands it back/);
});

test('startBlock enforces lead slots, free memory and the one screen', () => {
  const base = { running: 0, maxLeads: 2, freeMemory: 40, minFreeMemory: 20, needsScreen: false, screenTaken: false };
  assert.equal(startBlock(base), null);
  assert.match(startBlock({ ...base, running: 2 }) ?? '', /slots are busy/);
  assert.match(startBlock({ ...base, freeMemory: 19 }) ?? '', /only 19% of memory is free/);
  assert.equal(startBlock({ ...base, freeMemory: 20 }), null);
  assert.match(startBlock({ ...base, needsScreen: true, screenTaken: true }) ?? '', /screen/);
  assert.equal(startBlock({ ...base, needsScreen: false, screenTaken: true }), null);
});

test('quietMinutes counts from the later of the turn start and the last activity', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-quiet-'));
  const now = Date.now();
  mkdirSync(path.join(dir, '.runner', 'turn-1'), { recursive: true });
  writeFileSync(path.join(dir, '.runner', 'turn-1', 'launched'), 'x');
  const old = new Date(now - 60 * 60000);
  utimesSync(path.join(dir, '.runner', 'turn-1', 'launched'), old, old);
  assert.equal(quietMinutes({ dir }, 1, now), 60);
  writeFileSync(path.join(dir, '.runner', 'activity.json'), JSON.stringify({ updatedAt: now - 7 * 60000 }));
  assert.equal(quietMinutes({ dir }, 1, now), 7);
});

test('put replaces a file whole and leaves no temp file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-put-'));
  put(path.join(dir, 'a.json'), 'one');
  put(path.join(dir, 'a.json'), 'two');
  assert.equal(readFileSync(path.join(dir, 'a.json'), 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['a.json']);
});
