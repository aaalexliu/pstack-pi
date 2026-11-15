import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commands, main, nextMove, put, quietMinutes, renderStatus, startBlock, type Child, type Config, type Ticket } from './runner.ts';

type FakeComment = { id: string; body: string; createdAt: string; user: { name: string; app?: boolean } | null; botActor?: { name: string } | null };
type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; state: string; delegate: string | null; assignee: string | null; parent: string | null; labels: string[]; comments: FakeComment[];
  completedAt: string | null; canceledAt: string | null;
};

const RUNNER = 'runner test';
const TYPES: Record<string, string> = { Todo: 'unstarted', 'In Progress': 'started', 'In Review': 'started', Done: 'completed', Canceled: 'canceled', Backlog: 'backlog' };
const ALEX = 'Alex Example';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
/** Now. `run` waits a few ms first, so a fact made here is older than the next lead start. */
/** A comment with only the fields the query names, as Linear returns it. */
const asQueried = ({ botActor, user, ...c }: FakeComment, query: string) => ({
  ...c,
  ...(/botActor \{ name \}/.test(query) ? { botActor: botActor ?? null } : {}),
  user: user && (/user \{ name app \}/.test(query) ? user : { name: user.name }),
});
const later = () => new Date().toISOString();

function issue(n: number, fields: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: `id-${n}`, identifier: `ALE-${n}`, title: `Job number ${n}`, description: 'Make it work.',
    url: `https://linear.app/x/issue/ALE-${n}`, createdAt: `2026-01-0${n}T00:00:00Z`, team: 'ALE', state: 'Todo',
    delegate: RUNNER, assignee: null, parent: null, labels: ['pstack-pi'], comments: [], completedAt: null, canceledAt: null, ...fields,
  };
}

function setup(issues: FakeIssue[], options: { maxLeads?: number; stallMinutes?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-test-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
  writeFileSync(path.join(repo, 'work.txt'), 'start\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');

  const file = (name: string) => path.join(root, name);
  // Fake Pi: logs how it was started. The lead's Linear work is faked by the tests between polls.
  writeFileSync(file('pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.find((a) => a.startsWith('@'));
fs.appendFileSync(${JSON.stringify(file('pi.log'))}, JSON.stringify({
  input: at ? fs.readFileSync(at.slice(1), 'utf8') : '', model: args[args.indexOf('--model') + 1], session: args[args.indexOf('--session-id') + 1],
  cwd: process.cwd(), extension: args[args.indexOf('-e') + 1], autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, token: process.env.LINEAR_TOKEN,
  piVars: Object.keys(process.env).filter((k) => /^(PI|PSTACK)_/.test(k)).sort(),
}) + '\\n');
`, { mode: 0o755 });
  // Fake tmux: runs a new session to completion. live.json names a lead that is still running.
  writeFileSync(file('tmux'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(file('tmux.log'))}, JSON.stringify(args) + '\\n');
const liveFile = ${JSON.stringify(file('live.json'))};
const live = fs.existsSync(liveFile) ? JSON.parse(fs.readFileSync(liveFile, 'utf8')) : [];
const target = args[args.indexOf('-t') + 1]?.replace(/^=|:$/g, '');
if (args[0] === 'new-session') { try { execFileSync('sh', ['-c', args.at(-1)], { cwd: args[args.indexOf('-c') + 1], stdio: 'ignore' }); } catch {} }
else if (args[0] === 'has-session') process.exit(live.includes(target) ? 0 : 1);
else if (args[0] === 'kill-session') process.exit(1);
`, { mode: 0o755 });
  writeFileSync(file('memory_pressure'), `#!/bin/sh\necho "System-wide memory free percentage: $(cat ${JSON.stringify(file('free'))} 2>/dev/null || echo 60)%"\n`, { mode: 0o755 });
  Object.assign(process.env, {
    JOB_RUNNER_PI: file('pi'), JOB_RUNNER_TMUX: file('tmux'), JOB_RUNNER_MEMORY_PRESSURE: file('memory_pressure'),
    PI_SUBAGENT_NAME: 'outer session', PI_X2_TOKEN: 'outer', PSTACK_9: 'outer', PI_AUTH_PROFILE: 'kept',
  });

  const config: Config = {
    linearTokenCommand: `cat ${file('token')}`, team: 'ALE', runnerUser: RUNNER, decisionAssignee: ALEX,
    repos: { 'pstack-pi': { path: repo, base: 'main' } },
    models: { lead: 'lead-model', review: 'review-model' }, thinking: 'high', pollSeconds: 0.01, maxLeads: options.maxLeads ?? 2,
    minFreeMemoryPercent: 20, stallMinutes: options.stallMinutes ?? 30, host: 'test-host', worktreeRoot: file('worktrees'),
  };
  let nextId = 0;
  /** Ids Linear no longer finds by id, as for an issue deleted mid-poll. */
  const gone = new Set<string>();
  /** State names the fake team does not have. */
  const missingStates = new Set<string>();
  const ops: string[] = [];
  /** Linear operations that fail once, the next time they run. */
  const faults: string[] = [];
  writeFileSync(file('token'), 'test-token\n');
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    const { query, variables: v } = JSON.parse(String(init?.body));
    const op = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '';
    ops.push(op);
    if (faults.includes(op)) { faults.splice(faults.indexOf(op), 1); throw new Error(`injected ${op} failure`); }
    const find = (id: string) => issues.find((i) => i.id === id)!;
    const data = (value: unknown) => Response.json({ data: value });
    if (op === 'Issues') {
      return data({ issues: { nodes: issues.filter((i) => i.team === v.team && ['unstarted', 'started'].includes(TYPES[i.state]) && i.delegate === v.user).map((i) => ({ ...i, state: { type: TYPES[i.state] }, labels: { nodes: i.labels.map((name) => ({ name })) } })) } });
    }
    if (op === 'IssueById') {
      const i = issues.find((x) => x.id === v.id && !gone.has(x.id));
      return data({ issues: { nodes: i ? [{
        state: { type: TYPES[i.state] }, delegate: i.delegate ? { name: i.delegate } : null, comments: { nodes: i.comments.map((c) => asQueried(c, query)) },
        children: { nodes: issues.filter((c) => c.parent === i.id).map((c) => ({ ...c, assignee: c.assignee ? { name: c.assignee } : null })) },
      }] : [] } });
    }
    if (op === 'State') return data({ workflowStates: { nodes: missingStates.has(v.name) ? [] : [{ id: `state-${v.name}` }] } });
    if (op === 'Team') return data({ teams: { nodes: [{ id: 'team-ale' }] } });
    if (op === 'User') return data({ users: { nodes: v.name === ALEX ? [{ id: 'user-alex' }] : [] } });
    if (op === 'Update') {
      if (v.input.stateId) find(v.id).state = v.input.stateId.slice(6);
      if ('delegateId' in v.input) find(v.id).delegate = v.input.delegateId;
      return data({ issueUpdate: { success: true } });
    }
    if (op === 'Comment') {
      find(v.input.issueId).comments.push({ id: `comment-${++nextId}`, body: v.input.body, createdAt: new Date().toISOString(), user: { name: RUNNER, app: true } });
      return data({ commentCreate: { success: true } });
    }
    if (op === 'EditComment') {
      issues.flatMap((i) => i.comments).find((c) => c.id === v.id)!.body = v.input.body;
      return data({ commentUpdate: { success: true } });
    }
    if (op === 'CreateIssue') {
      assert.equal(v.input.teamId, 'team-ale');
      const n = 100 + ++nextId;
      issues.push(issue(n, { title: v.input.title, description: v.input.description, createdAt: new Date().toISOString(), state: 'Todo', delegate: null, labels: [], assignee: v.input.assigneeId === 'user-alex' ? ALEX : null, parent: v.input.parentId }));
      return data({ issueCreate: { issue: { identifier: `ALE-${n}`, url: `https://linear.app/x/issue/ALE-${n}` } } });
    }
    throw new Error(`unexpected Linear operation ${op}`);
  };
  const dirOf = (n: number) => path.join(config.worktreeRoot, `job-ale-${n}-job-number-${n}`);
  return {
    config, ops, faults, root, repo, dirOf, gone, missingStates,
    run: async (...argv: string[]) => { await new Promise((r) => setTimeout(r, 5)); await main(argv, config, fakeFetch as typeof fetch); },
    leads: () => lines(file('pi.log')).map((line) => JSON.parse(line)),
    tmux: () => lines(file('tmux.log')).map((line) => JSON.parse(line) as string[]),
    decisions: (parent = 'id-1') => issues.filter((i) => i.parent === parent),
    setLive: (...keys: string[]) => writeFileSync(file('live.json'), JSON.stringify(keys)),
    setFreeMemory: (percent: number) => writeFileSync(file('free'), `${percent}\n`),
    /** Alex closes a Decision issue, after the lead's last start. */
    close: (d: FakeIssue, how: 'Done' | 'Canceled' = 'Done') => { d.state = how; d[how === 'Done' ? 'completedAt' : 'canceledAt'] = later(); },
  };
}

test('a delegated ticket starts one lead in tmux with the session, the subagent_done extension without auto-exit, the Linear token and a clean environment', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  const [lead] = t.leads();
  const dir = t.dirOf(1);
  assert.equal(job.state, 'In Progress');
  assert.equal(lead.session, readFileSync(path.join(dir, '.runner', 'session-id'), 'utf8'));
  assert.equal(lead.cwd, realpathSync(dir));
  assert.equal(lead.autoExit, undefined, 'the lead decides when to exit');
  assert.ok(lead.extension.endsWith('subagent-done.ts') && existsSync(lead.extension));
  assert.equal(lead.token, 'test-token');
  assert.deepEqual(lead.piVars, ['PI_AUTH_PROFILE', 'PI_SUBAGENT_ACTIVITY_FILE', 'PI_SUBAGENT_ID'], 'outer PI_* and PSTACK_* are gone, digits included');
  assert.ok(!readFileSync(path.join(dir, '.runner', 'lead.sh'), 'utf8').includes('test-token'), 'the token never lands on disk');
  assert.match(lead.input, /^Issue ALE-1: Job number 1[\s\S]*Linear issue id: id-1\.[\s\S]*- The ticket was delegated to you\./);
  assert.deepEqual(t.tmux().find((a) => a[0] === 'new-session')!.slice(0, 4), ['new-session', '-d', '-s', 'ALE-1']);
  const status = job.comments.filter((c) => c.body.startsWith('**Runner:**'));
  assert.equal(status.length, 1);
  assert.match(status[0].body, /^\*\*Runner:\*\* Lead running/);
  assert.ok(existsSync(path.join(dir, '.runner', 'started')));
});

test('NoSpin: a lead that exits with nothing new is not started again; the runner files one Decision issue instead', async () => {
  const t = setup([issue(1)]);
  await t.run('--once');
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  const decisions = t.decisions();
  assert.equal(decisions.length, 1, 'one ask, one Decision issue');
  assert.equal(decisions[0].assignee, ALEX);
  assert.match(decisions[0].title, /^Decision for ALE-1: the lead stopped with nothing open to wait for/);
});

test('a Decision issue the lead filed is waited on, not doubled', async () => {
  const all = [issue(1)];
  const t = setup(all);
  await t.run('--once');
  all.push(issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], createdAt: later() }));
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.deepEqual(t.decisions().map((d) => d.identifier), ['ALE-50']);
});

test('closing a Decision issue, Done or Canceled, wakes the same lead session once', async () => {
  for (const how of ['Done', 'Canceled'] as const) {
    const t = setup([issue(1)]);
    await t.run('--once');
    await t.run('--once');
    const [decision] = t.decisions();
    t.close(decision, how);
    await t.run('--once');
    await t.run('--once');
    const leads = t.leads();
    assert.equal(leads.length, 2, `${how}: one wake, no spin after it`);
    assert.equal(leads[1].session, leads[0].session);
    assert.match(leads[1].input, new RegExp(`Alex ${how === 'Done' ? 'closed' : 'canceled'} ${decision.identifier}`));
    assert.equal(t.decisions().length, 2, 'after the woken lead stops, a new ask');
  }
});

test('a human comment after the last start wakes the lead; the runner\'s own comments do not', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  job.comments.push({ id: 'h1', body: 'Use the blue icon.', createdAt: later(), user: { name: 'Alex' } });
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, /- Alex commented: Use the blue icon\./);
  await t.run('--once');
  assert.equal(t.leads().length, 2);
});

test('NoSpin across a crash: a Todo ticket whose move to In Progress fails is started once, not on every poll', async () => {
  const job = issue(1);
  const t = setup([job]);
  t.faults.push('State');
  const error = console.error;
  console.error = () => {};
  try {
    await t.run('--once');
    await t.run('--once');
    await t.run('--once');
  } finally { console.error = error; }
  assert.equal(t.leads().length, 1);
  assert.equal(t.decisions().length, 1, 'the stopped lead gets one Decision issue');
});

test('a team with no "In Progress" state starts no lead, so a Todo ticket cannot spin', async () => {
  const t = setup([issue(1)]);
  t.missingStates.add('In Progress');
  const error = console.error;
  console.error = () => {};
  try {
    await t.run('--once');
    await t.run('--once');
  } finally { console.error = error; }
  assert.equal(t.leads().length, 0);
});

test('comments from apps and bots do not wake the lead', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  job.comments.push({ id: 'b1', body: 'Deployed preview.', createdAt: later(), user: { name: 'GitHub', app: true } });
  job.comments.push({ id: 'b2', body: 'Linked a PR.', createdAt: later(), user: null, botActor: { name: 'GitHub' } });
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.decisions().length, 1);
});

test('a ticket the lead moved to Done is left alone; one Linear moved to In Review is still watched', async () => {
  for (const [state, decisions] of [['Done', 0], ['In Review', 1]] as const) {
    const job = issue(1);
    const t = setup([job]);
    await t.run('--once');
    job.state = state;
    await t.run('--once');
    assert.equal(t.leads().length, 1);
    assert.equal(t.decisions().length, decisions, state);
  }
});

test('a live lead is never started again or asked about until it goes quiet; then one Decision issue, and Alex reaches it', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { stallMinutes: 5 });
  await t.run('--once');
  t.setLive('ALE-1');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.decisions().length, 0, 'a live, active lead is left alone');
  const quiet = () => {
    put(path.join(t.dirOf(1), '.runner', 'started'), new Date(Date.now() - 20 * 60000).toISOString());
    put(path.join(t.dirOf(1), '.runner', 'activity.json'), JSON.stringify({ updatedAt: Date.now() - 10 * 60000 }));
  };
  quiet();
  await t.run('--once');
  await t.run('--once');
  const stalls = t.decisions();
  assert.equal(stalls.length, 1, 'an idle lead that never called subagent_done gets one Decision issue per idle stretch');
  assert.match(stalls[0].title, /Check ALE-1: the lead looks stuck/);
  assert.match(stalls[0].description, /no activity for 10 minutes/);
  assert.equal(t.leads().length, 1);
  t.close(stalls[0]);
  job.comments.push({ id: 'c-1', body: 'Merge it and call subagent_done.', createdAt: later(), user: { name: 'Alex Liu' } });
  await t.run('--once');
  assert.equal(t.leads().length, 2, 'closing the issue starts the idle lead again');
  const again = t.leads()[1];
  assert.equal(again.session, t.leads()[0].session, 'in the same session');
  assert.match(again.input, /Alex Liu commented: Merge it and call subagent_done\./);
  assert.equal(t.decisions().length, 1);
});

test('lead slots: at most maxLeads run, a live lead holds its slot, and the runner says why once', async () => {
  const t = setup([issue(1), issue(2), issue(3), issue(4)], { maxLeads: 2 });
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try {
    await t.run('--once');
    assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-2']);
    assert.ok(printed.includes('Not starting ALE-3 yet: all 2 lead slots are busy'));
    t.setLive('ALE-1');
    await t.run('--once');
  } finally { console.log = log; }
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-2', 'ALE-3'], 'the live lead holds one of the two slots');
});

test('low free memory starts no lead', async () => {
  const job = issue(1);
  const t = setup([job]);
  t.setFreeMemory(12);
  const log = console.log;
  console.log = () => {};
  try { await t.run('--once'); } finally { console.log = log; }
  assert.equal(t.leads().length, 0);
  assert.equal(job.state, 'Todo');
});

test('a ticket Linear no longer finds by id is skipped, and the poll goes on', async () => {
  const t = setup([issue(1), issue(2)]);
  t.gone.add('id-1');
  await t.run('--once');
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-2']);
});

test('an existing worktree is reused, never removed', async () => {
  const t = setup([issue(1)]);
  const dir = t.dirOf(1);
  git(t.repo, 'worktree', 'add', '-q', '-b', 'job/ale-1-job-number-1', dir, 'origin/main');
  writeFileSync(path.join(dir, 'uncommitted.txt'), 'keep me');
  await t.run('--once');
  assert.equal(readFileSync(path.join(dir, 'uncommitted.txt'), 'utf8'), 'keep me');
  assert.equal(t.leads().length, 1);
});

test('a lead that cannot start becomes a Decision issue, not a retry every poll', async () => {
  const t = setup([issue(1)]);
  mkdirSync(t.dirOf(1), { recursive: true });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 0);
  assert.equal(t.decisions().length, 1);
  assert.match(t.decisions()[0].title, /could not start the lead: .* is not a worktree/);
});

test('an issue with no repo label is skipped with a comment and handed back', async () => {
  const job = issue(1, { labels: ['Papercut'] });
  const t = setup([job]);
  await t.run('--once');
  assert.equal(job.delegate, null);
  assert.match(job.comments[0].body, /No repo label.*pstack-pi/);
});

test('--dry-run prints each move and writes nothing', async () => {
  const job = issue(1);
  const t = setup([job]);
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try { await t.run('--dry-run'); } finally { console.log = log; }
  assert.ok(printed.includes('ALE-1: start'));
  assert.equal(job.state, 'Todo');
  assert.deepEqual(job.comments, []);
  assert.ok(!existsSync(t.config.worktreeRoot));
});

const child = (fields: Partial<Child>): Child => ({ id: 'c', identifier: 'ALE-9', title: 't', url: 'u', createdAt: '2026-01-01T00:00:00Z', completedAt: null, canceledAt: null, assignee: { name: ALEX }, ...fields });
const ticket = (fields: Partial<Ticket>): Ticket => ({ state: 'started', delegate: RUNNER, comments: [], children: [], ...fields });
const cfg = { decisionAssignee: ALEX, runnerUser: RUNNER } as Config;

test('nextMove follows the model: wait on an open Decision, start on news, else decide', () => {
  const started = '2026-01-02T00:00:00Z';
  assert.equal(nextMove(cfg, ticket({}), null).kind, 'start');
  assert.equal(nextMove(cfg, ticket({ state: 'unstarted' }), started).kind, 'start');
  assert.equal(nextMove(cfg, ticket({}), started).kind, 'decide');
  assert.equal(nextMove(cfg, ticket({ children: [child({})] }), null).kind, 'wait', 'an open Decision beats news');
  assert.equal(nextMove(cfg, ticket({ children: [child({ assignee: null })] }), started).kind, 'decide', 'a sub-issue not assigned to Alex is not a Decision');
  assert.equal(nextMove(cfg, ticket({ children: [child({ completedAt: '2026-01-01T00:00:00Z' })] }), started).kind, 'decide', 'an answer older than the start is old news');
  assert.equal(nextMove(cfg, ticket({ children: [child({ canceledAt: '2026-01-03T00:00:00Z' })] }), started).kind, 'start');
  assert.equal(nextMove(cfg, ticket({ comments: [{ id: 'x', body: 'b', createdAt: '2026-01-03T00:00:00Z', user: { name: RUNNER, app: true } }] }), started).kind, 'decide');
});

const shells = ['sh', 'zsh'].filter((shell) => { try { execFileSync(shell, ['-c', 'true']); return true; } catch { return false; } });
for (const shell of ['sh', 'zsh']) {
  test(`status commands survive a worktree path with spaces and an apostrophe when the remote shell is ${shell}`, { skip: !shells.includes(shell) && `${shell} is not installed` }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-quote-'));
    const dir = path.join(root, 'Work Projects', "it's", 'job-ale-7-x');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'job/ale-7-x');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(path.join(dir, '.runner'));
    const fakes = path.join(root, 'bin');
    mkdirSync(fakes);
    writeFileSync(path.join(fakes, 'ssh'), `#!/bin/sh\nshift 2\nexec ${shell} -c "$*"\n`, { mode: 0o755 });
    writeFileSync(path.join(fakes, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(root, 'tmux-args'))}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${fakes}:${process.env.PATH}` };
    const tmuxArgs = () => readFileSync(path.join(root, 'tmux-args'), 'utf8').trim().split('\n');
    const c = commands({ key: 'ALE-7', dir, branch: 'job/ale-7-x' }, 'abc-123', 'mini');
    execFileSync('sh', ['-c', c.watch], { env });
    assert.deepEqual(tmuxArgs(), ['attach', '-t', '=ALE-7']);
    execFileSync('sh', ['-c', c.stop], { env });
    assert.deepEqual(tmuxArgs(), ['kill-session', '-t', '=ALE-7']);
    execFileSync('sh', ['-c', c.takeOver], { env });
    assert.ok(existsSync(path.join(dir, '.runner', 'takeover')));
    execFileSync('sh', ['-c', c.quiz], { env, stdio: 'ignore' });
    assert.equal(git(`${dir}-quiz`, 'rev-parse', '--abbrev-ref', 'HEAD'), 'job/ale-7-x-quiz');
    assert.deepEqual(tmuxArgs(), ['new', '-s', 'ALE-7-quiz', 'pi', '--fork', 'abc-123']);
  });
}

test('the status comment shows the commands', () => {
  const body = renderStatus({ key: 'ALE-7', dir: '/w/job-ale-7', branch: 'job/ale-7-x' }, 'abc-123', 'mini', 'Lead running');
  assert.equal(body.split('\n')[0], '**Runner:** Lead running');
  assert.ok(body.includes(`\`ssh -t mini 'tmux attach -t "=ALE-7"'\``));
});

test('startBlock enforces lead slots, free memory and the one screen', () => {
  const base = { running: 0, maxLeads: 2, freeMemory: 40, minFreeMemory: 20, needsScreen: false, screenTaken: false };
  assert.equal(startBlock(base), null);
  assert.match(startBlock({ ...base, running: 2 }) ?? '', /slots are busy/);
  assert.match(startBlock({ ...base, freeMemory: 19 }) ?? '', /only 19% of memory is free/);
  assert.match(startBlock({ ...base, needsScreen: true, screenTaken: true }) ?? '', /screen/);
  assert.equal(startBlock({ ...base, screenTaken: true }), null);
});

test('quietMinutes counts from the later of the lead start and the last activity', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-quiet-'));
  const now = Date.now();
  mkdirSync(path.join(dir, '.runner'));
  writeFileSync(path.join(dir, '.runner', 'started'), new Date(now - 60 * 60000).toISOString());
  assert.equal(quietMinutes({ dir }, now), 60);
  writeFileSync(path.join(dir, '.runner', 'activity.json'), JSON.stringify({ updatedAt: now - 7 * 60000 }));
  assert.equal(quietMinutes({ dir }, now), 7);
});

test('put replaces a file whole and leaves no temp file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-put-'));
  put(path.join(dir, 'a.json'), 'one');
  put(path.join(dir, 'a.json'), 'two');
  assert.equal(readFileSync(path.join(dir, 'a.json'), 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['a.json']);
});
