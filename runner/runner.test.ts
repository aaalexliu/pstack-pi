import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { answered, main, parseEnding, renderDecision, renderStatus, startBlock, type Config, type Finding, type Ticket } from './runner.ts';

type FakeComment = { id: string; body: string; createdAt: string; user: { name: string } };
type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; state: string; delegate: string | null; assignee?: string; labels: string[]; comments: FakeComment[];
};
type Lead = { append?: string; proof?: string; startNote?: string; ending?: unknown };
type Plan = { leads: Lead[]; reviews: (Finding[] | 'invalid')[]; judge?: { decision: string; why: string } };

const RUNNER = 'runner test';
const ALEX = 'Alex Example';
const caused: Finding = { must_fix: true, caused_by_change: true, where: 'work.txt:1', what: 'breaks the thing', done_when: 'the thing works' };
const preexisting: Finding = { must_fix: true, caused_by_change: false, where: 'old.txt:1', what: 'was already broken', done_when: 'a follow-up fixes it' };
const change = (fullSuite = false): Lead => ({ append: 'work', proof: 'Ran it and saw it work.', ending: { kind: 'change', full_suite: fullSuite, full_suite_why: 'docs only' } });
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

function setup(issues: FakeIssue[], plan: Plan, options: { verify?: boolean; repo?: Partial<Config['repos'][string]>; maxLeads?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-test-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  if (options.verify !== false) {
    mkdirSync(path.join(repo, '.agents'));
    writeFileSync(path.join(repo, '.agents', 'verify'), '#!/bin/sh\necho verify ok\n', { mode: 0o755 });
  }
  writeFileSync(path.join(repo, 'work.txt'), 'start\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');

  const file = (name: string) => path.join(root, name);
  const setPlan = (next: Plan) => writeFileSync(file('plan.json'), JSON.stringify(next));
  setPlan(plan);
  writeFileSync(file('pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(file('plan.json'))}, 'utf8'));
const count = (name) => { const f = ${JSON.stringify(root)} + '/count-' + name; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); return n; };
const prompt = args[args.indexOf('--append-system-prompt') + 1];
const model = args[args.indexOf('--model') + 1];
let entry;
if (prompt.endsWith('lead.md')) {
  const at = args.find((a) => a.startsWith('@'));
  const lead = plan.leads[count('lead')] ?? {};
  if (lead.append) fs.appendFileSync('work.txt', lead.append + '\\n');
  if (lead.proof) fs.writeFileSync('.runner/PROOF.md', lead.proof);
  if (lead.startNote) fs.writeFileSync('.runner/start.md', lead.startNote);
  if (lead.ending !== undefined) fs.writeFileSync('.runner/ending.json', typeof lead.ending === 'string' ? lead.ending : JSON.stringify(lead.ending));
  entry = { step: 'lead', input: at ? fs.readFileSync(at.slice(1), 'utf8') : '', model, session: args[args.indexOf('--session-id') + 1], cwd: process.cwd(),
    extension: args[args.indexOf('-e') + 1], autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, activity: process.env.PI_SUBAGENT_ACTIVITY_FILE, inherited: process.env.PI_SUBAGENT_NAME ?? null };
} else if (prompt.endsWith('review.md')) {
  const input = args.at(-1);
  const round = /findings-(\\d+)\\.json/.exec(input)[1];
  const review = plan.reviews[round - 1];
  fs.writeFileSync('.runner/findings-' + round + '.json', review === 'invalid' ? 'looks good to me' : JSON.stringify(review));
  entry = { step: 'review-' + round, input, model };
} else {
  fs.writeFileSync('.runner/judge.json', JSON.stringify(plan.judge));
  entry = { step: 'judge', input: args.at(-1), model };
}
fs.appendFileSync(${JSON.stringify(file('pi.log'))}, JSON.stringify(entry) + '\\n');
`, { mode: 0o755 });
  // Fake tmux: runs a new session to completion. A "live" file makes has-session succeed until Enter is sent.
  writeFileSync(file('tmux'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const live = ${JSON.stringify(file('live.json'))};
fs.appendFileSync(${JSON.stringify(file('tmux.log'))}, JSON.stringify(args) + '\\n');
if (args[0] === 'new-session') execFileSync('sh', ['-c', args.at(-1)], { cwd: args[args.indexOf('-c') + 1], stdio: 'ignore' });
const session = fs.existsSync(live) && JSON.parse(fs.readFileSync(live, 'utf8'));
const target = args[args.indexOf('-t') + 1]?.replace(/^=|:$/g, '');
if (args[0] === 'has-session') process.exit(session && session.name === target ? 0 : 1);
if (args[0] === 'kill-session') process.exit(1);
if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && session && session.name === target) {
  const { dir, ending } = session;
  fs.writeFileSync(dir + '/.runner/ending.json', JSON.stringify(ending));
  fs.writeFileSync(dir + '/.runner/lead-exit', '0');
  fs.rmSync(live);
}
`, { mode: 0o755 });
  writeFileSync(file('gh'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(file('gh.log'))}\ncase "$*" in "pr create"*) echo https://github.com/example/repo/pull/7;; esac\n`, { mode: 0o755 });
  writeFileSync(file('memory_pressure'), `#!/bin/sh\necho "System-wide memory free percentage: $(cat ${JSON.stringify(file('free'))} 2>/dev/null || echo 60)%"\n`, { mode: 0o755 });
  Object.assign(process.env, { JOB_RUNNER_PI: file('pi'), JOB_RUNNER_GH: file('gh'), JOB_RUNNER_TMUX: file('tmux'), JOB_RUNNER_MEMORY_PRESSURE: file('memory_pressure'), PI_SUBAGENT_NAME: 'outer session' });
  writeFileSync(file('hook-key'), 'hook-secret\n');

  const config: Config = {
    linearTokenCommand: 'echo test-token', team: 'ALE', runnerUser: RUNNER, decisionAssignee: ALEX,
    repos: { 'pstack-pi': { path: repo, base: 'main', automerge: false, ...options.repo } },
    webhooks: { desk: { url: 'https://hooks.example/desk', keyFile: file('hook-key') } },
    models: { lead: 'lead-model', review: 'review-model' }, thinking: 'high', pollSeconds: 0.01, maxLeads: options.maxLeads ?? 1, minFreeMemoryPercent: 20,
    host: 'test-host', worktreeRoot: file('worktrees'), stateFile: file('state.json'),
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
    if (op === 'IssueState') return data({ issue: { state: { type: STATE_TYPES[find(v.id).state] } } });
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
    if (op === 'CreateIssue') {
      assert.equal(v.input.teamId, 'team-ale');
      const n = 100 + ++nextId;
      const created = issue(n, { id: `id-${n}`, identifier: `ALE-${n}`, title: v.input.title, description: v.input.description, url: `https://linear.app/x/issue/ALE-${n}`, delegate: null, labels: [], assignee: v.input.assigneeId });
      issues.push(created);
      return data({ issueCreate: { issue: { id: created.id, identifier: created.identifier, url: created.url } } });
    }
    if (op === 'Relate') { relations.push(v.input); return data({ issueRelationCreate: { success: true } }); }
    throw new Error(`unexpected Linear operation ${op}`);
  };
  const calls = () => lines(file('pi.log')).map((line) => JSON.parse(line));
  return {
    config, hooks, relations, origin, root, setPlan,
    run: (...argv: string[]) => main(argv, config, fakeFetch as typeof fetch),
    steps: () => calls().map((c) => c.step as string),
    leads: () => calls().filter((c) => c.step === 'lead'),
    input: (step: string) => calls().find((c) => c.step === step)?.input as string,
    gh: () => lines(file('gh.log')),
    tmux: () => lines(file('tmux.log')).map((line) => JSON.parse(line) as string[]),
    state: () => JSON.parse(readFileSync(config.stateFile, 'utf8')).tickets as Ticket[],
    decisions: () => issues.filter((i) => Number(i.identifier.slice(4)) > 100),
    bodies: (i: FakeIssue) => i.comments.map((c) => c.body),
    runnerComments: (i: FakeIssue) => i.comments.filter((c) => c.user.name === RUNNER),
    setFreeMemory: (percent: number) => writeFileSync(file('free'), `${percent}\n`),
    goLive: (name: string, dir: string, ending: unknown) => writeFileSync(file('live.json'), JSON.stringify({ name, dir, ending })),
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

test('the lead runs in a tmux session named for the issue, with a known session id, auto-exit and an activity file', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [{ ...change(), startNote: 'Goal: make it work. Not doing: docs.' }], reviews: [[preexisting]] });
  await t.run('--once');
  const [lead] = t.leads();
  const ticketDir = path.join(t.config.worktreeRoot, 'job-ale-1-job-number-1');
  assert.match(lead.session, /^[0-9a-f-]{36}$/);
  assert.equal(lead.cwd, realpathSync(ticketDir));
  assert.equal(lead.autoExit, '1');
  assert.equal(lead.activity, path.join(ticketDir, '.runner', 'activity.json'));
  assert.ok(existsSync(lead.extension) && lead.extension.endsWith('subagent-done.ts'));
  assert.equal(lead.inherited, null, 'Pi variables from the tmux server environment are dropped');
  const started = t.tmux().find((args) => args[0] === 'new-session')!;
  assert.deepEqual(started.slice(0, 4), ['new-session', '-d', '-s', 'ALE-1']);
  assert.equal(started[started.indexOf('-c') + 1], ticketDir);
  assert.equal(job.comments.filter((c) => c.body.startsWith('Start note from the lead:')).length, 1);
  const status = t.runnerComments(job).filter((c) => c.body.startsWith('**Runner:**'));
  assert.equal(status.length, 1, 'one status comment, edited in place');
  assert.match(status[0].body, /^\*\*Runner:\*\* PR ready for review: https:\/\/github.com\/example\/repo\/pull\/7/);
  assert.ok(status[0].body.includes(`Session id: \`${lead.session}\``));
  assert.ok(status[0].body.includes('ssh -t test-host tmux attach -t ALE-1'));
  assert.ok(status[0].body.includes(`pi --fork ${lead.session}`));
  const create = t.gh().find((c) => c.startsWith('pr create'))!;
  assert.match(create, /--head job\/ale-1-job-number-1/);
  assert.ok(!create.includes('--draft'));
  assert.match(git(t.origin, 'log', '--format=%s', 'job/ale-1-job-number-1'), /ALE-1: Job number 1/);
  assert.equal(job.state, 'In Review');
  assert.equal(job.delegate, null);
  assert.deepEqual(t.hooks, [{ auth: 'Bearer hook-secret', body: { issue: 'ALE-1', url: job.url, state: 'ready', pr: 'https://github.com/example/repo/pull/7' } }]);
  assert.deepEqual(t.state(), []);
});

test('a caused must-fix resumes the same lead session, and round 2 reviews only the fix', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [change(), change()], reviews: [[caused], []] });
  await t.run('--once');
  assert.deepEqual(t.steps(), ['lead', 'review-1', 'lead', 'review-2']);
  const [first, second] = t.leads();
  assert.equal(second.session, first.session);
  assert.match(second.input, /^Review round 1 found problems your change caused/);
  assert.match(second.input, /breaks the thing/);
  assert.match(t.input('review-2'), /Review only the latest fix: git diff [0-9a-f]{40}\.\.HEAD/);
  assert.ok(!t.gh().find((c) => c.startsWith('pr create'))!.includes('--draft'));
  assert.equal(job.state, 'In Review');
});

test('at the round cap with caused must-fixes open, a fresh judge decides', async (s) => {
  await s.test('ship opens the PR with the open findings as known gaps', async () => {
    const job = issue(1);
    const t = setup([job], { leads: [change(), change(), change()], reviews: [[caused], [caused], [caused]], judge: { decision: 'ship', why: 'small and safe' } });
    await t.run('--once');
    assert.deepEqual(t.steps(), ['lead', 'review-1', 'lead', 'review-2', 'lead', 'review-3', 'judge']);
    assert.match(t.input('judge'), /breaks the thing/);
    const pr = readFileSync(path.join(t.config.worktreeRoot, 'job-ale-1-job-number-1', '.runner', 'pr.md'), 'utf8');
    assert.match(pr, /## Known gaps[\s\S]*work\.txt:1: breaks the thing/);
    assert.match(pr, /Judge: ship\. small and safe/);
    assert.equal(job.state, 'In Review');
  });
  await s.test('ask files a Decision issue and opens no PR', async () => {
    const job = issue(1);
    const t = setup([job], { leads: [change(), change(), change()], reviews: [[caused], [caused], [caused]], judge: { decision: 'ask', why: 'scope call' } });
    await t.run('--once');
    assert.equal(t.decisions().length, 1);
    assert.match(t.decisions()[0].description, /\*\*Recommendation:\*\* scope call/);
    assert.ok(!t.gh().some((c) => c.startsWith('pr create')));
    assert.equal(job.state, 'In Progress');
  });
  await s.test('cut resumes the lead once more, and open findings after that go to Alex', async () => {
    const job = issue(1);
    const t = setup([job], { leads: [change(), change(), change(), change()], reviews: [[caused], [caused], [caused], [caused]], judge: { decision: 'cut', why: 'drop the second screen' } });
    await t.run('--once');
    assert.deepEqual(t.steps(), ['lead', 'review-1', 'lead', 'review-2', 'lead', 'review-3', 'judge', 'lead', 'review-4']);
    assert.match(t.leads()[3].input, /says cut scope: drop the second screen/);
    assert.match(t.decisions()[0].title, /after the judge's cut/);
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

test('a decision ending waits without a slot, then resumes the same session with Alex\'s comments', async () => {
  const job = issue(1);
  const next = issue(2);
  const t = setup([job, next], { leads: [{ ending: ask }, report, report], reviews: [] });
  await t.run('--once');
  const [decision] = t.decisions();
  assert.equal(decision.assignee, 'user-alex');
  assert.equal(decision.title, 'Decision for ALE-1: Which storage?');
  assert.match(decision.description, /^Work ticket: \[ALE-1\]\(https:\/\/linear.app\/x\/issue\/ALE-1\)/);
  assert.match(decision.description, /\*\*Recommendation:\*\* SQLite[\s\S]*1\. \*\*SQLite\*\*\. Pick this if one Mac is enough\n2\. \*\*Postgres\*\*/);
  assert.deepEqual(t.relations, [{ issueId: decision.id, relatedIssueId: 'id-1', type: 'blocks' }]);
  assert.equal(job.state, 'In Progress');
  assert.equal(job.delegate, RUNNER);
  assert.deepEqual(t.state().map((s) => [s.key, s.decision?.identifier]), [['ALE-1', decision.identifier]]);
  assert.equal(t.hooks[0].body.state, 'needs-decision');

  await t.run('--once');
  assert.equal(next.state, 'Done', 'the waiting ticket held no slot');
  assert.equal(t.leads().length, 2);

  decision.comments.push({ id: 'alex-1', body: 'Go with SQLite.', createdAt: '2026-03-01T00:00:00Z', user: { name: ALEX } });
  decision.state = 'Done';
  await t.run('--once');
  const resumed = t.leads()[2];
  assert.equal(resumed.session, t.leads()[0].session);
  assert.match(resumed.input, /Decision issue ALE-\d+ .* is closed \(completed\)\. The comments on it:\n- Alex Example: Go with SQLite\./);
  assert.equal(job.state, 'Done');
});

test('a missing or invalid ending becomes a Decision issue that says so', async (s) => {
  for (const [name, lead, pattern] of [
    ['missing', {}, /exited without writing \.runner\/ending\.json/],
    ['invalid', { ending: { kind: 'change', full_suite: false, full_suite_why: 'x' } }, /needs a non-empty \.runner\/PROOF\.md/],
  ] as const) {
    await s.test(name, async () => {
      const job = issue(1);
      const t = setup([job], { leads: [lead], reviews: [] });
      await t.run('--once');
      assert.match(t.decisions()[0].description, pattern);
      assert.equal(job.state, 'In Progress');
      assert.deepEqual(t.gh(), []);
    });
  }
});

test('verify fails closed: no .agents/verify means no merge unless the repo says CI is the gate', async (s) => {
  await s.test('without ciGate', async () => {
    const job = issue(1);
    const t = setup([job], { leads: [change()], reviews: [[]] }, { verify: false, repo: { automerge: true } });
    await t.run('--once');
    assert.deepEqual(t.steps(), ['lead']);
    assert.match(t.decisions()[0].title, /no executable \.agents\/verify, so the runner will not merge/);
    assert.deepEqual(t.gh(), []);
  });
  await s.test('with ciGate', async () => {
    const job = issue(1);
    const t = setup([job], { leads: [change()], reviews: [[]] }, { verify: false, repo: { automerge: true, ciGate: true } });
    await t.run('--once');
    assert.match(t.input('review-1'), /Verify: no \.agents\/verify; CI is the gate/);
    assert.deepEqual(t.gh().filter((c) => c.startsWith('pr merge')), ['pr merge https://github.com/example/repo/pull/7 --auto --squash']);
  });
});

test('a failed verify goes back to the lead before any review', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [{ ...change(), append: 'broken' }, { ...change(), append: 'fixed' }], reviews: [[]] });
  writeFileSync(path.join(t.root, 'repo', '.agents', 'verify'), '#!/bin/sh\nif [ "$(tail -1 work.txt)" = broken ]; then echo verify failed; exit 1; fi\n', { mode: 0o755 });
  execFileSync('sh', ['-c', 'git add -A && git commit -qm verify && git push -q origin main'], { cwd: path.join(t.root, 'repo') });
  await t.run('--once');
  assert.deepEqual(t.steps(), ['lead', 'lead', 'review-1']);
  assert.match(t.leads()[1].input, /^\.agents\/verify failed[\s\S]*verify failed/);
  assert.match(t.input('review-1'), /Review the whole change/);
});

test('the full-suite label goes on the PR only when the lead asks and the repo names one', async () => {
  for (const [fullSuite, label, expected] of [[true, 'full-suite', true], [false, 'full-suite', false], [true, undefined, false]] as const) {
    const t = setup([issue(1)], { leads: [change(fullSuite)], reviews: [[]] }, { repo: { fullSuiteLabel: label } });
    await t.run('--once');
    assert.equal(t.gh().some((c) => c === 'pr edit https://github.com/example/repo/pull/7 --add-label full-suite'), expected);
  }
});

test('model lines in the issue override the configured models', async () => {
  const job = issue(1, { description: 'Make it work.\nReview model: openai/gpt-6.1-sol\nLead model: xai/grok-4.7' });
  const t = setup([job], { leads: [change()], reviews: [[]] });
  await t.run('--once');
  assert.deepEqual(t.leads().map((c) => c.model), ['xai/grok-4.7']);
  assert.equal(JSON.parse(lines(path.join(t.root, 'pi.log'))[1]).model, 'openai/gpt-6.1-sol');
});

test('the lead sees human comments once, never the runner\'s own', async () => {
  const job = issue(1, { comments: [{ id: 'human-1', body: 'Keep the old flag.', createdAt: '2026-01-01T01:00:00Z', user: { name: 'Alex' } }] });
  const t = setup([job], { leads: [change(), change()], reviews: [[caused], []] });
  await t.run('--once');
  assert.match(t.leads()[0].input, /New comments on the issue:\n- Alex: Keep the old flag\./);
  assert.doesNotMatch(t.leads()[1].input, /Keep the old flag|Runner:/);
});

test('a review that writes no valid JSON is a Decision issue, not a clean review', async () => {
  const job = issue(1);
  const t = setup([job], { leads: [change()], reviews: ['invalid'] });
  await t.run('--once');
  assert.match(t.decisions()[0].description, /no valid findings JSON/);
  assert.ok(!t.gh().some((c) => c.startsWith('pr create')));
});

test('an issue with no repo label is skipped with a comment and handed back', async () => {
  const job = issue(1, { labels: ['Papercut'] });
  const t = setup([job], { leads: [], reviews: [] });
  await t.run('--once');
  assert.deepEqual(t.steps(), []);
  assert.equal(job.state, 'Todo');
  assert.equal(job.delegate, null);
  assert.match(t.bodies(job)[0], /No repo label.*pstack-pi/);
});

test('on start, the runner resumes, adopts, keeps waiting, or resets each In Progress ticket', async () => {
  const unknown = issue(1, { state: 'In Progress' });
  const known = issue(2, { state: 'In Progress' });
  const live = issue(3, { state: 'In Progress', comments: [{ id: 'human-3', body: 'Use the blue icon.', createdAt: '2026-01-03T01:00:00Z', user: { name: 'Alex' } }] });
  const waiting = issue(4, { state: 'In Progress' });
  const notOurs = issue(5, { state: 'In Progress', delegate: 'someone else' });
  const decision = issue(9, { state: 'Todo', delegate: null });
  const t = setup([unknown, known, live, waiting, notOurs, decision], { leads: [report, report], reviews: [] }, { maxLeads: 3 });
  const saved = (n: number, extra: Partial<Ticket> = {}): Ticket => {
    const dir = path.join(t.root, `wt-${n}`);
    mkdirSync(path.join(dir, '.runner'), { recursive: true });
    return { id: `id-${n}`, key: `ALE-${n}`, title: `Job number ${n}`, url: `https://linear.app/x/issue/ALE-${n}`, description: '', repo: 'pstack-pi', branch: `job/ale-${n}`, dir,
      sessionId: `session-${n}`, models: { lead: 'lead-model', review: 'review-model' }, seen: [], launches: 1, reviews: 0, verifyFails: 0, open: [], judged: false, log: [], ...extra };
  };
  const tickets = [saved(2), saved(3), saved(4, { decision: { id: 'id-9', identifier: 'ALE-9', url: decision.url } })];
  writeFileSync(t.config.stateFile, JSON.stringify({ tickets }));
  t.goLive('ALE-3', tickets[1].dir, { kind: 'report', body: 'Blue icon done.' });
  await t.run('--once');
  assert.match(t.bodies(unknown)[0], /restarted.*no session to resume.*back to Todo/);
  assert.equal(unknown.state, 'Done', 'reset to Todo, then picked up again');
  const resumed = t.leads().find((c) => c.session === 'session-2')!;
  assert.match(resumed.input, /^The runner restarted while you worked/);
  assert.equal(known.state, 'Done');
  assert.ok(!t.leads().some((c) => c.session === 'session-3'), 'a live lead is waited on, not started again');
  const pasted = t.tmux().find((args) => args[0] === 'set-buffer')!;
  assert.equal(pasted.at(-1), 'Comment from Alex on ALE-3:\nUse the blue icon.');
  assert.ok(t.tmux().some((args) => args.join(' ') === 'paste-buffer -p -d -b runner-ALE-3 -t =ALE-3:'));
  assert.ok(t.tmux().filter((args) => args[0] === 'has-session').every((args) => args[2].startsWith('=')), 'exact session names, so ALE-1 never matches ALE-10');
  assert.ok(t.bodies(live).includes('Blue icon done.'));
  assert.equal(waiting.state, 'In Progress');
  assert.deepEqual(t.state().map((s) => s.key), ['ALE-4']);
  assert.equal(notOurs.state, 'In Progress');
  assert.deepEqual(notOurs.comments, []);
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
  const stale = issue(2, { state: 'In Progress' });
  const t = setup([job, stale], { leads: [], reviews: [] });
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try { await t.run('--dry-run'); } finally { console.log = log; }
  assert.ok(printed.includes('Would pick up ALE-1 (pstack-pi): Job number 1'));
  assert.ok(printed.includes('Would reset to Todo: ALE-2 Job number 2'));
  assert.equal(job.state, 'Todo');
  assert.equal(stale.state, 'In Progress');
  assert.deepEqual([...job.comments, ...stale.comments], []);
  assert.deepEqual(t.steps(), []);
  assert.ok(!existsSync(t.config.stateFile));
});

test('parseEnding accepts the three endings and names what is wrong with anything else', () => {
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
});

test('renderStatus names the host, session, and the take-over and quiz commands', () => {
  const body = renderStatus({ key: 'ALE-7', sessionId: 'abc-123', dir: '/w/job-ale-7', branch: 'job/ale-7-x' }, 'mini', 'Lead running');
  assert.equal(body.split('\n')[0], '**Runner:** Lead running');
  assert.ok(body.includes('- Host: mini'));
  assert.ok(body.includes('- tmux session: `ALE-7`'));
  assert.ok(body.includes('`ssh -t mini tmux attach -t ALE-7`'));
  assert.ok(body.includes("touch /w/job-ale-7/.runner/takeover && tmux attach -t ALE-7"));
  assert.ok(body.includes('git worktree add -B job/ale-7-x-quiz /w/job-ale-7-quiz HEAD && cd /w/job-ale-7-quiz && tmux new -s ALE-7-quiz pi --fork abc-123'));
});

test('renderDecision keeps the recommendation first and shortens long titles', () => {
  const { title, body } = renderDecision({ key: 'ALE-7', url: 'https://linear.app/x/issue/ALE-7' }, { question: 'Q'.repeat(100), recommendation: 'Do R.', options: [] });
  assert.equal(title.length, 'Decision for ALE-7: '.length + 80);
  assert.ok(body.indexOf('**Recommendation:**') < body.indexOf('Answer in a comment'));
});

test('startBlock enforces lead slots, memory pressure and the one screen', () => {
  const base = { running: 0, maxLeads: 2, freeMemory: 40, minFreeMemory: 20, needsScreen: false, screenTaken: false };
  assert.equal(startBlock(base), null);
  assert.match(startBlock({ ...base, running: 2 }) ?? '', /slots are busy/);
  assert.match(startBlock({ ...base, freeMemory: 19 }) ?? '', /only 19% of memory is free/);
  assert.equal(startBlock({ ...base, freeMemory: 20 }), null);
  assert.match(startBlock({ ...base, needsScreen: true, screenTaken: true }) ?? '', /screen/);
  assert.equal(startBlock({ ...base, needsScreen: false, screenTaken: true }), null);
});

test('answered picks waiting tickets whose Decision issue is done or canceled', () => {
  const ticket = (id: string) => ({ id }) as Ticket;
  const waiting = [ticket('a'), ticket('b'), ticket('c')];
  const states = new Map([['a', 'completed'], ['b', 'started'], ['c', 'canceled']]);
  assert.deepEqual(answered(waiting, states).map((t) => t.id), ['a', 'c']);
});
