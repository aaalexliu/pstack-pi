import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { format } from 'node:util';
import { createHmac } from 'node:crypto';
import { commands, main, nextMove, put, readState, renderStatus, serve, signed, startBlock, type Config, type Ticket } from './runner.ts';
import { ticket as ticketCommand } from './ticket.ts';

type FakeComment = { id: string; body: string; url?: string; createdAt: string; user: { name: string } | null; botActor?: { name: string } | null; parentId?: string; reactions?: { emoji: string; user: { name: string } }[] };
/** A history entry: who changed what. Linear returns every field the query names, null when unset. */
type FakeChange = { createdAt: string; actor?: { name: string } | null; botActor?: { name: string } | null; attachment?: { sourceType: string }; toState?: { name: string }; toDelegate?: { name: string }; toAssignee?: { name: string }; fromAssignee?: { name: string }; addedLabelIds?: string[]; toTitle?: string };
type FakeIssue = {
  id: string; identifier: string; title: string; description: string; url: string; createdAt: string;
  team: string; project?: string | null; state: string; delegate: string | null; assignee: string | null; parent: string | null; labels: string[]; comments: FakeComment[];
  history: FakeChange[];
};

const RUNNER = 'runner test';
const TYPES: Record<string, string> = { Todo: 'unstarted', 'In Progress': 'started', 'In Review': 'started', Done: 'completed', Canceled: 'canceled', Backlog: 'backlog' };
const ALEX = 'Alex Example';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
const wireComment = (c: FakeComment) => ({ parentId: null, botActor: null, reactions: [], ...c });
const CHANGE = { actor: null, botActor: null, attachment: null, toState: null, toDelegate: null, fromDelegate: null, toAssignee: null, fromAssignee: null, addedLabelIds: null, removedLabelIds: null, toTitle: null, updatedDescription: null };
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
/** The ticket's state file, and a change to it, as the runner writes it. */
const stateOf = (config: Config, n: number) => path.join(config.worktreeRoot, '.state', `ALE-${n}.json`);
const readStateOf = (config: Config, n: number) => JSON.parse(readFileSync(stateOf(config, n), 'utf8'));
const patchState = (config: Config, n: number, patch: Record<string, unknown>) => put(stateOf(config, n), JSON.stringify({ ...readStateOf(config, n), ...patch }));
const IDLE = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Waiting on the reviewer.' }] };
const TOOL_CALL = { role: 'assistant', stopReason: 'toolUse', content: [] };

function issue(n: number, fields: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: `id-${n}`, identifier: `ALE-${n}`, title: `Job number ${n}`, description: 'Make it work.',
    url: `https://linear.app/x/issue/ALE-${n}`, createdAt: `2026-01-0${n}T00:00:00Z`, team: 'ALE', state: 'Todo',
    delegate: RUNNER, assignee: null, parent: null, labels: ['pstack-pi'], comments: [],
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
  // Fake tmux: runs a new session to completion. live.json names a lead that is still running. paths.json keeps the
  // folder each session started in; a session a test made live by hand is in its ticket's usual worktree. Like tmux
  // with no UTF-8 locale, as under launchd, list-sessions prints each control character as `_`.
  writeFileSync(file('tmux'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(file('tmux.log'))}, JSON.stringify(args) + '\\n');
const liveFile = ${JSON.stringify(file('live.json'))};
const tagsFile = ${JSON.stringify(file('tags.json'))};
const pathsFile = ${JSON.stringify(file('paths.json'))};
const paths = fs.existsSync(pathsFile) ? JSON.parse(fs.readFileSync(pathsFile, 'utf8')) : {};
const live = fs.existsSync(liveFile) ? JSON.parse(fs.readFileSync(liveFile, 'utf8')) : [];
const target = args[args.indexOf('-t') + 1]?.replace(/^=|:$/g, '');
if (args[0] === 'new-session') { fs.writeFileSync(pathsFile, JSON.stringify({ ...paths, [args[args.indexOf('-s') + 1]]: args[args.indexOf('-c') + 1] })); if (fs.existsSync(liveFile.replace(/live\.json$/, 'live-on-start'))) fs.writeFileSync(liveFile, JSON.stringify([...live, args[args.indexOf('-s') + 1]])); try { execFileSync('sh', ['-c', args.at(-1)], { cwd: args[args.indexOf('-c') + 1], stdio: 'ignore' }); } catch {} }
else if (args[0] === 'has-session') process.exit(live.includes(target) ? 0 : 1);
else if (args[0] === 'kill-session') { if (!live.includes(target)) process.exit(1); fs.writeFileSync(liveFile, JSON.stringify(live.filter((k) => k !== target))); }
else if (args[0] === 'set-option') { if (!/^=.+:$/.test(args[args.indexOf('-t') + 1] ?? '') || fs.existsSync(tagsFile + '.fail')) { console.error('no such session'); process.exit(1); } const tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, 'utf8')) : {}; fs.writeFileSync(tagsFile, JSON.stringify({ ...tags, [target]: args.at(-1) })); }
else if (args[0] === 'list-sessions') { const tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, 'utf8')) : {}; const fields = { session_name: (k) => k, '@job-runner': (k) => tags[k] ?? '', session_path: (k) => paths[k] ?? ${JSON.stringify(file('worktrees'))} + '/job-' + k.toLowerCase() + '-job-number-' + k.slice(4) }; console.log(live.map((k) => args[args.indexOf('-F') + 1].replace(/#\\{([^}]+)\\}/g, (_, name) => fields[name](k)).replace(/[\\x00-\\x1f]/g, '_')).join('\\n')); }
`, { mode: 0o755 });
  writeFileSync(file('memory_pressure'), `#!/bin/sh\necho "System-wide memory free percentage: $(cat ${JSON.stringify(file('free'))} 2>/dev/null || echo 60)%"\n`, { mode: 0o755 });
  Object.assign(process.env, {
    JOB_RUNNER_PI: file('pi'), JOB_RUNNER_TMUX: file('tmux'), JOB_RUNNER_MEMORY_PRESSURE: file('memory_pressure'),
    PI_SUBAGENT_NAME: 'outer session', PI_X2_TOKEN: 'outer', PSTACK_9: 'outer', CMUX_SURFACE_ID: 'outer', PI_AUTH_PROFILE: 'kept',
  });

  const config: Config = {
    linearTokenCommand: `cat ${file('token')}`, team: 'ALE', runnerUser: RUNNER, askAssignee: ALEX,
    repos: { 'pstack-pi': { path: repo, base: 'main' } },
    models: { lead: 'lead-model', review: 'review-model' }, thinking: 'high', pollSeconds: 0.01, webhookPort: 0, maxLeads: options.maxLeads ?? 2,
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
  writeFileSync(file('token'), 'test-token\n');
  /** Linear lists comments and history newest first, 25 to a page. */
  const paged = (all: (FakeComment | FakeChange)[], after?: string) => {
    const newest = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => ('body' in x ? wireComment(x) : { ...CHANGE, ...x }));
    const from = Number(after ?? 0);
    return { nodes: newest.slice(from, from + 25), pageInfo: { hasNextPage: from + 25 < newest.length, endCursor: String(from + 25) } };
  };
  /** The newest comment matching `keep`, as the list query's filtered `comments(first: 1)` returns it. */
  const newestBy = (x: FakeIssue, keep: (c: FakeComment) => boolean) =>
    ({ nodes: x.comments.filter(keep).map((c) => ({ createdAt: c.createdAt })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1) });
  /** An issue as the list query returns it. Like Linear, a comment does not move `updatedAt`. */
  const listed = (x: FakeIssue) => ({
    ...x, assignee: x.assignee ? { name: x.assignee } : null,
    updatedAt: [x.createdAt, ...x.history.map((h) => h.createdAt)].sort().at(-1),
    comments: { nodes: x.comments.map((c) => ({ createdAt: c.createdAt })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1) },
    asked: newestBy(x, (c) => c.user?.name === RUNNER && c.body.startsWith('**Needs Alex:**')),
    answered: newestBy(x, (c) => c.user?.name === ALEX),
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
    const find = (id: string) => issues.find((i) => i.id === id)!;
    const data = (value: unknown) => Response.json({ data: value });
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
    if (op === 'User') return data({ users: { nodes: v.name === ALEX ? [{ id: 'user-alex' }] : [] } });
    if (op === 'Ticket') {
      const i = find(v.id);
      const newest = [...i.comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return data({ issue: {
        identifier: i.identifier, title: i.title, url: i.url, description: i.description, state: { name: i.state }, assignee: i.assignee ? { name: i.assignee } : null,
        comments: { nodes: newest.slice(0, 50).map((c) => ({ id: c.id, createdAt: c.createdAt, body: c.body, user: c.user, botActor: c.botActor ?? null })), pageInfo: { hasNextPage: newest.length > 50 } },
        children: { nodes: issues.filter((c) => c.parent === i.id).slice(0, 100).map((c) => ({ id: c.id, identifier: c.identifier, title: c.title, state: { name: c.state }, assignee: c.assignee ? { name: c.assignee } : null })) },
      } });
    }
    if (op === 'Label') return data({ issueLabels: { nodes: ['pstack-pi', 'Firstmate', 'Papercut'].includes(v.name) ? [{ id: `label-${v.name}`, team: { key: 'ALE' } }, { id: 'other-team', team: { key: 'OTH' } }] : [] } });
    if (op === 'AddLabel') {
      find(v.id).labels.push(v.label.slice(6));
      find(v.id).history.push({ createdAt: new Date().toISOString(), actor: { name: RUNNER }, addedLabelIds: [v.label] });
      return data({ issueAddLabel: { success: true } });
    }
    if (op === 'Parent') {
      const i = find(v.id);
      const children = issues.filter((c) => c.parent === i.id && c.title === v.title).map((c) => ({ identifier: c.identifier }));
      return data({ issue: { team: { id: `team-${i.team}` }, project: i.project ? { id: i.project } : null, children: { nodes: children.slice(0, 1) } } });
    }
    if (op === 'SubIssue') {
      // Like Linear, a new issue is in the team's default state and gets only the fields the input names.
      const n = issues.length + 100;
      const { teamId, projectId, parentId, title, description, ...rest } = v.input;
      assert.deepEqual(rest, {}, 'no assignee, delegate or other field');
      issues.push(issue(n, { team: teamId.slice(5), project: projectId ?? null, parent: parentId, title, description, state: 'Backlog', delegate: null, labels: [], createdAt: new Date().toISOString(), history: [] }));
      return data({ issueCreate: { success: true, issue: { identifier: `ALE-${n}` } } });
    }
    if (op === 'Update') {
      if (v.input.stateId) find(v.id).state = v.input.stateId.slice(6);
      if ('delegateId' in v.input) find(v.id).delegate = v.input.delegateId;
      const was = find(v.id).assignee;
      if ('assigneeId' in v.input) find(v.id).assignee = v.input.assigneeId === 'user-alex' ? ALEX : null;
      const assignee = !('assigneeId' in v.input) ? {} : v.input.assigneeId ? { toAssignee: { name: ALEX } } : was ? { fromAssignee: { name: was } } : {};
      find(v.id).history.push({ createdAt: new Date().toISOString(), actor: { name: RUNNER }, ...(v.input.stateId ? { toState: { name: v.input.stateId.slice(6) } } : {}), ...assignee });
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
    /** Runs the lead's `ticket` command in `cwd`, a lead's worktree by default, against this fake Linear. */
    ticket: (cwd: string, ...argv: string[]) => ticketCommand(argv, { cwd, config, fetchFn: fakeFetch as typeof fetch, stdin: () => 'From standard input.\n' }),
    leads: () => lines(file('pi.log')).map((line) => JSON.parse(line)),
    tmux: () => lines(file('tmux.log')).map((line) => JSON.parse(line) as string[]),
    /** The asks on a ticket: comments that start with `**Needs Alex:**`. */
    asks: (id = 'id-1') => issues.find((i) => i.id === id)!.comments.filter((c) => c.body.startsWith('**Needs Alex:**')),
    addIssue: (x: FakeIssue) => { issues.push(x); },
    issue: (key: string) => issues.find((i) => i.identifier === key),
    setLive: (...keys: string[]) => writeFileSync(file('live.json'), JSON.stringify(keys)),
    /** Marks sessions as the runner's, as its `set-option @job-runner` does. */
    tag: (...keys: string[]) => writeFileSync(file('tags.json'), JSON.stringify(Object.fromEntries(keys.map((k) => [k, k])))),
    setFreeMemory: (percent: number) => writeFileSync(file('free'), `${percent}\n`),
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
  assert.match(lead.input, /^Issue ALE-1: Job number 1[\s\S]*Linear issue id: id-1\.[\s\S]*Events since your last start:\n- 2026-01-01T00:00:00Z The ticket was filed.\n- 2026-01-01T00:00:01Z ALE-1: Alex Example delegated it to runner test\n\nOther leads running now [^\n]*\n- none$/);
  assert.deepEqual(t.tmux().find((a) => a[0] === 'new-session')!.slice(0, 4), ['new-session', '-d', '-s', 'ALE-1']);
  const status = job.comments.filter((c) => c.body.startsWith('**Runner:**'));
  assert.equal(status.length, 1);
  assert.match(status[0].body, /^\*\*Runner:\*\* Lead running/);
  assert.ok(Date.parse(readStateOf(t.config, 1).seen) > Date.parse('2026-01-02'), 'the one state file records the start');
  assert.ok(!existsSync(path.join(dir, '.runner', 'started')));
});

test('a ticket filed already delegated starts its lead: Linear history has no delegation entry for it', async () => {
  const t = setup([issue(1, { history: [] })]);
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'its creation is the one event, so it starts once');
  assert.match(t.leads()[0].input, /Events since your last start:\n- 2026-01-01T00:00:00Z The ticket was filed\.\n\n/);
  assert.match(t.asks()[0]?.body ?? '', /the lead stopped with nothing handed in/, 'after that run, nothing new means an ask');
});

test('NoSpin: a lead that exits with nothing new is not started again; the runner assigns Alex and asks once instead', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(job.assignee, ALEX);
  assert.equal(t.asks().length, 1, 'one wait, one ask');
  assert.match(t.asks()[0].body, /^\*\*Needs Alex:\*\* the lead stopped with nothing handed in\. /);
});

test('a token command that fails before Pi starts gets an ask naming the step and quoting its stderr, never its output; the next start clears it', async () => {
  const job = issue(1);
  const t = setup([job]);
  const ok = path.join(t.root, 'gh-ok');
  // The helper also echoes two secrets to stderr, from the environment so the command text holds neither, and ends in `;` and a comment.
  process.env.FAKE_GH_SECRET = `ghp_${'a1'.repeat(18)}`;
  process.env.FAKE_CLIENT_SECRET = '0123456789abcdef'.repeat(2);
  // A heredoc with a lone `)` once ended the script's `$(...)` early, before the stderr was blanked.
  t.config.ghTokenCommand = `printf 'gh-%s' secret
test -f ${ok} && exit 0
cat <<EOF >&2
no oauth token found for github.com account aaalexliu
debug: $FAKE_GH_SECRET $FAKE_CLIENT_SECRET in session 4d13c704-8618-4c91-9987-b20e28fdcf6c )
EOF
exit 4; # the token helper`;
  t.printed.expectErrors = true;
  await t.run('--once');
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 0, 'Pi never started');
  const failed = path.join(t.dirOf(1), '.runner', 'start-failed');
  const [ask] = t.asks();
  assert.equal(t.asks().length, 1);
  assert.equal(ask.body.split('\n\n')[0], `**Needs Alex:** lead.sh stopped before Pi started: the GH_TOKEN command \`${t.config.ghTokenCommand.replace(/\s*\n\s*/g, ' ')}\` exited 4. Its stderr is in ${failed}. The ticket is still open and delegated to the runner.`);
  assert.equal(ask.body.split('\n\n')[1], '```text\nno oauth token found for github.com account aaalexliu\ndebug: ghp_[redacted] [redacted] in session 4d13c704-8618-4c91-9987-b20e28fdcf6c )\n```');
  assert.ok(readFileSync(failed, 'utf8').includes('no oauth token found'), 'the stderr stays readable after the pane is gone');
  assert.ok(t.printed.errors.some((e) => e.startsWith('ALE-1: lead.sh stopped before Pi started') && e.includes('no oauth token found')), 'the runner log has it too');
  for (const text of [ask.body, ...t.printed.errors, readFileSync(failed, 'utf8')]) {
    for (const secret of ['gh-secret', process.env.FAKE_GH_SECRET!.slice(4), process.env.FAKE_CLIENT_SECRET!]) assert.ok(!text.includes(secret), 'no token shows');
  }
  assert.deepEqual(readdirSync(path.dirname(failed)).filter((f) => f.includes('stderr')), [], 'the raw stderr is gone');
  writeFileSync(ok, '');
  job.comments.push({ id: 'h1', body: 'Fixed gh, try again.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.leads()[0].ghToken, 'gh-secret');
  assert.ok(!existsSync(failed), 'a start clears the old failure');
  await t.run('--once');
  assert.match(t.asks().at(-1)!.body, /^\*\*Needs Alex:\*\* the lead stopped with nothing handed in\. /, 'a lead that ran gets the usual ask');
});

test('a launch unassigns Alex in the same write that moves the ticket to In Progress; a started ticket is only unassigned', async () => {
  const todo = issue(1, { assignee: ALEX });
  const started = issue(2, { assignee: ALEX, state: 'In Review' });
  const t = setup([todo, started]);
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.deepEqual([todo.state, todo.assignee, started.state, started.assignee], ['In Progress', null, 'In Review', null]);
  const writes = todo.history.filter((h) => h.actor?.name === RUNNER).map((h) => [h.toState?.name, h.fromAssignee?.name]);
  assert.deepEqual(writes, [['In Progress', ALEX]], 'one write');
});

test('ticket ask assigns Alex, then comments; the runner waits and adds no ask; his reply in the ask\'s thread closes it', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  const ask = path.join(t.root, 'ask.md');
  writeFileSync(ask, '**Needs Alex:** Plan A or B?\n\nI recommend A. Pick this if ...\n');
  const before = t.ops.length;
  assert.equal(await t.ticket(t.dirOf(1), 'ask', ask), `Assigned ALE-1 to ${ALEX} and posted the ask.`);
  assert.deepEqual(t.ops.slice(before).filter((op) => op === 'Update' || op === 'Comment'), ['Update', 'Comment'], 'assign first');
  assert.equal(job.assignee, ALEX);
  assert.deepEqual(t.asks().map((c) => [c.body, c.user?.name]), [['**Needs Alex:** Plan A or B?\n\nI recommend A. Pick this if ...\n', RUNNER]]);
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'the lead\'s own ask is no event');
  assert.deepEqual([t.asks().length, job.assignee], [1, ALEX], 'the runner adds no ask of its own');
  job.comments.push({ id: 'h1', body: 'A.', createdAt: later(), user: { name: ALEX }, parentId: t.asks()[0].id });
  t.setLive('ALE-1');
  await t.run('--once');
  assert.equal(job.assignee, null, 'his reply closes the ask, so a live lead holds the ticket');
  assert.match(await t.ticket(t.dirOf(1), 'show'), /\(comment h1\):\nA\./);
  assert.equal(await t.ticket(t.dirOf(1), 'comment', '-', 'h1'), 'Commented on ALE-1 in the thread of h1.');
  assert.equal(job.comments.at(-1)!.parentId, 'h1');
});

test('ticket comment posts as the runner from the worktree or a folder in it, so it never wakes the lead', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  const note = path.join(t.root, 'note.md');
  writeFileSync(note, 'Start note.\n');
  assert.equal(await t.ticket(t.dirOf(1), 'comment', note), 'Commented on ALE-1.');
  assert.equal(await t.ticket(path.join(t.dirOf(1), '.runner'), 'comment', '-'), 'Commented on ALE-1.');
  assert.deepEqual(job.comments.filter((c) => !c.body.startsWith('**Runner:**')).map((c) => [c.body, c.user?.name]), [['Start note.\n', RUNNER], ['From standard input.\n', RUNNER]]);
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'a lead\'s own comment is no event');
});

test('ticket done moves the ticket to Done, or closes one of its sub-issues, and the runner then leaves it alone', async () => {
  const job = issue(1);
  const other = issue(2, { delegate: null });
  const t = setup([job, other]);
  await t.run('--once');
  const asked = issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], createdAt: later(), history: [] });
  t.addIssue(asked);
  assert.equal(await t.ticket(t.dirOf(1), 'done', 'ALE-50'), 'Moved ALE-50 to Done.');
  assert.equal(asked.state, 'Done');
  await assert.rejects(t.ticket(t.dirOf(1), 'done', 'ALE-2'), /ALE-2 is not ALE-1 or one of its sub-issues/);
  assert.equal(other.state, 'Todo', 'never another ticket');
  assert.equal(await t.ticket(t.dirOf(1), 'done'), 'Moved ALE-1 to Done.');
  assert.equal(job.state, 'Done');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.asks().length, 0, 'no ask for a Done ticket');
});

test('ticket sub-issue files one sub-issue in the ticket\'s team and project, neither delegated nor assigned, and a rerun with the same title files none', async () => {
  const job = issue(1, { project: 'project-runner' });
  const t = setup([job]);
  await t.run('--once');
  const plan = path.join(t.root, 'plan.md');
  writeFileSync(plan, 'Goal: add the command.\n\nDone when: its test passes.\n');
  const key = await t.ticket(t.dirOf(1), 'sub-issue', 'Add the sub-issue command', plan);
  assert.match(key, /^ALE-\d+$/);
  const filed = t.issue(key)!;
  assert.deepEqual([filed.parent, filed.team, filed.project, filed.title, filed.description, filed.delegate, filed.assignee],
    ['id-1', 'ALE', 'project-runner', 'Add the sub-issue command', 'Goal: add the command.\n\nDone when: its test passes.\n', null, null]);
  assert.equal(await t.ticket(t.dirOf(1), 'sub-issue', 'Add the sub-issue command', '-'), key, 'a rerun prints the same key');
  assert.match(await t.ticket(t.dirOf(1), 'show'), new RegExp(`\nSub-issues:\n- ${key} \\(Backlog\\): Add the sub-issue command\n\n`), 'one sub-issue');
  const other = await t.ticket(t.dirOf(1), 'sub-issue', 'Say sub-issue in the docs', plan);
  assert.notEqual(other, key);
  for (let n = 0; n < 100; n++) t.addIssue(issue(300 + n, { parent: 'id-1', delegate: null, labels: [], title: `Piece ${n}` }));
  const before = t.ops.length;
  assert.equal(await t.ticket(t.dirOf(1), 'sub-issue', 'Piece 99', plan), 'ALE-399', 'past the first 100 sub-issues too');
  assert.ok(!t.ops.slice(before).includes('SubIssue'), 'files none');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'filing is no event, and a sub-issue gets no lead of its own');
});

test('ticket cancel comments the reason on one of the ticket\'s sub-issues, then cancels it', async () => {
  const job = issue(1);
  const t = setup([job, issue(2, { delegate: null })]);
  await t.run('--once');
  const dropped = issue(50, { parent: 'id-1', delegate: null, labels: [], createdAt: later(), history: [] });
  t.addIssue(dropped);
  const reason = path.join(t.root, 'reason.md');
  writeFileSync(reason, 'Dropped: ALE-51 covers it.\n');
  assert.equal(await t.ticket(t.dirOf(1), 'cancel', 'ALE-50', reason), 'Commented on ALE-50 and moved it to Canceled.');
  assert.deepEqual([dropped.state, dropped.comments.map((c) => [c.body, c.user?.name])], ['Canceled', [['Dropped: ALE-51 covers it.\n', RUNNER]]]);
  for (const key of ['ALE-1', 'ALE-2']) await assert.rejects(t.ticket(t.dirOf(1), 'cancel', key, reason), new RegExp(`${key} is not one of ALE-1's sub-issues`));
  assert.deepEqual([job.state, t.issue('ALE-2')!.state], ['In Progress', 'Todo'], 'never the ticket or another one');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'a lead\'s own cancel is no event');
});

test('ticket show prints the ticket, its sub-issues, and its comments oldest first in local time', async () => {
  const job = issue(1, { state: 'In Progress', comments: [
    { id: 'c2', body: 'Second.', createdAt: '2026-01-02T15:00:00Z', user: { name: ALEX } },
    { id: 'c1', body: 'First.', createdAt: '2026-01-02T14:00:00Z', user: null, botActor: { name: 'GitHub' } },
  ] });
  const t = setup([job]);
  await t.run('--once');
  job.assignee = ALEX;
  t.addIssue(issue(50, { parent: 'id-1', assignee: ALEX, delegate: null, labels: [], title: 'Plan A or B?' }));
  const out = await t.ticket(t.dirOf(1), 'show');
  assert.match(out, /^ALE-1: Job number 1 \(In Progress, assigned to Alex Example\)\nhttps:\/\/linear\.app\/x\/issue\/ALE-1\n\nMake it work\.\n\nSub-issues:\n- ALE-50 \(Todo, Alex Example\): Plan A or B\?\n\nComments, oldest first:\n/);
  const at = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  assert.ok(out.includes(`\nGitHub, ${at('2026-01-02T14:00:00Z')} (comment c1):\nFirst.\n\n${ALEX}, ${at('2026-01-02T15:00:00Z')} (comment c2):\nSecond.\n`), out);
  assert.match(at('2026-01-02T15:00:00Z'), /^Jan 2, \d+:00 [AP]M \S+$/);
});

test('ticket checks its arguments and its file before it calls Linear', async () => {
  const t = setup([issue(1)]);
  await t.run('--once');
  const empty = path.join(t.root, 'empty.md');
  writeFileSync(empty, '\n');
  const before = t.ops.length;
  for (const argv of [[], ['comment'], ['done', 'ALE-50', 'x'], ['ask'], ['ask', 'a', 'b'], ['comment', 'a', 'b', 'c'], ['close'], ['sub-issue', 'Title'], ['sub-issue', ' ', '-'], ['cancel', 'ALE-50']]) {
    await assert.rejects(t.ticket(t.dirOf(1), ...argv), /^Error: usage: ticket show\n/, argv.join(' '));
  }
  await assert.rejects(t.ticket(t.dirOf(1), 'comment', empty), /empty\.md is empty/);
  await assert.rejects(t.ticket(t.dirOf(1), 'ask', empty), /empty\.md is empty/, 'an empty ask assigns no one');
  await assert.rejects(t.ticket(t.dirOf(1), 'sub-issue', 'Title', empty), /empty\.md is empty/);
  await assert.rejects(t.ticket(t.dirOf(1), 'cancel', 'ALE-50', empty), /empty\.md is empty/);
  await assert.rejects(t.ticket(t.root, 'show'), /no \.runner\/work\.json in .* or above it/);
  assert.equal(t.ops.length, before, 'no Linear call');
});

test('the ticket CLI prints usage with exit 64, and an error with exit 1', () => {
  const cli = path.join(import.meta.dirname, 'ticket.ts');
  const run = (...args: string[]) => spawnSync(cli, args, { cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, JOB_RUNNER_CONFIG: '/nonexistent' } });
  const usage = run('ask');
  assert.deepEqual([usage.status, usage.stdout], [64, '']);
  assert.match(usage.stderr, /^usage: ticket show\n/);
  const outside = run('show');
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /^ticket: no \.runner\/work\.json in /);
});

test('a comment by Alex wakes the same lead session once, and the start unassigns him', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  await t.run('--once');
  assert.equal(job.assignee, ALEX);
  job.comments.push({ id: 'h1', body: 'Go with A.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  assert.equal(job.assignee, null, 'the runner unassigned Alex when it started the lead');
  await t.run('--once');
  const leads = t.leads();
  assert.equal(leads.length, 2, 'one wake, no spin after it');
  assert.equal(leads[1].session, leads[0].session);
  assert.match(leads[1].input, /- \S+ ALE-1: Alex Example commented: Go with A\./);
  assert.deepEqual([t.asks().length, job.assignee], [2, ALEX], 'after the woken lead stops, a new ask');
});

test('a ticket assigned to Alex waits; the runner\'s own comments and assignee changes are no events, and his comment starts the lead', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  job.assignee = ALEX;
  job.history.push({ createdAt: later(), actor: { name: RUNNER }, toAssignee: { name: ALEX } });
  job.comments.push({ id: 'r1', body: '**Needs Alex:** A or B?', createdAt: later(), user: { name: RUNNER } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'waits for Alex');
  assert.equal(t.asks().length, 1, 'no second ask');
  job.comments.push({ id: 'h1', body: 'Go with A.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  assert.equal(t.leads().length, 2);
  assert.match(t.leads()[1].input, /- \S+ ALE-1: Alex Example commented: Go with A\./);
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
  assert.equal(t.asks().length, 1);
  const link = Date.now();
  job.history.push(
    { createdAt: new Date(link).toISOString(), botActor: { name: 'Linear' }, attachment: { sourceType: 'github' } },
    { createdAt: new Date(link + 80).toISOString(), actor: { name: ALEX }, toState: { name: 'In Review' } },
  );
  job.state = 'In Review';
  job.comments.push({ id: 'h1', body: 'Go on.', createdAt: new Date(link + 100).toISOString(), user: { name: ALEX } });
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

test('the assignee follows the open ask, not history: a GitHub-link assign under a live lead is undone, and an ask keeps Alex however history reads', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  t.setLive('ALE-1');
  const link = Date.now() + 1000;
  job.history.push(
    { createdAt: new Date(link).toISOString(), botActor: { name: 'Linear' }, attachment: { sourceType: 'github' } },
    { createdAt: new Date(link + 200).toISOString(), actor: { name: ALEX }, toAssignee: { name: ALEX } },
  );
  job.assignee = ALEX;
  await t.run('--once');
  assert.equal(job.assignee, null, 'no open ask and a live lead: the link\'s assign is undone');
  assert.equal(t.leads().length, 1, 'and is no event');
  // Review repro 1: the lead asks, but Linear has written no history for its assign yet.
  job.assignee = ALEX;
  job.comments.push({ id: 'r1', body: '**Needs Alex:** A or B?', createdAt: later(), user: { name: RUNNER } });
  await t.run('--once');
  assert.equal(job.assignee, ALEX, 'an open ask keeps Alex with history lagging');
  // Review repro 2: the runner's own assign lands inside the 2 s after a link entry.
  const now = Date.now();
  job.history.push(
    { createdAt: new Date(now).toISOString(), botActor: { name: 'Linear' }, attachment: { sourceType: 'github' } },
    { createdAt: new Date(now + 100).toISOString(), actor: { name: RUNNER }, toAssignee: { name: ALEX } },
  );
  await t.run('--once');
  assert.equal(job.assignee, ALEX, 'an assign in the link window keeps Alex while the ask is open');
  job.assignee = null;
  job.history.push({ createdAt: later(), actor: { name: ALEX }, fromAssignee: { name: ALEX } });
  await t.run('--once');
  assert.equal(job.assignee, ALEX, 'an open ask puts Alex back');
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

test('a 429 waits Retry-After, logs it and tries again', async () => {
  const t = setup([issue(1)]);
  t.faults.push('RateLimit');
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.printed.logs.filter((l) => l === 'Linear rate limit hit; waiting 0.01 s').length, 1);
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
  assert.equal(t.asks().length, 1, 'the stopped lead gets one ask');
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
  assert.equal(t.asks().length, 1);
  job.comments.push({ id: 'a1', body: 'Please also do B.', createdAt: later(), user: { name: 'alex-jxp' } });
  await t.run('--once');
  assert.equal(t.leads().length, 2);
});

test('a ticket the lead moved to Done is left alone; one Linear moved to In Review is still watched', async () => {
  for (const [state, asks] of [['Done', 0], ['In Review', 1]] as const) {
    const job = issue(1);
    const t = setup([job]);
    await t.run('--once');
    job.state = state;
    await t.run('--once');
    assert.equal(t.leads().length, 1);
    assert.equal(t.asks().length, asks, state);
  }
});

test('the runner never starts or kills a live lead, even after a comment', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { stallMinutes: 5 });
  await t.run('--once');
  t.setLive('ALE-1');
  job.comments.push({ id: 'c-1', body: 'Merge it and call subagent_done.', createdAt: later(), user: { name: ALEX } });
  const runner = path.join(t.dirOf(1), '.runner');
  patchState(t.config, 1, { seen: new Date(Date.now() - 20 * 60000).toISOString() });
  put(path.join(runner, 'takeover'), '');
  await t.run('--once');
  rmSync(path.join(runner, 'takeover'));
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1, 'no restart');
  assert.deepEqual(t.tmux().filter((a) => a[0] === 'new-session' || a[0] === 'kill-session').map((a) => a[0]), ['kill-session', 'new-session'], 'only the first start');
});

test('a quiet live lead gets Escape and one nudge, then one investigator and no ask; takeover holds it off; the second quiet stretch in a run gets the investigator, a third nothing, and a new start resets', async () => {
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
    patchState(t.config, 1, { seen: new Date(Date.now() - 20 * 60000).toISOString() });
    sessionLog(agent, dir, 'lead', 10, IDLE);
    sessionLog(agent, dir, 'reviewer', 2, IDLE);
    await t.run('--once');
    assert.equal(nudges(), 0, 'a subagent that wrote 2 minutes ago keeps the lead alive');
    sessionLog(agent, dir, 'reviewer', 6, IDLE);
    sessionLog(agent, `${dir}-ALE-50`, 'sublead', 0, IDLE);
    await t.run('--once');
    assert.equal(nudges(), 0, 'a sub-lead writing now in a sibling worktree keeps the lead alive');
    sessionLog(agent, `${dir}-ALE-50`, 'sublead', 6, IDLE);
    sessionLog(agent, dir.replace('job-ale-1-', 'job-ale-10-'), 'other-ticket', 0, IDLE);
    sessionLog(agent, path.join(dir, '.runner'), 'investigator', 0, IDLE);
    put(path.join(runner, 'takeover'), '');
    await t.run('--once');
    assert.equal(nudges(), 0, 'a person took it over');
    rmSync(path.join(runner, 'takeover'));
    await t.run('--once');
    await t.run('--once');
    assert.deepEqual(keys(), ['Escape', 'nudge', 'Enter'], 'every log idle for 5 minutes: Escape closes any selector, then one nudge; the investigator log writing now does not count');
    assert.match(t.tmux().find((a) => a.includes('-l'))!.at(-1)!, /No progress from you or your subagents for 6 minutes\. Check each subagent/);
    assert.match(job.comments.find((c) => c.body.startsWith('**Runner:**'))!.body, /nudged it/);
    assert.equal(investigators(), 0, 'the investigator waits another stallMinutes');
    assert.equal(typeof readStateOf(t.config, 1).stall.nudgedAt, 'number', 'the nudge is kept in the state file');
    patchState(t.config, 1, { stall: { nudgedAt: Date.now() - 12 * 60000 } });
    sessionLog(agent, dir, 'lead', 3, IDLE);
    await t.run('--once');
    assert.equal(investigators(), 0, 'the lead answered the nudge 3 minutes ago: not quiet yet');
    sessionLog(agent, dir, 'lead', 6, IDLE);
    await t.run('--once');
    await t.run('--once');
    assert.deepEqual([nudges(), investigators()], [1, 1], 'answered, then idle again: the second stretch starts one investigator, not a second nudge');
    assert.equal(t.asks().length, 0, 'the investigator, not the runner, decides whether Alex must act');
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
    assert.equal(readStateOf(t.config, 1).stall, undefined, 'a new start drops the stall count');
    patchState(t.config, 1, { seen: new Date(Date.now() - 20 * 60000).toISOString() });
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
    patchState(t.config, 1, { seen: new Date(Date.now() - 120 * 60000).toISOString() });
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
  const list = () => JSON.parse(readFileSync(path.join(t.config.worktreeRoot, 'running.json'), 'utf8')) as { key: string; needsScreen: boolean; worktree: string }[];
  await t.run('--once');
  assert.deepEqual(t.leads().map((l) => /Issue (ALE-\d)/.exec(l.input)![1]), ['ALE-1', 'ALE-2', 'ALE-3']);
  assert.deepEqual(list().map((r) => [r.key, r.needsScreen]), [['ALE-1', true], ['ALE-2', true], ['ALE-3', false]]);
  assert.equal(list()[0].worktree, t.dirOf(1));
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

test('a lead that cannot start becomes an ask, not a retry every poll', async () => {
  const job = issue(1);
  const t = setup([job]);
  mkdirSync(t.dirOf(1), { recursive: true });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 0);
  assert.equal(job.assignee, ALEX);
  assert.equal(t.asks().length, 1);
  assert.match(t.asks()[0].body, /could not start the lead: .* is not a worktree/);
});

test('a failed start asks once across polls with no new event, and a new comment retries once', async () => {
  const job = issue(1, { state: 'In Progress', comments: [{ id: 'h1', body: 'Go.', createdAt: later(), user: { name: ALEX } }] });
  const t = setup([job]);
  mkdirSync(t.dirOf(1), { recursive: true });
  for (let i = 0; i < 5; i++) await t.run('--once');
  assert.equal(t.asks().length, 1);
  assert.equal(t.leads().length, 0);
  rmSync(t.dirOf(1), { recursive: true });
  job.comments.push({ id: 'h2', body: 'Try again.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
});

for (const bad of ['{"seen": "2026-', '{"seen":"1"}', '{"seen":1}']) test(`a corrupt state file (${bad}) asks once and starts no lead on its own; Alex's reply starts it, so the ticket is not stranded`, async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job]);
  await t.run('--once');
  job.comments.push({ id: 'c-1', body: 'Also fix the docs.', createdAt: later(), user: { name: ALEX } });
  writeFileSync(stateOf(t.config, 1), bad);
  for (let i = 0; i < 3; i++) await t.run('--once');
  assert.equal(t.leads().length, 1, 'no start while the runner cannot tell which events the lead saw');
  assert.equal(t.asks().length, 1);
  assert.match(t.asks()[0].body, /^\*\*Needs Alex:\*\* the runner lost its state \(\S+ALE-1\.json is corrupt\), so it counts only events from now\./);
  assert.equal(job.assignee, ALEX);
  assert.match(job.comments.find((c) => c.body.startsWith('**Runner:**'))!.body, /^\*\*Runner:\*\* Waiting on Alex/);
  assert.ok(readStateOf(t.config, 1).seen, 'a fresh state replaced it');
  job.comments.push({ id: 'c-2', body: 'Go on.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 2, 'his reply is a new event, so the lead starts once');
  assert.match(t.leads()[1].input, /Events since your last start:\n- \S+ ALE-1: Alex Example commented: Go on\.\n\n/);
});

test('a missing state file where a lead ran asks once and starts no lead on its own', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job]);
  await t.run('--once');
  rmSync(stateOf(t.config, 1));
  job.comments.push({ id: 'c-1', body: 'Go on.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.equal(t.asks().length, 1);
  assert.match(t.asks()[0].body, /the runner lost its state \(\S+ALE-1\.json is missing\), so it counts only events from now\./);
});

test('a corrupt state file under a live lead leaves the lead running; it counts only events from now, so its exit gets the ask', async () => {
  const t = setup([issue(1, { state: 'In Progress' })]);
  await t.run('--once');
  t.setLive('ALE-1');
  t.tag('ALE-1');
  writeFileSync(stateOf(t.config, 1), '[]');
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual(t.tmux().filter((a) => a[0] === 'new-session' || a[0] === 'kill-session').map((a) => a[0]), ['kill-session', 'new-session'], 'only the first start');
  assert.match(readFileSync(path.join(t.config.worktreeRoot, 'running.json'), 'utf8'), /"key": "ALE-1"/, 'the live lead still holds its slot');
  assert.ok(readStateOf(t.config, 1).seen, 'a fresh state replaced it');
  t.setLive();
  await t.run('--once');
  assert.equal(t.leads().length, 1);
  assert.match(t.asks()[0]?.body ?? '', /the lead stopped with nothing handed in/);
});

test('readState reads the start an older runner kept, and rejects a state it cannot trust', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-state-'));
  const config = { worktreeRoot: root } as Config;
  const w = { key: 'ALE-1', dir: path.join(root, 'job-ale-1-x') };
  const runner = path.join(w.dir, '.runner');
  mkdirSync(runner, { recursive: true });
  assert.equal(readState(config, w), null, 'a ticket never started has no state');
  put(path.join(runner, 'started'), '2026-01-01T00:00:00.000Z\n');
  put(path.join(runner, 'session-id'), 'abc');
  assert.deepEqual(readState(config, w), { seen: '2026-01-01T00:00:00.000Z' }, 'an older lead start counts');
  rmSync(path.join(runner, 'started'));
  assert.throws(() => readState(config, w), /ALE-1\.json is missing/);
  mkdirSync(path.join(root, '.state'));
  for (const bad of ['', 'null', '[]', '"x"', '{}', '{"seen":"soon"}', '{"seen":"1"}', '{"seen":1}', '{"seen":"2026-01-01"}', '{"seen":"2026-13-01T00:00:00Z"}', '{"seen":"2026-01-01T00:00:00Z","stall":{"nudgedAt":"x"}}']) {
    put(path.join(root, '.state', 'ALE-1.json'), bad);
    assert.throws(() => readState(config, w), /ALE-1\.json is corrupt/, `${JSON.stringify(bad)} is corrupt`);
  }
  put(path.join(root, '.state', 'ALE-1.json'), '{"seen":"2026-01-02T00:00:00Z","stall":{"nudgedAt":5}}');
  assert.deepEqual(readState(config, w), { seen: '2026-01-02T00:00:00Z', stall: { nudgedAt: 5 } });
  put(path.join(root, '.state', 'ALE-1.json'), JSON.stringify({ seen: '2026-01-02T00:00:00Z', dir: path.join(root, 'job-ale-1') }));
  assert.equal(readState(config, w), null, 'a lead that ran in another folder, such as one with no repo, is not this folder\'s lead');
});

test('a lead running under the old files keeps working: its old start counts, and its next start moves to the state file', async () => {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job], { stallMinutes: 5 });
  const agent = path.join(t.root, 'agent');
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await t.run('--once');
    const runner = path.join(t.dirOf(1), '.runner');
    // As an older runner left a lead it started 20 minutes ago: no state file.
    const started = new Date(Date.now() - 20 * 60000).toISOString();
    rmSync(stateOf(t.config, 1));
    put(path.join(runner, 'started'), started);
    t.setLive('ALE-1');
    await t.run('--once');
    assert.deepEqual(t.tmux().filter((a) => a[0] === 'send-keys').map((a) => a.at(-1)!.slice(0, 20)), ['Escape', 'No progress from you', 'Enter'], 'quiet since its old start: one nudge');
    assert.equal(readStateOf(t.config, 1).seen, started, 'the nudge wrote the old start into the state file');
    assert.equal(t.asks().length, 0);
    // An older lead that exited: only a comment after its start starts it again.
    t.setLive();
    rmSync(stateOf(t.config, 1));
    put(path.join(runner, 'started'), later());
    job.comments.push({ id: 'r-1', body: '**Needs Alex:** A or B?', createdAt: started, user: { name: RUNNER } });
    await t.run('--once');
    assert.equal(t.leads().length, 1, 'nothing since its start: the open ask is waited on');
    job.comments.push({ id: 'c-1', body: 'Go on.', createdAt: later(), user: { name: ALEX } });
    await t.run('--once');
    assert.equal(t.leads().length, 2);
    assert.match(t.leads()[1].input, /Events since your last start:\n- \S+ ALE-1: Alex Example commented: Go on\.\n\n/);
    assert.ok(!existsSync(path.join(runner, 'started')), 'the start dropped the old file');
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test('a refused folder gets no runner files; the failed attempt is kept outside it', async () => {
  const t = setup([issue(1)]);
  mkdirSync(t.dirOf(1), { recursive: true });
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual(readdirSync(t.dirOf(1)), []);
  assert.ok(readStateOf(t.config, 1).seen, 'the attempt is in the state file under worktreeRoot');
  assert.equal(t.asks().length, 1);
});

test('a worktree on the lead PR branch starts the lead', async () => {
  const t = setup([issue(1)]);
  git(t.repo, 'worktree', 'add', '-q', '-b', 'job/ale-1-pr-branch', t.dirOf(1), 'origin/main');
  await t.run('--once');
  assert.equal(t.asks().length, 0);
  assert.equal(t.leads().length, 1);
});

test('the runner\'s own ask assigns Alex before it comments; a failed assign posts nothing, and the ask is never posted twice', async () => {
  const job = issue(1);
  const t = setup([job]);
  t.printed.expectErrors = true;
  await t.run('--once');
  t.faults.push('Update');
  await t.run('--once');
  assert.deepEqual([job.assignee, t.asks().length], [null, 0], 'the assign failed, so no comment');
  const before = t.ops.length;
  await t.run('--once');
  const ops = t.ops.slice(before);
  assert.ok(ops.indexOf('Update') < ops.indexOf('Comment'), ops.join(' '));
  assert.deepEqual([job.assignee, t.asks().length], [ALEX, 1]);
  await t.run('--once');
  await t.run('--once');
  assert.equal(t.asks().length, 1, 'an assigned ticket waits');
  assert.deepEqual(t.errorLines(), ['ALE-1: failed; the next poll tries again Error: injected Update failure']);
});

test('a ticket with no repo label starts a lead in a folder with no repo, keeps its delegate, and gets only the status comment', async () => {
  const job = issue(1, { labels: ['Papercut'] });
  const t = setup([job]);
  await t.run('--once');
  assert.equal(job.delegate, RUNNER, 'the runner keeps the ticket');
  assert.deepEqual(job.comments.map((c) => c.body.split('\n')[0]), ['**Runner:** Lead running']);
  assert.equal(job.state, 'In Progress');
  const neutral = path.join(t.config.worktreeRoot, 'job-ale-1');
  const [lead] = t.leads();
  assert.equal(lead.cwd, realpathSync(neutral));
  assert.ok(!existsSync(path.join(neutral, '.git')), 'the folder is no worktree of any repo');
  assert.match(lead.input, /\nNo repo label yet, so you run in a folder with no repo\. Repo labels: pstack-pi\. Review model: review-model\./);
  assert.match(job.comments[0].body, /- Folder: `[^`]*job-ale-1`, with no repo until the lead adds a repo label\n/);
});

test('once the no-repo lead adds the repo label and exits, the next poll starts a lead in that repo\'s worktree with no new delegation', async () => {
  const job = issue(1, { labels: [] });
  const t = setup([job]);
  await t.run('--once');
  const neutral = path.join(t.config.worktreeRoot, 'job-ale-1');
  await assert.rejects(t.ticket(neutral, 'label', 'Firstmate'), /"Firstmate" names no repo in the runner config; the repo labels are pstack-pi/);
  assert.equal(await t.ticket(neutral, 'label', 'pstack-pi'), 'Labeled ALE-1 pstack-pi.');
  assert.deepEqual(job.labels, ['pstack-pi']);
  await t.run('--once');
  const [, lead] = t.leads();
  assert.equal(lead?.cwd, realpathSync(t.dirOf(1)), 'the second lead runs in the repo worktree');
  assert.equal(git(t.dirOf(1), 'rev-parse', '--abbrev-ref', 'HEAD'), 'job/ale-1-job-number-1');
  assert.match(lead.input, /\nBranch: job\/ale-1-job-number-1\. Base: main\. Review model: review-model\./);
  assert.match(lead.input, /Events since your last start:\n- 2026-01-01T00:00:00Z The ticket was filed\.\n- 2026-01-01T00:00:01Z ALE-1: Alex Example delegated it to runner test\n\n/);
  assert.notEqual(lead.session, t.leads()[0].session, 'a fresh session in the worktree');
  assert.equal(t.asks().length, 0);
  assert.match(job.comments.find((c) => c.body.startsWith('**Runner:**'))!.body, /- Worktree: `[^`]*job-ale-1-job-number-1` on `job\/ale-1-job-number-1`/);
  job.comments.push({ id: 'c1', body: 'One more thing.', createdAt: later(), user: { name: ALEX } });
  await t.run('--once');
  assert.equal(t.leads()[2]?.cwd, realpathSync(t.dirOf(1)), 'later starts stay in the repo worktree');
});

test('a no-repo lead follows the same assignee rules: its start unassigns Alex, and its stop assigns him with one ask', async () => {
  const job = issue(1, { labels: [], assignee: ALEX });
  const t = setup([job]);
  await t.run('--once');
  assert.deepEqual([t.leads().length, job.assignee], [1, null]);
  await t.run('--once');
  await t.run('--once');
  assert.deepEqual([job.assignee, t.asks().length], [ALEX, 1]);
});

test('the heartbeat finds a no-repo lead in its folder', async () => {
  const t = setup([issue(1, { labels: [] })]);
  await t.run('--once');
  t.setLive('ALE-1');
  t.tag('ALE-1');
  const srv = await t.serve();
  try {
    await srv.heartbeat();
    const [entry] = JSON.parse(readFileSync(path.join(t.config.worktreeRoot, 'running.json'), 'utf8'));
    assert.equal(entry.worktree, path.join(t.config.worktreeRoot, 'job-ale-1'));
  } finally { await srv.close(); }
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

const ticket = (fields: Partial<Ticket>): Ticket => ({ state: 'started', assignee: null, asking: false, description: '', createdAt: '2026-01-01T00:00:00Z', mine: [], children: [], events: [], ...fields });

test('nextMove follows the model: start on an event, else wait on an open ask, else ask', () => {
  const started = '2026-01-02T00:00:00Z';
  const event = { at: '2026-01-03T00:00:00Z', what: 'ALE-1: Alex Example commented: go with A' };
  assert.equal(nextMove(ticket({}), started).kind, 'ask');
  assert.equal(nextMove(ticket({ events: [{ ...event, at: '2026-01-01T00:00:00Z' }] }), started).kind, 'ask', 'an event before the start is seen');
  assert.deepEqual(nextMove(ticket({ asking: true, events: [event] }), started), { kind: 'start', events: [event] }, 'an event may answer the ask');
  assert.equal(nextMove(ticket({ asking: true }), started).kind, 'wait');
  assert.equal(nextMove(ticket({ assignee: ALEX }), started).kind, 'ask', 'an assignee alone is no open ask');
  assert.equal(nextMove(ticket({ asking: true, events: [event] }), '2026-01-04T00:00:00Z').kind, 'wait', 'a failed attempt after the event has seen it');
  assert.deepEqual(nextMove(ticket({ description: 'Do it.\n\nrunner-routine audit 2026-01-01T09:00:00.000Z' }), null), { kind: 'start', events: [{ at: '2026-01-01T00:00:00Z', what: 'A routine filed this ticket.' }] }, 'a routine ticket starts on its creation');
  assert.deepEqual(nextMove(ticket({}), null), { kind: 'start', events: [{ at: '2026-01-01T00:00:00Z', what: 'The ticket was filed.' }] }, 'a ticket never started starts on its creation');
  assert.equal(nextMove(ticket({}), started).kind, 'ask', 'its creation counts once');
});

const shells = ['sh', 'zsh'].filter((shell) => { try { execFileSync(shell, ['-c', 'true']); return true; } catch { return false; } });
for (const shell of ['sh', 'zsh']) {
  test(`status commands survive a worktree path with spaces and an apostrophe when the remote shell is ${shell}`, { skip: !shells.includes(shell) && `${shell} is not installed` }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'job-runner-quote-'));
    const dir = path.join(root, 'Work Projects', "it's", 'job-ale-7-x');
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, '.runner'));
    const fakes = path.join(root, 'bin');
    mkdirSync(fakes);
    writeFileSync(path.join(fakes, 'ssh'), `#!/bin/sh\nshift 2\nexec ${shell} -c "$*"\n`, { mode: 0o755 });
    writeFileSync(path.join(fakes, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(root, 'tmux-args'))}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${fakes}:${process.env.PATH}` };
    const tmuxArgs = () => readFileSync(path.join(root, 'tmux-args'), 'utf8').trim().split('\n');
    const c = commands({ key: 'ALE-7', dir }, 'mini');
    execFileSync('sh', ['-c', c.watch], { env });
    assert.deepEqual(tmuxArgs(), ['attach', '-t', '=ALE-7']);
    execFileSync('sh', ['-c', c.stop], { env });
    assert.deepEqual(tmuxArgs(), ['kill-session', '-t', '=ALE-7']);
    execFileSync('sh', ['-c', c.takeOver], { env });
    assert.ok(existsSync(path.join(dir, '.runner', 'takeover')));
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

test('a comment webhook on a sub-issue starts the parent lead with one 👀; a repeat delivery and the backup poll act on it once', async () => {
  const all = [issue(1)];
  const t = setup(all);
  await t.run('--once');
  const sub = issue(50, { parent: 'id-1', delegate: null, labels: [], createdAt: '2026-01-01T00:00:02Z', history: [] });
  all.push(sub);
  const srv = await t.serve();
  try {
    sub.comments.push({ id: 'c1', body: 'Go with plan B.', createdAt: later(), user: { name: ALEX } });
    const delivery = { type: 'Comment', action: 'create', data: { id: 'c1', issueId: 'id-50' } };
    assert.equal(await srv.post(delivery, { delivery: 'd1' }), 200);
    assert.equal(t.leads().length, 2);
    assert.match(t.leads()[1].input, /ALE-50: Alex Example commented: Go with plan B\./);
    assert.deepEqual(sub.comments[0].reactions, [{ emoji: 'eyes', user: { name: RUNNER } }]);
    assert.equal(await srv.post(delivery, { delivery: 'd1' }), 200, 'Linear retries a delivery under the same id; the pass runs again and changes nothing');
    await srv.post(delivery, { delivery: 'd2' });
    await srv.audit();
    assert.equal(t.leads().length, 2);
    assert.equal(sub.comments[0].reactions!.length, 1);
    assert.ok(!t.printed.logs.some((l) => l.startsWith('missed:')));
  } finally { await srv.close(); }
});

test('with a webhook, the heartbeat sees a lead exit without finishing or asking: Alex is assigned and gets one comment, never a second', async () => {
  const job = issue(1);
  const t = setup([job]);
  await t.run('--once');
  const srv = await t.serve();
  try {
    await srv.heartbeat();
    assert.deepEqual([job.assignee, t.asks().length], [ALEX, 1], 'within one heartbeat, not the backup poll');
    assert.match(t.asks()[0].body, /the lead stopped with nothing handed in[\s\S]*your comment starts the lead again/);
    await srv.heartbeat();
    await srv.audit();
    assert.equal(t.asks().length, 1, 'no second comment on the next pass');
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

/** A live lead with a fake pane, a session log folder, and a sub-issue Alex can comment on. */
async function liveLead() {
  const job = issue(1, { state: 'In Progress' });
  const t = setup([job]);
  const agent = path.join(t.root, 'agent');
  process.env.PI_CODING_AGENT_DIR = agent;
  await t.run('--once');
  const sub = issue(50, { parent: 'id-1', delegate: null, labels: [], title: 'Plan A or B?', createdAt: '2026-01-01T00:00:02Z', history: [] });
  t.addIssue(sub);
  t.setLive('ALE-1');
  sub.comments.push({ id: 'c1', body: 'Go with\nplan B.', url: 'https://linear.app/x/issue/ALE-50#comment-c1', createdAt: later(), user: { name: ALEX } });
  const typed = () => t.tmux().filter((a) => a[0] === 'send-keys');
  const log = (...texts: string[]) => leadLog(agent, t.dirOf(1), texts);
  return { t, job, sub, typed, log };
}
const TYPED = 'Linear event on ALE-1 while you run, on sub-issue ALE-50 "Plan A or B?": Alex Example commented: Go with plan B. (https://linear.app/x/issue/ALE-50#comment-c1). Read it and act on it.';

test('a comment while the lead runs is typed into its pane with no Escape, at most once a minute, and once in the lead log never again nor restarts it', async () => {
  const { t, job, sub, typed, log } = await liveLead();
  const srv = await t.serve();
  try {
    const delivery = { type: 'Comment', data: { id: 'c1', issueId: 'id-50' } };
    assert.equal(await srv.post(delivery, { delivery: 'd1' }), 200);
    assert.equal(await srv.post(delivery, { delivery: 'd2' }), 200);
    assert.deepEqual(typed().map((a) => a.at(-1)), [TYPED, 'Enter'], 'typed once, then Enter; no Escape; not retyped within a minute');
    assert.equal(sub.comments[0].reactions!.length, 1, 'the 👀 stays the ack');
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
