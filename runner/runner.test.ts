import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { format } from 'node:util';
import { commands, lastActivity, main, nextMove, put, renderStatus, startBlock, type Child, type Config, type Ticket } from './runner.ts';

type FakeComment = { id: string; body: string; createdAt: string; user: { name: string; app?: boolean } | null; botActor?: { name: string } | null; parentId?: string };
type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; state: string; delegate: string | null; assignee: string | null; parent: string | null; labels: string[]; comments: FakeComment[];
  completedAt: string | null; canceledAt: string | null; closedBy?: string; history?: { createdAt: string; actor: { name: string } | null; toState: { type: string } | null }[];
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

function setup(issues: FakeIssue[], options: { maxLeads?: number; stallMinutes?: number; ghTokenCommand?: string } = {}) {
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
  cwd: process.cwd(), extension: args[args.indexOf('-e') + 1], autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, token: process.env.LINEAR_TOKEN, ghToken: process.env.GH_TOKEN,
  piVars: Object.keys(process.env).filter((k) => /^(PI|PSTACK|CMUX)_/.test(k)).sort(),
}) + '\\n');
`, { mode: 0o755 });
  // Fake tmux: runs a new session to completion. live.json names a lead that is still running.
  writeFileSync(file('tmux'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(file('tmux.log'))}, JSON.stringify(args) + '\\n');
const liveFile = ${JSON.stringify(file('live.json'))};
const tagsFile = ${JSON.stringify(file('tags.json'))};
const live = fs.existsSync(liveFile) ? JSON.parse(fs.readFileSync(liveFile, 'utf8')) : [];
const target = args[args.indexOf('-t') + 1]?.replace(/^=|:$/g, '');
if (args[0] === 'new-session') { if (fs.existsSync(liveFile.replace(/live\.json$/, 'live-on-start'))) fs.writeFileSync(liveFile, JSON.stringify([...live, args[args.indexOf('-s') + 1]])); try { execFileSync('sh', ['-c', args.at(-1)], { cwd: args[args.indexOf('-c') + 1], stdio: 'ignore' }); } catch {} }
else if (args[0] === 'has-session') process.exit(live.includes(target) ? 0 : 1);
else if (args[0] === 'kill-session') { if (!live.includes(target)) process.exit(1); fs.writeFileSync(liveFile, JSON.stringify(live.filter((k) => k !== target))); }
else if (args[0] === 'set-option') { if (!/^=.+:$/.test(args[args.indexOf('-t') + 1] ?? '') || fs.existsSync(tagsFile + '.fail')) { console.error('no such session'); process.exit(1); } const tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, 'utf8')) : {}; fs.writeFileSync(tagsFile, JSON.stringify({ ...tags, [target]: args.at(-1) })); }
else if (args[0] === 'list-sessions') { const tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, 'utf8')) : {}; console.log(live.map((k) => k + ' ' + (tags[k] ?? '')).join('\\n')); }
else if (args[0] === 'list-windows') { try { process.stdout.write(fs.readFileSync(${JSON.stringify(file('windows'))}, 'utf8')); } catch {} }
`, { mode: 0o755 });
  writeFileSync(file('memory_pressure'), `#!/bin/sh\necho "System-wide memory free percentage: $(cat ${JSON.stringify(file('free'))} 2>/dev/null || echo 60)%"\n`, { mode: 0o755 });
  Object.assign(process.env, {
    JOB_RUNNER_PI: file('pi'), JOB_RUNNER_TMUX: file('tmux'), JOB_RUNNER_MEMORY_PRESSURE: file('memory_pressure'),
    PI_SUBAGENT_NAME: 'outer session', PI_X2_TOKEN: 'outer', PSTACK_9: 'outer', CMUX_SURFACE_ID: 'outer', PI_AUTH_PROFILE: 'kept',
  });

  const config: Config = {
    linearTokenCommand: `cat ${file('token')}`, team: 'ALE', runnerUser: RUNNER, decisionAssignee: ALEX,
    repos: { 'pstack-pi': { path: repo, base: 'main' } },
    models: { lead: 'lead-model', review: 'review-model' }, thinking: 'high', pollSeconds: 0.01, maxLeads: options.maxLeads ?? 2,
    minFreeMemoryPercent: 20, stallMinutes: options.stallMinutes ?? 30, host: 'test-host', worktreeRoot: file('worktrees'),
    ...(options.ghTokenCommand ? { ghTokenCommand: options.ghTokenCommand } : {}),
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
      const open = issues.filter((i) => i.team === v.team && ['unstarted', 'started'].includes(TYPES[i.state]) && i.delegate === v.user);
      const from = Number(v.after ?? 0);
      const page = open.slice(from, from + 100);
      return data({ issues: {
        nodes: page.map((i) => ({ ...i, state: { type: TYPES[i.state] }, labels: { nodes: i.labels.map((name) => ({ name })) } })),
        pageInfo: { hasNextPage: from + 100 < open.length || faults.includes('NoCursor'), endCursor: faults.includes('NoCursor') ? null : String(from + 100) },
      } });
    }
    if (op === 'IssueByKey') {
      const i = issues.find((x) => x.identifier === v.key);
      if (v.key === 'ALE-6') return data({ issue: null });
      if (!i) return Response.json({ errors: [{ message: 'Entity not found' }] });
      return data({ issue: { state: { type: TYPES[i.state] }, delegate: i.delegate ? { name: i.delegate } : null } });
    }
    if (op === 'IssueById') {
      const i = issues.find((x) => x.id === v.id && !gone.has(x.id));
      return data({ issues: { nodes: i ? [{
        state: { type: TYPES[i.state] }, delegate: i.delegate ? { name: i.delegate } : null, comments: { nodes: i.comments.map((c) => asQueried(c, query)) },
        children: { nodes: issues.filter((c) => c.parent === i.id).map(({ closedBy, ...c }) => ({ ...c, assignee: c.assignee ? { name: c.assignee } : null, history: { nodes: [...(c.history ?? []), ...(closedBy ? [{ createdAt: c.completedAt ?? c.canceledAt, actor: { name: closedBy }, toState: { type: TYPES[c.state] } }] : [])]
          .reverse().slice(0, Number(/history\(first: (\d+)/.exec(query)?.[1])) } })) },
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
      find(v.input.issueId).comments.push({ id: `comment-${++nextId}`, body: v.input.body, createdAt: new Date().toISOString(), user: { name: RUNNER, app: true }, parentId: v.input.parentId });
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
  /** What the runner printed. A test that expects errors sets `expectErrors` and asserts on `errors`; otherwise any error fails the run. */
  const printed = { logs: [] as string[], errors: [] as string[], expectErrors: false };
  return {
    config, ops, faults, root, repo, dirOf, gone, missingStates, printed,
    /** The first line of each distinct error, without its stack. */
    errorLines: () => [...new Set(printed.errors.map((e) => e.split('\n')[0]))],
    run: async (...argv: string[]) => {
      await new Promise((r) => setTimeout(r, 5));
      const { log, error } = console;
      const before = printed.errors.length;
      console.log = (...args: unknown[]) => { printed.logs.push(format(...args)); };
      console.error = (...args: unknown[]) => { printed.errors.push(format(...args)); };
      try { await main(argv, config, fakeFetch as typeof fetch); } finally { Object.assign(console, { log, error }); }
      if (!printed.expectErrors) assert.deepEqual(printed.errors.slice(before), [], 'the runner printed an unexpected error');
    },
    leads: () => lines(file('pi.log')).map((line) => JSON.parse(line)),
    tmux: () => lines(file('tmux.log')).map((line) => JSON.parse(line) as string[]),
    decisions: (parent = 'id-1') => issues.filter((i) => i.parent === parent),
    /** Window activity times, in seconds, that the fake `tmux list-windows` prints. */
    setWindows: (...seconds: number[]) => writeFileSync(file('windows'), seconds.join('\n')),
    setLive: (...keys: string[]) => writeFileSync(file('live.json'), JSON.stringify(keys)),
    /** Marks sessions as the runner's, as its `set-option @job-runner` does. */
    tag: (...keys: string[]) => writeFileSync(file('tags.json'), JSON.stringify(Object.fromEntries(keys.map((k) => [k, k])))),
    setFreeMemory: (percent: number) => writeFileSync(file('free'), `${percent}\n`),
    /** Alex closes a Decision issue, after the lead's last start. */
    close: (d: FakeIssue, how: 'Done' | 'Canceled' = 'Done') => { d.state = how; d[how === 'Done' ? 'completedAt' : 'canceledAt'] = later(); d.closedBy ??= ALEX; },
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
  assert.deepEqual(lead.piVars, ['PI_AUTH_PROFILE', 'PI_SUBAGENT_ACTIVITY_FILE', 'PI_SUBAGENT_ID'], 'outer PI_*, PSTACK_* and CMUX_* are gone, digits included');
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

test('a busy Decision issue still wakes the lead when Alex closes it: Linear lists history newest first', async () => {
  const t = setup([issue(1)]);
  await t.run('--once');
  await t.run('--once');
  const [decision] = t.decisions();
  decision.history = Array.from({ length: 60 }, (_, i) => ({ createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, actor: { name: ALEX }, toState: null }));
  t.close(decision);
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, new RegExp(`Alex closed ${decision.identifier}`));
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
  t.printed.expectErrors = true;
  await t.run('--once');
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual(t.errorLines(), ['ALE-1: failed; the next poll tries again Error: injected State failure']);
  assert.equal(t.leads().length, 1);
  assert.equal(t.decisions().length, 1, 'the stopped lead gets one Decision issue');
});

test('a team with no "In Progress" state starts no lead, so a Todo ticket cannot spin', async () => {
  const t = setup([issue(1)]);
  t.missingStates.add('In Progress');
  t.printed.expectErrors = true;
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual(t.errorLines(), ['ALE-1: failed; the next poll tries again Error: Linear team ALE has no state named "In Progress"']);
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

test('the runner never starts or kills a live lead, even after a comment or a closed Decision issue', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { stallMinutes: 5 });
  await t.run('--once');
  t.setLive('ALE-1');
  job.comments.push({ id: 'c-1', body: 'Merge it and call subagent_done.', createdAt: later(), user: { name: ALEX } });
  const asked = issue(50, { parent: 'id-1', assignee: ALEX, createdAt: later() });
  t.close(asked);
  const runner = path.join(t.dirOf(1), '.runner');
  put(path.join(runner, 'started'), new Date(Date.now() - 20 * 60000).toISOString());
  put(path.join(runner, 'takeover'), '');
  await t.run('--once');
  rmSync(path.join(runner, 'takeover'));
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'no restart');
  assert.deepEqual(t.tmux().filter((a) => a[0] === 'new-session' || a[0] === 'kill-session').map((a) => a[0]), ['kill-session', 'new-session'], 'only the first start');
});

test('a quiet live lead gets one Decision issue per quiet stretch; takeover and a busy window hold it off', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { stallMinutes: 5 });
  await t.run('--once');
  t.setLive('ALE-1');
  await t.run('--once');
  assert.equal(t.decisions().length, 0, 'a live, active lead is left alone');
  const runner = path.join(t.dirOf(1), '.runner');
  put(path.join(runner, 'started'), new Date(Date.now() - 20 * 60000).toISOString());
  put(path.join(runner, 'activity.json'), JSON.stringify({ updatedAt: Date.now() - 10 * 60000 }));
  t.setWindows(Math.floor(Date.now() / 1000) - 60);
  await t.run('--once');
  assert.equal(t.decisions().length, 0, 'output in any window, such as a reviewer, counts as activity');
  t.setWindows(Math.floor(Date.now() / 1000) - 10 * 60);
  put(path.join(runner, 'takeover'), '');
  await t.run('--once');
  assert.equal(t.decisions().length, 0, 'a person took it over');
  rmSync(path.join(runner, 'takeover'));
  await t.run('--once');
  await t.run('--once');
  const stalls = t.decisions();
  assert.equal(stalls.length, 1, 'one per quiet stretch');
  assert.match(stalls[0].title, /Check ALE-1: the lead looks stuck/);
  assert.match(stalls[0].description, /no activity for 10 minutes[\s\S]*tmux attach/);
  const filed = Date.now() - 5.5 * 60000;
  stalls[0].createdAt = new Date(filed).toISOString();
  put(path.join(runner, 'activity.json'), JSON.stringify({ updatedAt: filed + 5000 }));
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.decisions().length, 2, 'activity seconds after the first issue, then a full quiet interval: exactly one more issue');
  assert.equal(t.leads().length, 1);
});

test('the runner kills only a session it tagged whose ticket Linear confirms is closed, never a taken-over one', async () => {
  const many = Array.from({ length: 101 }, (_, k) => issue(k + 1, { state: 'In Progress' }));
  const t = setup([...many, issue(102, { state: 'In Progress', delegate: 'Someone else' })], { maxLeads: 0 });
  for (const [k, state] of [[0, 'Done'], [1, 'Done'], [3, 'Canceled'], [4, 'Done'], [5, 'Done'], [6, 'Done'], [7, 'Done']] as const) many[k].state = state;
  many[2].delegate = null;
  mkdirSync(path.join(t.dirOf(8), '.runner'), { recursive: true });
  put(path.join(t.dirOf(8), '.runner', 'held'), '');
  mkdirSync(path.join(t.dirOf(9), '.runner'), { recursive: true });
  put(path.join(t.dirOf(9), '.runner', 'takeover'), '');
  many[8].state = 'Done';
  t.faults.push('IssueByKey');
  t.setLive('ALE-1', 'ALE-2', 'ALE-3', 'ALE-4', 'ALE-5', 'ALE-6', 'ALE-7', 'ALE-8', 'ALE-9', 'ALE-101', 'ALE-102', 'ALE-200', 'other');
  t.tag('ALE-1', 'ALE-2', 'ALE-3', 'ALE-4', 'ALE-6', 'ALE-8', 'ALE-9', 'ALE-101', 'ALE-200');
  mkdirSync(t.dirOf(101), { recursive: true });
  t.printed.expectErrors = true;
  const live = () => JSON.parse(readFileSync(path.join(t.root, 'live.json'), 'utf8')).sort();
  await t.run('--once');
  assert.deepEqual(t.errorLines(), [
    'ALE-1: could not confirm the ticket is closed, so its session stays Error: injected IssueByKey failure',
    'ALE-6: could not confirm the ticket is closed, so its session stays Error: Linear has no ticket ALE-6',
    'ALE-200: could not confirm the ticket is closed, so its session stays Error: Linear 200: [{"message":"Entity not found"}]',
  ]);
  assert.deepEqual(live(), ['ALE-1', 'ALE-101', 'ALE-102', 'ALE-200', 'ALE-5', 'ALE-6', 'ALE-7', 'ALE-8', 'ALE-9', 'other'],
    'Done ALE-2, undelegated ALE-3 and Canceled ALE-4 die; ALE-1 hit a Linear error; Done ALE-5 and ALE-7 are untagged; Linear has no ALE-6; a person holds ALE-8 and is taking over ALE-9; open, foreign and unknown sessions stay');
  await t.run('--once');
  assert.ok(!live().includes('ALE-1'));
});

test('a lead the runner starts carries its tag, so it can be reaped later', async () => {
  const t = setup([issue(1)]);
  await t.run('--once');
  assert.equal(JSON.parse(readFileSync(path.join(t.root, 'tags.json'), 'utf8'))['ALE-1'], 'ALE-1');
});

test('a session the runner cannot tag is stopped, not left running outside the kill rule', async () => {
  const t = setup([issue(1)]);
  writeFileSync(path.join(t.root, 'tags.json.fail'), '');
  writeFileSync(path.join(t.root, 'live-on-start'), '');
  await t.run('--once');
  assert.deepEqual(JSON.parse(readFileSync(path.join(t.root, 'live.json'), 'utf8')), []);
});

test('a page that says more follows but gives no cursor fails the poll, and nothing starts or dies', async () => {
  const t = setup([issue(1)]);
  t.faults.push('NoCursor');
  t.printed.expectErrors = true;
  await t.run('--once');
  assert.deepEqual(t.errorLines(), ['poll failed Error: Linear gave no cursor']);
  assert.ok(!existsSync(path.join(t.root, 'tags.json')));
});

test('open tickets past the first page of 100 still start', async () => {
  const t = setup(Array.from({ length: 101 }, (_, k) => issue(k + 1, k < 100 ? { labels: [] } : {})));
  await t.run('--once');
  assert.ok(t.leads().some((l) => l.input.startsWith('Issue ALE-101:')));
});

test('lead slots: at most maxLeads run, a live lead holds its slot, and the runner says why once', async () => {
  const t = setup([issue(1), issue(2), issue(3), issue(4)], { maxLeads: 2 });
  const printed = t.printed.logs;
  await t.run('--once');
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-2']);
  assert.ok(printed.includes('Not starting ALE-3 yet: all 2 lead slots are busy'));
  t.setLive('ALE-1');
  await t.run('--once');
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-2', 'ALE-3'], 'the live lead holds one of the two slots');
});

test('a blocked ticket with news acks it once, in the comment thread, naming what it waits on', async () => {
  const screen = 'Make it work.\nNeeds: screen';
  const job = issue(1, { description: screen });
  const other = issue(2, { description: screen, delegate: null });
  const t = setup([job, other]);
  await t.run('--once');
  other.delegate = RUNNER;
  t.setLive('ALE-2');
  mkdirSync(t.dirOf(2), { recursive: true });
  job.comments.push({ id: 'h1', body: 'Use the blue icon.', createdAt: later(), user: { name: 'Alex' } });
  await t.run('--once');
  await t.run('--once');
  const acks = job.comments.filter((c) => c.body.startsWith('Seen.'));
  assert.deepEqual(acks.map((c) => [c.body, c.parentId]), [['Seen. Waiting to start: ALE-2 has the screen.', 'h1']]);
  assert.equal(t.leads().length, 1);
});

test('an ack to a reply in a thread goes to the thread root', async () => {
  const screen = 'Make it work.\nNeeds: screen';
  const job = issue(1, { description: screen });
  const other = issue(2, { description: screen, delegate: null });
  const t = setup([job, other]);
  await t.run('--once');
  other.delegate = RUNNER;
  t.setLive('ALE-2');
  mkdirSync(t.dirOf(2), { recursive: true });
  job.comments.push({ id: 'h2', body: 'And green.', createdAt: later(), user: { name: 'Alex' }, parentId: 'root' });
  await t.run('--once');
  assert.deepEqual(job.comments.filter((c) => c.body.startsWith('Seen.')).map((c) => c.parentId), ['root']);
});

test('each later Alex move gets its own ack, his own "Seen." does not suppress one, and acks are not news', async () => {
  const screen = 'Make it work.\nNeeds: screen';
  const job = issue(1, { description: screen });
  const other = issue(2, { description: screen, delegate: null });
  const t = setup([job, other]);
  const acks = () => job.comments.filter((c) => c.user?.name === RUNNER && c.body.startsWith('Seen.')).length;
  await t.run('--once');
  other.delegate = RUNNER;
  t.setLive('ALE-2');
  mkdirSync(t.dirOf(2), { recursive: true });
  job.comments.push({ id: 'h1', body: 'Use the blue icon.', createdAt: later(), user: { name: 'Alex' } });
  await t.run('--once');
  assert.equal(acks(), 1);
  job.comments.push({ id: 'h2', body: 'Seen. Also make it round.', createdAt: later(), user: { name: 'Alex' } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(acks(), 2, 'a later comment gets a fresh ack, even when it says "Seen."');
  t.setLive();
  await t.run('--once');
  const input = t.leads().find((l) => l.input.includes('Issue ALE-1') && l.input.includes('blue'))!.input;
  assert.doesNotMatch(input, /Waiting to start/, 'the runner\'s acks are not news');
});

test('a ticket with news from Alex starts before tickets that never started', async () => {
  const job = issue(1);
  const t = setup([job, issue(2), issue(3)], { maxLeads: 1 });
  await t.run('--once');
  job.comments.push({ id: 'h1', body: 'One more thing.', createdAt: later(), user: { name: 'Alex' } });
  await t.run('--once');
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-1']);
});

test('an Alex comment beats a Todo ticket whose old start brings only the delegation', async () => {
  const review = issue(1);
  const todo = issue(2);
  const t = setup([review, todo], { maxLeads: 2 });
  await t.run('--once');
  review.state = 'In Review';
  todo.state = 'Todo';
  review.comments.push({ id: 'h1', body: 'One more thing.', createdAt: later(), user: { name: 'Alex' } });
  const before = t.leads().length;
  await t.run('--once');
  assert.match(t.leads()[before].input, /Issue ALE-1/);
});

test('a Decision Alex closed beats a Todo ticket whose old start brings only the delegation', async () => {
  const review = issue(1);
  const todo = issue(2);
  const t = setup([review, todo], { maxLeads: 2 });
  await t.run('--once');
  await t.run('--once');
  const [mine] = t.decisions('id-1');
  const [theirs] = t.decisions('id-2');
  review.state = 'In Review';
  todo.state = 'Todo';
  t.close(mine);
  theirs.closedBy = RUNNER;
  t.close(theirs);
  const before = t.leads().length;
  await t.run('--once');
  assert.match(t.leads()[before].input, /Issue ALE-1/);
});

test('low free memory starts no lead', async () => {
  const job = issue(1);
  const t = setup([job]);
  t.setFreeMemory(12);
  await t.run('--once');
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
  const printed = t.printed.logs;
  await t.run('--dry-run');
  assert.ok(printed.includes('ALE-1: start'));
  assert.equal(job.state, 'Todo');
  assert.deepEqual(job.comments, []);
  assert.ok(!existsSync(t.config.worktreeRoot));
});

const child = (fields: Partial<Child>): Child => ({ id: 'c', identifier: 'ALE-9', title: 't', url: 'u', createdAt: '2026-01-01T00:00:00Z', completedAt: null, canceledAt: null, closedBy: null, assignee: { name: ALEX }, ...fields });
const ticket = (fields: Partial<Ticket>): Ticket => ({ state: 'started', delegate: RUNNER, comments: [], children: [], ...fields });
const cfg = { decisionAssignee: ALEX, runnerUser: RUNNER } as Config;

test('nextMove follows the model: wait on an open Decision, start on news, else decide', () => {
  const started = '2026-01-02T00:00:00Z';
  assert.equal(nextMove(cfg, ticket({}), null).kind, 'start');
  assert.equal(nextMove(cfg, ticket({ state: 'unstarted' }), started).kind, 'start');
  assert.equal(nextMove(cfg, ticket({}), started).kind, 'decide');
  assert.equal(nextMove(cfg, ticket({ children: [child({})] }), null).kind, 'wait', 'an open Decision beats delegation');
  assert.equal(nextMove(cfg, ticket({ children: [child({ assignee: null })] }), started).kind, 'decide', 'a sub-issue not assigned to Alex is not a Decision');
  assert.equal(nextMove(cfg, ticket({ children: [child({ completedAt: '2026-01-01T00:00:00Z', closedBy: ALEX })] }), started).kind, 'decide', 'an answer older than the start is old news');
  assert.equal(nextMove(cfg, ticket({ children: [child({ canceledAt: '2026-01-03T00:00:00Z', closedBy: ALEX })] }), started).kind, 'start');
  assert.equal(nextMove(cfg, ticket({ comments: [{ id: 'x', body: 'b', createdAt: '2026-01-03T00:00:00Z', user: { name: RUNNER, app: true } }] }), started).kind, 'decide');
  const said = (name: string, app = false) => ({ id: 'y', body: 'go with A', createdAt: '2026-01-03T00:00:00Z', user: { name, app } });
  assert.equal(nextMove(cfg, ticket({ children: [child({})] }), started).kind, 'wait', 'an open Decision with no news waits');
  assert.deepEqual(nextMove(cfg, ticket({ children: [child({})], comments: [said(ALEX)] }), started), { kind: 'start', news: [`${ALEX} commented: go with A`] }, 'a comment may answer the open Decision');
  assert.equal(nextMove(cfg, ticket({ children: [child({})], comments: [said(RUNNER, true)] }), started).kind, 'wait', 'the runner is not news');
  assert.equal(nextMove(cfg, ticket({ children: [child({})], comments: [said('alex-jxp', true)] }), started).kind, 'wait', 'an app user is not news');
  assert.equal(nextMove(cfg, ticket({ children: [child({}), child({ id: 'd', completedAt: '2026-01-03T00:00:00Z', closedBy: ALEX })] }), started).kind, 'start', 'closing another Decision is news');
  // Alex answered A on the ticket; the lead started, closed A itself, and stopped to wait on B. Its own closure must not start it again.
  const leadClosedA = child({ id: 'a', completedAt: '2026-01-03T00:00:00Z', closedBy: RUNNER });
  assert.equal(nextMove(cfg, ticket({ children: [leadClosedA, child({ id: 'b' })] }), started).kind, 'wait', 'a Decision the lead closed is not news');
  assert.equal(nextMove(cfg, ticket({ children: [leadClosedA] }), started).kind, 'decide', 'a Decision the lead closed is not news');
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
  const base = { running: 0, maxLeads: 2, freeMemory: 40, minFreeMemory: 20, needsScreen: false, screenHolder: null };
  assert.equal(startBlock(base), null);
  assert.match(startBlock({ ...base, running: 2 }) ?? '', /slots are busy/);
  assert.match(startBlock({ ...base, freeMemory: 19 }) ?? '', /only 19% of memory is free/);
  assert.equal(startBlock({ ...base, needsScreen: true, screenHolder: 'ALE-9' }), 'ALE-9 has the screen');
  assert.equal(startBlock({ ...base, screenHolder: 'ALE-9' }), null);
});

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('on a real tmux server, a window the lead opens gets its tokens and none of the stray Pi variables', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  const t = setup([issue(1)], { ghTokenCommand: 'echo gh-secret | tr a-z A-Z' });
  const socket = `runner-test-${process.pid}`;
  const out = path.join(t.root, 'window.env');
  writeFileSync(path.join(t.root, 'tmux'), `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(t.root, 'pi'), `#!/bin/sh\ntmux -L ${socket} new-window "env > ${out}"\nsleep 30\n`, { mode: 0o755 });
  try {
    await t.run('--once');
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
    const env = readFileSync(out, 'utf8').split('\n');
    for (const line of ['LINEAR_TOKEN=test-token', 'GH_TOKEN=GH-SECRET', 'PI_AUTH_PROFILE=kept']) assert.ok(env.includes(line), line);
    assert.deepEqual(env.filter((l) => /^(PI_SUBAGENT_NAME|PI_X2_TOKEN|PSTACK_9|CMUX_SURFACE_ID)=/.test(l)), []);
  } finally {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
});

test('lastActivity is the latest of the lead start, its activity file and its windows', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-quiet-'));
  const now = Date.now();
  mkdirSync(path.join(dir, '.runner'));
  writeFileSync(path.join(dir, '.runner', 'started'), new Date(now - 60 * 60000).toISOString());
  assert.equal(lastActivity({ dir }), now - 60 * 60000);
  writeFileSync(path.join(dir, '.runner', 'activity.json'), JSON.stringify({ updatedAt: now - 7 * 60000 }));
  assert.equal(lastActivity({ dir }), now - 7 * 60000);
  assert.equal(lastActivity({ dir }, now - 2 * 60000), now - 2 * 60000, 'output in any tmux window counts');
});

test('GH_TOKEN from ghTokenCommand reaches the lead, and the lead environment is mirrored into its tmux session', async () => {
  const t = setup([issue(1)], { ghTokenCommand: 'echo gh-secret | tr a-z A-Z' });
  await t.run('--once');
  const [lead] = t.leads();
  assert.equal(lead.ghToken, 'GH-SECRET');
  assert.ok(!readFileSync(path.join(t.dirOf(1), '.runner', 'lead.sh'), 'utf8').includes('GH-SECRET'), 'the token never lands on disk');
  const env = t.tmux().filter((a) => a[0] === 'set-environment').map((a) => a.slice(1).join(' '));
  for (const line of ['-t =ALE-1 GH_TOKEN GH-SECRET', '-t =ALE-1 LINEAR_TOKEN test-token', '-t =ALE-1 PI_AUTH_PROFILE kept', '-t =ALE-1 -r PI_SUBAGENT_NAME', '-t =ALE-1 -r PSTACK_9', '-t =ALE-1 -r CMUX_SURFACE_ID']) {
    assert.ok(env.includes(line), `subagent windows get: ${line}`);
  }
});

test('put replaces a file whole and leaves no temp file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'job-runner-put-'));
  put(path.join(dir, 'a.json'), 'one');
  put(path.join(dir, 'a.json'), 'two');
  assert.equal(readFileSync(path.join(dir, 'a.json'), 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['a.json']);
});
