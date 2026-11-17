import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { format } from 'node:util';
import { createHmac } from 'node:crypto';
import { auditDelay, commands, main, nextMove, put, renderStatus, serve, signed, startBlock, type Child, type Config, type Ticket } from './runner.ts';

type FakeComment = { id: string; body: string; url?: string; createdAt: string; user: { name: string } | null; botActor?: { name: string } | null; parentId?: string; reactions?: { emoji: string; user: { name: string } }[] };
/** A history entry: who changed what. Linear returns every field the query names, null when unset. */
type FakeChange = { createdAt: string; actor?: { name: string } | null; botActor?: { name: string } | null; attachment?: { sourceType: string }; toState?: { name: string }; toDelegate?: { name: string }; addedLabelIds?: string[]; toTitle?: string };
type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; state: string; delegate: string | null; assignee: string | null; parent: string | null; labels: string[]; comments: FakeComment[];
  completedAt: string | null; canceledAt: string | null; history: FakeChange[];
};

const RUNNER = 'runner test';
const TYPES: Record<string, string> = { Todo: 'unstarted', 'In Progress': 'started', 'In Review': 'started', Done: 'completed', Canceled: 'canceled', Backlog: 'backlog' };
const ALEX = 'Alex Example';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
const wireComment = (c: FakeComment) => ({ parentId: null, botActor: null, reactions: [], ...c });
const CHANGE = { actor: null, botActor: null, attachment: null, toState: null, toDelegate: null, fromDelegate: null, toAssignee: null, addedLabelIds: null, removedLabelIds: null, toTitle: null, updatedDescription: null };
/** Now. `run` waits a few ms first, so a fact made here is older than the next lead start. */
const later = () => new Date().toISOString();
/** Writes a Pi session log for `cwd` whose last message is `last`, last written `minutes` ago. */
function sessionLog(agent: string, cwd: string, name: string, minutes: number, last: Record<string, unknown>) {
  const folder = path.join(agent, 'sessions', `--${cwd.replace(/^\//, '').replace(/[/:]/g, '-')}--`);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.jsonl`);
  writeFileSync(file, `{"type":"session","id":"${name}"}\n${JSON.stringify({ type: 'message', message: last })}\n`);
  const at = new Date(Date.now() - minutes * 60000);
  utimesSync(file, at, at);
}
const IDLE = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Waiting on the reviewer.' }] };
const TOOL_CALL = { role: 'assistant', stopReason: 'toolUse', content: [] };

function issue(n: number, fields: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: `id-${n}`, identifier: `ALE-${n}`, title: `Job number ${n}`, description: 'Make it work.',
    url: `https://linear.app/x/issue/ALE-${n}`, createdAt: `2026-01-0${n}T00:00:00Z`, team: 'ALE', state: 'Todo',
    delegate: RUNNER, assignee: null, parent: null, labels: ['pstack-pi'], comments: [], completedAt: null, canceledAt: null,
    history: [{ createdAt: `2026-01-0${n}T00:00:01Z`, actor: { name: ALEX }, toDelegate: { name: RUNNER } }], ...fields,
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
`, { mode: 0o755 });
  writeFileSync(file('memory_pressure'), `#!/bin/sh\necho "System-wide memory free percentage: $(cat ${JSON.stringify(file('free'))} 2>/dev/null || echo 60)%"\n`, { mode: 0o755 });
  Object.assign(process.env, {
    JOB_RUNNER_PI: file('pi'), JOB_RUNNER_TMUX: file('tmux'), JOB_RUNNER_MEMORY_PRESSURE: file('memory_pressure'),
    PI_SUBAGENT_NAME: 'outer session', PI_X2_TOKEN: 'outer', PSTACK_9: 'outer', CMUX_SURFACE_ID: 'outer', PI_AUTH_PROFILE: 'kept',
  });

  const config: Config = {
    linearTokenCommand: `cat ${file('token')}`, team: 'ALE', runnerUser: RUNNER, decisionAssignee: ALEX,
    repos: { 'pstack-pi': { path: repo, base: 'main' } },
    models: { lead: 'lead-model', review: 'review-model' }, thinking: 'high', pollSeconds: 0.01, webhookPort: 0, auditPoll: 'every 10m', maxLeads: options.maxLeads ?? 2,
    minFreeMemoryPercent: 20, stallMinutes: options.stallMinutes ?? 30, toolQuietMinutes: 60, host: 'test-host', worktreeRoot: file('worktrees'),
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
  /** Makes every reply say the request budget is under 20%. */
  const lowBudget = { value: false };
  writeFileSync(file('token'), 'test-token\n');
  /** Linear lists comments and history newest first, 25 to a page. */
  const paged = (all: (FakeComment | FakeChange)[], after?: string) => {
    const newest = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => ('body' in x ? wireComment(x) : { ...CHANGE, ...x }));
    const from = Number(after ?? 0);
    return { nodes: newest.slice(from, from + 25), pageInfo: { hasNextPage: from + 25 < newest.length, endCursor: String(from + 25) } };
  };
  /** An issue as the list query returns it. Like Linear, a comment does not move `updatedAt`. */
  const listed = (x: FakeIssue) => ({
    ...x, assignee: x.assignee ? { name: x.assignee } : null,
    updatedAt: [x.createdAt, ...x.history.map((h) => h.createdAt)].sort().at(-1),
    comments: { nodes: x.comments.map((c) => ({ createdAt: c.createdAt })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1) },
  });
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    const { query, variables: v } = JSON.parse(String(init?.body));
    const op = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '';
    ops.push(op);
    if (faults.includes(op)) { faults.splice(faults.indexOf(op), 1); throw new Error(`injected ${op} failure`); }
    if (faults.includes('RateLimit')) {
      faults.splice(faults.indexOf('RateLimit'), 1);
      return Response.json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, { status: 429, headers: { 'Retry-After': '0.01' } });
    }
    const headers: Record<string, string> = lowBudget.value ? { 'X-RateLimit-Requests-Limit': '5000', 'X-RateLimit-Requests-Remaining': '900' } : {};
    const find = (id: string) => issues.find((i) => i.id === id)!;
    const data = (value: unknown) => Response.json({ data: value }, { headers });
    if (op === 'Issues') {
      const open = issues.filter((i) => i.team === v.team && ['unstarted', 'started'].includes(TYPES[i.state]) && i.delegate === v.user);
      const from = Number(v.after ?? 0);
      const page = open.slice(from, from + 100);
      return data({ issues: {
        nodes: page.map((i) => ({ ...listed(i), state: { type: TYPES[i.state] }, labels: { nodes: i.labels.map((name) => ({ name })) },
          children: { nodes: issues.filter((c) => c.parent === i.id).reverse().map(listed), pageInfo: { hasNextPage: false } } })),
        pageInfo: { hasNextPage: from + 100 < open.length || faults.includes('NoCursor'), endCursor: faults.includes('NoCursor') ? null : String(from + 100) },
      } });
    }
    if (op === 'IssueByKey') {
      const i = issues.find((x) => x.identifier === v.key);
      if (v.key === 'ALE-6') return data({ issue: null });
      if (!i) return Response.json({ errors: [{ message: 'Entity not found' }] });
      return data({ issue: { state: { type: TYPES[i.state] }, delegate: i.delegate ? { name: i.delegate } : null } });
    }
    if (op === 'More') {
      const conn = /issue\(id: \$id\) \{ (\w+)/.exec(query)![1] as 'comments' | 'history';
      return data({ issue: { [conn]: paged(find(v.id)[conn], v.after) } });
    }
    if (op === 'StatusComment') return data({ issue: { comments: { nodes: find(v.id).comments.filter((c) => c.body.startsWith('**Runner:**')).map(wireComment) } } });
    if (op === 'IssueById') {
      const found = issues.filter((x) => v.ids.includes(x.id) && !gone.has(x.id));
      const wire = (x: FakeIssue) => ({ id: x.id, identifier: x.identifier, comments: paged(x.comments), history: paged(x.history) });
      return data({ issues: { nodes: found.map(wire) } });
    }
    if (op === 'State') return data({ workflowStates: { nodes: missingStates.has(v.name) ? [] : [{ id: `state-${v.name}` }] } });
    if (op === 'Team') return data({ teams: { nodes: [{ id: 'team-ale' }] } });
    if (op === 'User') return data({ users: { nodes: v.name === ALEX ? [{ id: 'user-alex' }] : [] } });
    if (op === 'Update') {
      if (v.input.stateId) find(v.id).state = v.input.stateId.slice(6);
      if ('delegateId' in v.input) find(v.id).delegate = v.input.delegateId;
      find(v.id).history.push({ createdAt: new Date().toISOString(), actor: { name: RUNNER }, ...(v.input.stateId ? { toState: { name: v.input.stateId.slice(6) } } : {}) });
      return data({ issueUpdate: { success: true } });
    }
    if (op === 'Comment') {
      find(v.input.issueId).comments.push({ id: `comment-${++nextId}`, body: v.input.body, createdAt: new Date().toISOString(), user: { name: RUNNER }, parentId: v.input.parentId });
      return data({ commentCreate: { success: true } });
    }
    if (op === 'React') {
      const c = issues.flatMap((i) => i.comments).find((x) => x.id === v.input.commentId)!;
      c.reactions = [...(c.reactions ?? []), { emoji: v.input.emoji, user: { name: RUNNER } }];
      return data({ reactionCreate: { success: true } });
    }
    if (op === 'EditComment') {
      issues.flatMap((i) => i.comments).find((c) => c.id === v.id)!.body = v.input.body;
      return data({ commentUpdate: { success: true } });
    }
    if (op === 'CreateIssue') {
      assert.equal(v.input.teamId, 'team-ale');
      const n = 100 + ++nextId;
      const at = new Date().toISOString();
      issues.push(issue(n, { title: v.input.title, description: v.input.description, createdAt: at, state: 'Todo', delegate: null, labels: [], assignee: v.input.assigneeId === 'user-alex' ? ALEX : null, parent: v.input.parentId, history: [{ createdAt: at, actor: { name: RUNNER } }] }));
      return data({ issueCreate: { issue: { identifier: `ALE-${n}`, url: `https://linear.app/x/issue/ALE-${n}` } } });
    }
    throw new Error(`unexpected Linear operation ${op}`);
  };
  const dirOf = (n: number) => path.join(config.worktreeRoot, `job-ale-${n}-job-number-${n}`);
  /** What the runner printed. A test that expects errors sets `expectErrors` and asserts on `errors`; otherwise any error fails the run. */
  const printed = { logs: [] as string[], errors: [] as string[], expectErrors: false };
  return {
    config, ops, faults, lowBudget, root, repo, dirOf, gone, missingStates, printed,
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
    /**
     * Starts the runner with a webhook on a free port, logging into `printed`. `post` sends a delivery signed with
     * `secret` unless told otherwise, and waits for the passes it queued.
     */
    serve: async () => {
      const { log, error } = console;
      console.log = (...args: unknown[]) => { printed.logs.push(format(...args)); };
      console.error = (...args: unknown[]) => { printed.errors.push(format(...args)); };
      const runner = await serve(config, fakeFetch as typeof fetch, 'test-secret', 0);
      const post = async (payload: Record<string, unknown>, o: { secret?: string; delivery?: string; at?: number } = {}) => {
        const body = JSON.stringify({ webhookTimestamp: o.at ?? Date.now(), ...payload });
        const res = await fetch(`http://127.0.0.1:${runner.port}/linear`, {
          method: 'POST', body,
          headers: { 'Content-Type': 'application/json', 'Linear-Signature': createHmac('sha256', o.secret ?? 'test-secret').update(body).digest('hex'), ...(o.delivery ? { 'Linear-Delivery': o.delivery } : {}) },
        });
        await runner.idle();
        return res.status;
      };
      return {
        post, port: runner.port, audit: () => runner.audit(), heartbeat: () => runner.heartbeat(),
        close: async () => {
          await runner.close();
          Object.assign(console, { log, error });
          if (!printed.expectErrors) assert.deepEqual(printed.errors, [], 'the runner printed an unexpected error');
        },
      };
    },
    leads: () => lines(file('pi.log')).map((line) => JSON.parse(line)),
    tmux: () => lines(file('tmux.log')).map((line) => JSON.parse(line) as string[]),
    decisions: (parent = 'id-1') => issues.filter((i) => i.parent === parent),
    addIssue: (x: FakeIssue) => { issues.push(x); },
    setLive: (...keys: string[]) => writeFileSync(file('live.json'), JSON.stringify(keys)),
    /** Marks sessions as the runner's, as its `set-option @job-runner` does. */
    tag: (...keys: string[]) => writeFileSync(file('tags.json'), JSON.stringify(Object.fromEntries(keys.map((k) => [k, k])))),
    setFreeMemory: (percent: number) => writeFileSync(file('free'), `${percent}\n`),
    /** Someone, Alex by default, closes a Decision issue after the lead's last start. */
    close: (d: FakeIssue, how: 'Done' | 'Canceled' = 'Done', by = ALEX) => {
      const at = later();
      d.state = how; d[how === 'Done' ? 'completedAt' : 'canceledAt'] = at;
      d.history.push({ createdAt: at, actor: { name: by }, toState: { name: how } });
    },
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
  assert.deepEqual(lead.piVars, ['PI_AUTH_PROFILE', 'PI_SUBAGENT_ID'], 'outer PI_*, PSTACK_* and CMUX_* are gone, digits included');
  assert.ok(!readFileSync(path.join(dir, '.runner', 'lead.sh'), 'utf8').includes('test-token'), 'the token never lands on disk');
  assert.match(lead.input, /^Issue ALE-1: Job number 1[\s\S]*Linear issue id: id-1\.[\s\S]*Events since your last start:\n- 2026-01-01T00:00:01Z ALE-1: Alex Example delegated it to runner test\n\nOther leads running now [^\n]*\n- none$/);
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
    assert.match(leads[1].input, new RegExp(`${decision.identifier}: ${ALEX} moved it to ${how}`));
    assert.equal(t.decisions().length, 2, 'after the woken lead stops, a new ask');
  }
});

test('a comment on an open Decision issue starts the lead; the runner\'s own comments and the lead closing it do not', async () => {
  const all = [issue(1)];
  const t = setup(all);
  await t.run('--once');
  const asked = issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], createdAt: later(), history: [] });
  all.push(asked);
  asked.comments.push({ id: 'r1', body: 'Status.', createdAt: later(), user: { name: RUNNER } });
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'waits on the open Decision');
  asked.comments.push({ id: 'h1', body: 'Go with A.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, /- \S+ ALE-50: Alex Example commented: Go with A\./);
  t.close(asked, 'Done', RUNNER);
  await t.run('--once');
  assert.equal(t.leads().length, 2, 'the lead closing it is its own act');
});

test('a busy ticket pages back to the last start: an event under 60 newer changes, over two pages of 25, still starts the lead', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  job.comments.push({ id: 'h1', body: 'One more thing.', createdAt: later(), user: { name: ALEX } });
  const at = Date.now() + 1000;
  job.history.push(...Array.from({ length: 60 }, (_, k) => ({ createdAt: new Date(at + k).toISOString(), actor: { name: RUNNER } })));
  job.comments.push(...Array.from({ length: 60 }, (_, k) => ({ id: `r${k}`, body: 'progress', createdAt: new Date(at + k).toISOString(), user: { name: RUNNER } })));
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, /Alex Example commented: One more thing\./);
  assert.ok(t.ops.includes('More'));
});

test('a label or title change by Alex starts the lead; the GitHub integration moving it to In Review does not', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.decisions().length, 1);
  const link = Date.now();
  job.history.push(
    { createdAt: new Date(link).toISOString(), botActor: { name: 'Linear' }, attachment: { sourceType: 'github' } },
    { createdAt: new Date(link + 80).toISOString(), actor: { name: ALEX }, toState: { name: 'In Review' } },
  );
  job.state = 'In Review';
  t.close(t.decisions()[0]);
  await t.run('--once');
  assert.doesNotMatch(t.leads()[1].input, /In Review/, 'Linear credits the integration\'s move to the PR author');
  for (const [k, change] of [{ addedLabelIds: ['l1'] }, { toTitle: 'Better name' }].entries()) {
    const before = t.leads().length;
    job.history.push({ createdAt: new Date(link + 5000 + k).toISOString(), actor: { name: ALEX }, ...change });
    await t.run('--once');
    assert.equal(t.leads().length, before + 1, JSON.stringify(change));
  }
  assert.match(t.leads().at(-1).input, /ALE-1: Alex Example retitled it "Better name"/);
});

test('an Alex label edit 1 s after an integration entry still counts', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  await t.run('--once');
  const link = Date.now();
  job.history.push(
    { createdAt: new Date(link).toISOString(), botActor: { name: 'Linear' }, attachment: { sourceType: 'github' } },
    { createdAt: new Date(link + 1000).toISOString(), actor: { name: ALEX }, addedLabelIds: ['l1'] },
  );
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, /ALE-1: Alex Example changed its labels/);
});

test('a live lead costs one per-ticket read for the runner\'s own touch, then none until something changes', async () => {
  const t = setup([issue(1)]);
  await t.run('--once');
  t.setLive('ALE-1');
  const srv = await t.serve();
  try {
    await srv.audit();
    t.ops.length = 0;
    await srv.audit();
    assert.deepEqual(t.ops, ['Issues']);
  } finally { await srv.close(); }
});

test('a 429 waits Retry-After and tries again; a low budget is logged once', async () => {
  const t = setup([issue(1)]);
  t.faults.push('RateLimit');
  t.lowBudget.value = true;
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.printed.logs.filter((l) => l === 'Linear rate limit hit; waiting 0.01 s').length, 1);
  assert.equal(t.printed.logs.filter((l) => l.startsWith('Linear requests budget is low: 900 of 5000')).length, 2, 'once per runner start');
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

test('integration comments do not wake the lead; another app\'s comment does', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  job.comments.push({ id: 'b2', body: 'Linked a PR.', createdAt: later(), user: null, botActor: { name: 'GitHub' } });
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.decisions().length, 1);
  job.comments.push({ id: 'a1', body: 'Please also do B.', createdAt: later(), user: { name: 'alex-jxp' } });
  await t.run('--once');
  assert.equal(t.leads().length, 2);
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

test('a quiet live lead gets Escape and one nudge, then one investigator and no Decision issue; takeover holds it off; the second quiet stretch in a run gets the investigator, a third nothing, and a new start resets', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { stallMinutes: 5 });
  const agent = path.join(t.root, 'agent');
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await t.run('--once');
    t.setLive('ALE-1');
    const dir = t.dirOf(1);
    const runner = path.join(dir, '.runner');
    const keys = () => t.tmux().filter((a) => a[0] === 'send-keys' && !a.at(-1)!.startsWith('Linear event')).map((a) => (a.includes('-l') ? 'nudge' : a.at(-1)));
    const nudges = () => keys().filter((k) => k === 'nudge').length;
    const investigators = () => t.tmux().filter((a) => a[0] === 'new-session' && a.includes('ALE-1-stall')).length;
    await t.run('--once');
    assert.equal(nudges(), 0, 'a lead that just started is left alone');
    put(path.join(runner, 'started'), new Date(Date.now() - 20 * 60000).toISOString());
    sessionLog(agent, dir, 'lead', 10, IDLE);
    sessionLog(agent, dir, 'reviewer', 2, IDLE);
    await t.run('--once');
    assert.equal(nudges(), 0, 'a subagent that wrote 2 minutes ago keeps the lead alive');
    sessionLog(agent, dir, 'reviewer', 6, IDLE);
    sessionLog(agent, `${dir}-unit`, 'sublead', 0, IDLE);
    await t.run('--once');
    assert.equal(nudges(), 0, 'a sub-lead writing now in a sibling worktree keeps the lead alive');
    sessionLog(agent, `${dir}-unit`, 'sublead', 6, IDLE);
    sessionLog(agent, `${dir}-quiz`, 'quiz', 0, IDLE);
    sessionLog(agent, dir.replace('job-ale-1-', 'job-ale-10-'), 'other-ticket', 0, IDLE);
    sessionLog(agent, path.join(dir, '.runner'), 'investigator', 0, IDLE);
    put(path.join(runner, 'takeover'), '');
    await t.run('--once');
    assert.equal(nudges(), 0, 'a person took it over');
    rmSync(path.join(runner, 'takeover'));
    await t.run('--once');
    await t.run('--once');
    assert.deepEqual(keys(), ['Escape', 'nudge', 'Enter'], 'every log idle for 5 minutes: Escape closes any selector, then one nudge; neither the investigator log nor a quiz fork writing now counts');
    assert.match(t.tmux().find((a) => a.includes('-l'))!.at(-1)!, /No progress from you or your subagents for 6 minutes\. Check each subagent/);
    assert.match(job.comments.find((c) => c.body.startsWith('**Runner:**'))!.body, /nudged it/);
    assert.equal(investigators(), 0, 'the investigator waits another stallMinutes');
    const stall = path.join(runner, 'stall.json');
    const nudgedAt = Date.now() - 12 * 60000;
    put(stall, JSON.stringify({ nudgedAt }));
    sessionLog(agent, dir, 'lead', 3, IDLE);
    await t.run('--once');
    assert.equal(investigators(), 0, 'the lead answered the nudge 3 minutes ago: not quiet yet');
    sessionLog(agent, dir, 'lead', 6, IDLE);
    await t.run('--once');
    await t.run('--once');
    assert.deepEqual([nudges(), investigators()], [1, 1], 'answered, then idle again: the second stretch starts one investigator, not a second nudge');
    assert.equal(t.decisions().length, 0, 'the investigator, not the runner, decides whether Alex must act');
    const script = readFileSync(path.join(runner, 'stall.sh'), 'utf8');
    assert.match(script, /cd .*\.runner \|\| exit 1\n.*pi -p --model lead-model[\s\S]*prompts\/stall\.md/, 'the investigator runs from .runner, so its log lands outside the lead folder');
    assert.ok(t.leads().some((l) => /quiet a second time since the runner nudged it/.test(l.input)), 'the investigator ran with its facts');
    sessionLog(agent, dir, 'lead', 30, IDLE);
    await t.run('--once');
    assert.deepEqual([nudges(), investigators()], [1, 1], 'a third stretch in the same run does nothing');
    t.setLive();
    job.comments.push({ id: 'c-2', body: 'Go on.', createdAt: later(), user: { name: ALEX } });
    await t.run('--once');
    t.setLive('ALE-1');
    put(path.join(runner, 'started'), new Date(Date.now() - 20 * 60000).toISOString());
    await t.run('--once');
    assert.deepEqual([nudges(), investigators()], [2, 1], 'a new lead start resets the count: a fresh nudge');
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test('a pending tool call keeps the lead alive for toolQuietMinutes, then gets Escape and a nudge', async () => {
  const t = setup([issue(1, { state: 'In Progress' })], { stallMinutes: 5 });
  const agent = path.join(t.root, 'agent');
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await t.run('--once');
    t.setLive('ALE-1');
    put(path.join(t.dirOf(1), '.runner', 'started'), new Date(Date.now() - 120 * 60000).toISOString());
    const keys = () => t.tmux().filter((a) => a[0] === 'send-keys').map((a) => (a.includes('-l') ? a.at(-1) : a.at(-1)));
    sessionLog(agent, t.dirOf(1), 'lead', 59, TOOL_CALL);
    await t.run('--once');
    sessionLog(agent, t.dirOf(1), 'lead', 30, { role: 'toolResult', content: [] });
    await t.run('--once');
    assert.deepEqual(keys(), [], 'a tool call or a model call in flight under 60 minutes is alive');
    sessionLog(agent, t.dirOf(1), 'lead', 30, { role: 'toolResult', content: [{ type: 'image', data: 'A'.repeat(2 << 20) }] });
    await t.run('--once');
    assert.deepEqual(keys(), [], 'a 2 MB screenshot result past the 1 MB tail still reads as busy');
    sessionLog(agent, t.dirOf(1), 'lead', 61, TOOL_CALL);
    await t.run('--once');
    assert.equal(keys()[0], 'Escape');
    assert.match(keys()[1]!, /for 61 minutes, so the runner pressed Escape to stop your tool or wait/);
    assert.equal(keys()[2], 'Enter');
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
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

test('a blocked ticket with an event acks it once, in the comment thread, naming what it waits on', async () => {
  const job = issue(1);
  const other = issue(2, { delegate: null });
  const t = setup([job, other], { maxLeads: 1 });
  await t.run('--once');
  other.delegate = RUNNER;
  t.setLive('ALE-2');
  mkdirSync(t.dirOf(2), { recursive: true });
  job.comments.push({ id: 'h1', body: 'Use the blue icon.', createdAt: later(), user: { name: 'Alex' } });
  await t.run('--once');
  await t.run('--once');
  const acks = job.comments.filter((c) => c.body.startsWith('Seen.'));
  assert.deepEqual(acks.map((c) => [c.body, c.parentId]), [['Seen. Waiting to start: all 1 lead slots are busy.', 'h1']]);
  assert.equal(t.leads().length, 1);
});

test('two screen tickets start together, and running.json lists the running leads with the screen flag', async () => {
  const screen = 'Make it work.\nNeeds: screen';
  const t = setup([issue(1, { description: screen }), issue(2, { description: screen }), issue(3)], { maxLeads: 3 });
  const list = () => JSON.parse(readFileSync(path.join(t.config.worktreeRoot, 'running.json'), 'utf8')) as { key: string; needsScreen: boolean; worktree: string; startedAt: string }[];
  await t.run('--once');
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-2', 'ALE-3']);
  assert.deepEqual(list().map((r) => [r.key, r.needsScreen]), [['ALE-1', true], ['ALE-2', true], ['ALE-3', false]]);
  assert.equal(list()[0].worktree, t.dirOf(1));
  assert.ok(list()[0].startedAt);
  const third = t.leads()[2].input;
  assert.match(third, /running\.json/);
  assert.match(third, /- ALE-1: .*Needs: screen\)/);
  assert.match(third, /- ALE-2: /);
  assert.match(t.leads()[0].input, /Other leads running now.*\n- none/);
  t.setLive('ALE-2', 'ALE-3');
  await t.run('--once');
  assert.deepEqual(list().map((r) => r.key), ['ALE-2', 'ALE-3'], 'a finished lead drops off the list');
});

test('an ack to a reply in a thread goes to the thread root', async () => {
  const job = issue(1);
  const other = issue(2, { delegate: null });
  const t = setup([job, other], { maxLeads: 1 });
  await t.run('--once');
  other.delegate = RUNNER;
  t.setLive('ALE-2');
  mkdirSync(t.dirOf(2), { recursive: true });
  job.comments.push({ id: 'h2', body: 'And green.', createdAt: later(), user: { name: 'Alex' }, parentId: 'root' });
  await t.run('--once');
  assert.deepEqual(job.comments.filter((c) => c.body.startsWith('Seen.')).map((c) => c.parentId), ['root']);
});

test('each later Alex move gets its own ack, his own "Seen." does not suppress one, and acks are not events', async () => {
  const job = issue(1);
  const other = issue(2, { delegate: null });
  const t = setup([job, other], { maxLeads: 1 });
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
  assert.doesNotMatch(input, /Waiting to start/, 'the runner\'s acks are not events');
});

test('the ticket whose oldest unseen event is oldest starts first', async () => {
  const one = issue(1);
  const two = issue(2);
  const t = setup([one, two, issue(3)], { maxLeads: 3 });
  await t.run('--once');
  const now = Date.now();
  two.comments.push({ id: 'h2', body: 'First.', createdAt: new Date(now).toISOString(), user: { name: ALEX } });
  one.comments.push({ id: 'h1', body: 'Second.', createdAt: new Date(now + 1).toISOString(), user: { name: ALEX } });
  t.setLive('ALE-3');
  t.config.maxLeads = 2;
  await t.run('--once');
  assert.deepEqual(t.leads().slice(3).map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-2']);
});

test('a ticket with an event goes before a quiet ticket ahead of it in Linear order', async () => {
  const busy = issue(2);
  const t = setup([issue(1), busy]);
  await t.run('--once');
  await t.run('--once');
  busy.comments.push({ id: 'h1', body: 'One more thing.', createdAt: later(), user: { name: ALEX } });
  await t.run('--dry-run');
  assert.deepEqual(t.printed.logs.filter((l) => /^ALE-\d: /.test(l)), ['ALE-2: start', 'ALE-1: wait']);
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

test('a failed start files one Decision across polls with no new event, and a new comment retries once', async () => {
  const job = issue(1, { state: 'In Progress', comments: [{ id: 'h1', body: 'Go.', createdAt: later(), user: { name: ALEX } }] });
  const t = setup([job]);
  mkdirSync(t.dirOf(1), { recursive: true });
  for (let i = 0; i < 5; i++) await t.run('--once');
  assert.equal(t.decisions().length, 1);
  assert.equal(t.leads().length, 0);
  rmSync(t.dirOf(1), { recursive: true });
  job.comments.push({ id: 'h2', body: 'Try again.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
});

test('a refused folder gets no runner files; the failed attempt is kept outside it', async () => {
  const t = setup([issue(1)]);
  mkdirSync(t.dirOf(1), { recursive: true });
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual(readdirSync(t.dirOf(1)), []);
  assert.ok(existsSync(path.join(t.config.worktreeRoot, '.attempts', 'ALE-1')));
  assert.equal(t.decisions().length, 1);
});

test('a worktree on the lead PR branch starts the lead', async () => {
  const t = setup([issue(1)]);
  git(t.repo, 'worktree', 'add', '-q', '-b', 'job/ale-1-pr-branch', t.dirOf(1), 'origin/main');
  await t.run('--once');
  assert.equal(t.decisions().length, 0);
  assert.equal(t.leads().length, 1);
});

test('the runner never files a Decision while its own Decision on the ticket is open', async () => {
  const job = issue(1, { state: 'In Progress', comments: [{ id: 'h1', body: 'Go.', createdAt: later(), user: { name: ALEX } }] });
  const open = issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], title: 'Decision for ALE-1: the runner could not start the lead', createdAt: later() });
  const t = setup([job, open]);
  mkdirSync(t.dirOf(1), { recursive: true });
  for (let i = 0; i < 5; i++) await t.run('--once');
  assert.equal(t.decisions().length, 1);
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

const child = (fields: Partial<Child>): Child => ({ id: 'c', identifier: 'ALE-9', title: 't', url: 'u', createdAt: '2026-01-01T00:00:00Z', completedAt: null, canceledAt: null, assignee: { name: ALEX }, ...fields });
const ticket = (fields: Partial<Ticket>): Ticket => ({ state: 'started', description: '', createdAt: '2026-01-01T00:00:00Z', mine: [], children: [], events: [], ...fields });
const cfg = { decisionAssignee: ALEX, runnerUser: RUNNER } as Config;

test('nextMove follows the model: start on an event, else wait on an open Decision, else decide', () => {
  const started = '2026-01-02T00:00:00Z';
  const event = { at: '2026-01-03T00:00:00Z', what: 'ALE-1: Alex Example commented: go with A' };
  assert.equal(nextMove(cfg, ticket({}), started).kind, 'decide');
  assert.equal(nextMove(cfg, ticket({ events: [{ ...event, at: '2026-01-01T00:00:00Z' }] }), started).kind, 'decide', 'an event before the start is seen');
  assert.deepEqual(nextMove(cfg, ticket({ children: [child({})], events: [event] }), started), { kind: 'start', events: [event] }, 'an event may answer the open Decision');
  assert.equal(nextMove(cfg, ticket({ children: [child({})] }), started).kind, 'wait');
  assert.equal(nextMove(cfg, ticket({ children: [child({ assignee: null })] }), started).kind, 'decide', 'a sub-issue not assigned to Alex is not a Decision');
  assert.equal(nextMove(cfg, ticket({ children: [child({})], events: [event] }), '2026-01-04T00:00:00Z').kind, 'wait', 'a failed attempt after the event has seen it');
  assert.equal(nextMove(cfg, ticket({ description: 'Do it.\n\nrunner-routine audit 2026-01-01T09:00:00.000Z' }), null).kind, 'start', 'a routine ticket starts on its creation');
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

test('startBlock enforces lead slots and free memory', () => {
  const base = { running: 0, maxLeads: 2, freeMemory: 40, minFreeMemory: 20 };
  assert.equal(startBlock(base), null);
  assert.match(startBlock({ ...base, running: 2 }) ?? '', /slots are busy/);
  assert.match(startBlock({ ...base, freeMemory: 19 }) ?? '', /only 19% of memory is free/);
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

test('a webhook needs a good Linear-Signature and a webhookTimestamp within 60 s', async () => {
  const body = Buffer.from('{"type":"Issue"}');
  assert.ok(signed('s', body, createHmac('sha256', 's').update(body).digest('hex')));
  assert.ok(!signed('s', body, createHmac('sha256', 'other').update(body).digest('hex')));
  assert.ok(!signed('s', body, undefined));
  const t = setup([issue(1, { delegate: null })]);
  const srv = await t.serve();
  try {
    assert.equal(await srv.post({ type: 'Issue', data: { id: 'id-1' } }), 200);
    assert.equal(await srv.post({ type: 'Issue', data: { id: 'id-1' } }, { secret: 'wrong' }), 401);
    assert.equal(await srv.post({ type: 'Issue', data: { id: 'id-1' } }, { at: Date.now() - 61_000 }), 401);
    assert.equal(t.leads().length, 0, 'a ticket not delegated to the runner is ignored');
  } finally { await srv.close(); }
});

test('a comment webhook on a Decision starts the parent lead with one 👀; a repeat delivery and the backup poll act on it once', async () => {
  const all = [issue(1)];
  const t = setup(all);
  await t.run('--once');
  const decision = issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], createdAt: '2026-01-01T00:00:02Z', history: [] });
  all.push(decision);
  const srv = await t.serve();
  try {
    decision.comments.push({ id: 'c1', body: 'Go with plan B.', createdAt: later(), user: { name: ALEX } });
    const delivery = { type: 'Comment', action: 'create', data: { id: 'c1', issueId: 'id-50' } };
    assert.equal(await srv.post(delivery, { delivery: 'd1' }), 200);
    assert.equal(t.leads().length, 2);
    assert.match(t.leads()[1].input, /ALE-50: Alex Example commented: Go with plan B\./);
    assert.deepEqual(decision.comments[0].reactions, [{ emoji: 'eyes', user: { name: RUNNER } }]);
    const reads = t.ops.length;
    assert.equal(await srv.post(delivery, { delivery: 'd1' }), 200);
    assert.equal(t.ops.length, reads, 'a repeated delivery id makes no Linear call');
    await srv.post(delivery, { delivery: 'd2' });
    await srv.audit();
    assert.equal(t.leads().length, 2);
    assert.equal(decision.comments[0].reactions!.length, 1);
    assert.ok(!t.printed.logs.some((l) => l.startsWith('missed:')));
  } finally { await srv.close(); }
});

test('the backup poll names an event no webhook delivered', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  const srv = await t.serve();
  try {
    job.comments.push({ id: 'c1', body: 'Also the footer.', createdAt: later(), user: { name: ALEX } });
    await srv.audit();
    assert.equal(t.leads().length, 2);
    assert.ok(t.printed.logs.some((l) => /^missed: ALE-1 \S+ ALE-1: Alex Example commented: Also the footer\.$/.test(l)), t.printed.logs.join('\n'));
  } finally { await srv.close(); }
});

test('with no webhook secret the runner polls as before and still puts one 👀 on a comment', async () => {
  const job = issue(1);
  const t = setup([job]);
  assert.equal(t.config.webhookSecretCommand, undefined);
  await t.run('--once');
  job.comments.push({ id: 'c1', body: 'One more thing.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.equal(job.comments.find((c) => c.id === 'c1')!.reactions!.length, 1);
  assert.ok(!t.printed.logs.some((l) => l.startsWith('missed:')));
});

test('auditPoll takes every Nm, every Nh, daily and weekly', () => {
  const now = new Date(2026, 0, 5, 5, 0);
  assert.equal(auditDelay('every 10m', now), 600_000);
  assert.equal(auditDelay('every 1h', now), 3_600_000);
  assert.equal(auditDelay('daily 06:00', now), 3_600_000);
  assert.equal(auditDelay('daily 04:00', now), 23 * 3_600_000);
  assert.throws(() => auditDelay('hourly', now), /Bad auditPoll/);
});

test('a client that sends part of a body and drops the socket does not stop the webhook', async () => {
  const t = setup([issue(1, { delegate: null })]);
  const srv = await t.serve();
  try {
    const { connect } = await import('node:net');
    for (let i = 0; i < 3; i++) {
      const socket = connect(srv.port, '127.0.0.1');
      await new Promise((r) => socket.once('connect', r));
      socket.write('POST /linear HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"type":');
      await new Promise((r) => setTimeout(r, 20));
      socket.destroy();
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await srv.post({ type: 'Issue', data: { id: 'id-1' } }), 200);
  } finally { await srv.close(); }
});

/** Writes the lead's session log with `texts` as user messages, as Pi does once it hands a typed message over. */
function leadLog(agent: string, dir: string, texts: string[]) {
  const id = readFileSync(path.join(dir, '.runner', 'session-id'), 'utf8').trim();
  const folder = path.join(agent, 'sessions', `--${realpathSync(dir).replace(/^\//, '').replace(/[/:]/g, '-')}--`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `2026-01-01T00-00-00-000Z_${id}.jsonl`), texts.map((text) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })).join('\n') + '\n');
}

/** A live lead with a fake pane, a session log folder, and a Decision Alex can comment on. */
async function liveLead() {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job]);
  const agent = path.join(t.root, 'agent');
  process.env.PI_CODING_AGENT_DIR = agent;
  await t.run('--once');
  const decision = issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], title: 'Plan A or B?', createdAt: '2026-01-01T00:00:02Z', history: [] });
  t.addIssue(decision);
  t.setLive('ALE-1');
  decision.comments.push({ id: 'c1', body: 'Go with\nplan B.', url: 'https://linear.app/x/issue/ALE-50#comment-c1', createdAt: later(), user: { name: ALEX } });
  const typed = () => t.tmux().filter((a) => a[0] === 'send-keys');
  const log = (...texts: string[]) => leadLog(agent, t.dirOf(1), texts);
  return { t, job, decision, typed, log };
}
const TYPED = 'Linear event on ALE-1 while you run, on Decision ALE-50 "Plan A or B?": Alex Example commented: Go with plan B. (https://linear.app/x/issue/ALE-50#comment-c1). Read it and act on it; if it answers an open Decision, close that Decision.';

test('a comment while the lead runs is typed into its pane with no Escape, at most once a minute, and once in the lead log never again nor restarts it', async () => {
  const { t, job, decision, typed, log } = await liveLead();
  const srv = await t.serve();
  try {
    const delivery = { type: 'Comment', data: { id: 'c1', issueId: 'id-50' } };
    assert.equal(await srv.post(delivery, { delivery: 'd1' }), 200);
    assert.equal(await srv.post(delivery, { delivery: 'd2' }), 200);
    assert.deepEqual(typed().map((a) => a.at(-1)), [TYPED, 'Enter'], 'typed once, then Enter; no Escape; not retyped within a minute');
    assert.equal(decision.comments[0].reactions!.length, 1, 'the 👀 stays the ack');
    assert.match(job.comments.find((c) => c.body.startsWith('**Runner:**'))!.body, /Passed to the running lead/);
    assert.equal(job.comments.filter((c) => c.user?.name === RUNNER).length, 1, 'no new comment, only the status');
    log(TYPED);
    await srv.audit();
    assert.equal(typed().length, 2);
    t.setLive();
    await srv.audit();
    assert.equal(t.leads().length, 1, 'an event in the lead log does not restart the lead');
    assert.ok(!t.printed.logs.some((l) => l.startsWith('missed:')), t.printed.logs.join('\n'));
  } finally { await srv.close(); delete process.env.PI_CODING_AGENT_DIR; }
});

test('an event swallowed by a dialog, or still queued when the lead exits, stays unanswered and starts the lead', async () => {
  const { t, typed } = await liveLead();
  try {
    await t.run('--once');
    assert.equal(typed().length, 2, 'typed, but the lead log never shows it');
    t.setLive();
    await t.run('--once');
    assert.equal(t.leads().length, 2);
    assert.match(t.leads()[1].input, /ALE-50: Alex Example commented: Go with\nplan B\./);
  } finally { delete process.env.PI_CODING_AGENT_DIR; }
});

test('a lead that logs a typed event and exits before the next poll is not started again for it', async () => {
  const { t, typed, log } = await liveLead();
  try {
    await t.run('--once');
    assert.equal(typed().length, 2);
    log(TYPED);
    t.setLive();
    await t.run('--once');
    assert.equal(t.leads().length, 1, 'the ended lead\'s log shows it was answered');
  } finally { delete process.env.PI_CODING_AGENT_DIR; }
});

test('an event already in the lead log is not typed', async () => {
  const { t, typed, log } = await liveLead();
  try {
    log(TYPED);
    await t.run('--once');
    assert.equal(typed().length, 0);
    t.setLive();
    await t.run('--once');
    assert.equal(t.leads().length, 1);
  } finally { delete process.env.PI_CODING_AGENT_DIR; }
});

test('takeover skips typing; an event with no lead running still starts one', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job]);
  await t.run('--once');
  t.setLive('ALE-1');
  put(path.join(t.dirOf(1), '.runner', 'takeover'), '');
  job.comments.push({ id: 'c1', body: 'Ship it.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  assert.equal(t.tmux().filter((a) => a[0] === 'send-keys').length, 0, 'Alex is at the keyboard');
  t.setLive();
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, /Alex Example commented: Ship it\./);
});

test('with a webhook, the 30 s heartbeat keeps running.json fresh between backup polls', async () => {
  const t = setup([issue(1)]);
  await t.run('--once');
  const srv = await t.serve();
  try {
    t.setLive('ALE-1');
    await srv.audit();
    const file = path.join(t.config.worktreeRoot, 'running.json');
    rmSync(file);
    await srv.heartbeat();
    assert.match(readFileSync(file, 'utf8'), /ALE-1/);
    t.setLive();
    await srv.heartbeat();
    assert.doesNotMatch(readFileSync(file, 'utf8'), /ALE-1/);
  } finally { await srv.close(); }
});

test('the heartbeat finds live leads from tagged tmux sessions, after a restart and when only a webhook read another ticket', async () => {
  const t = setup([issue(1), issue(2, { delegate: null })]);
  await t.run('--once');
  t.setLive('ALE-1');
  t.tag('ALE-1');
  const file = path.join(t.config.worktreeRoot, 'running.json');
  const srv = await t.serve();
  try {
    await srv.heartbeat();
    assert.match(readFileSync(file, 'utf8'), /ALE-1/, 'a fresh runner sees the lead with no poll');
    rmSync(file);
    await srv.post({ type: 'Issue', data: { id: 'id-2' } });
    await srv.heartbeat();
    assert.match(readFileSync(file, 'utf8'), /ALE-1/, 'a webhook pass about another ticket does not drop it');
  } finally { await srv.close(); }
});
