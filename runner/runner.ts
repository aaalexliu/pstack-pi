import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Repo = { path: string; base: string };
export type Config = {
  linearTokenCommand: string;
  team: string;
  runnerUser: string;
  decisionAssignee: string;
  repos: Record<string, Repo>;
  models: { lead: string; review: string };
  thinking: string;
  pollSeconds: number;
  maxLeads: number;
  minFreeMemoryPercent: number;
  stallMinutes: number;
  host: string;
  worktreeRoot: string;
};
type Comment = { id: string; body: string; createdAt: string; user: { name: string } | null };
type Issue = { id: string; identifier: string; title: string; description: string | null; url: string; createdAt: string; state: { type: string }; labels: { nodes: { name: string }[] } };
/** A sub-issue of a ticket. One assigned to `decisionAssignee` is a Decision issue: Alex owes a move on it. */
export type Child = { id: string; identifier: string; title: string; url: string; createdAt: string; completedAt: string | null; canceledAt: string | null; assignee: { name: string } | null };
/** What Linear says about a ticket this poll. `state` is the state type: `unstarted` for Todo, `started` for In Progress or In Review. */
export type Ticket = { state: string; delegate: string | null; comments: Comment[]; children: Child[] };
/** A ticket as the runner sees it this poll. */
export type Work = { id: string; key: string; title: string; url: string; description: string; repo: string; branch: string; dir: string; models: { lead: string; review: string } };
type Ctx = { config: Config; linear: ReturnType<typeof linearClient> };
/** The runner's move for an idle ticket. It mirrors `model/Ticket.tla`: wait, start the lead, or file a Decision issue. */
export type Move = { kind: 'wait'; on: Child } | { kind: 'start'; news: string[] } | { kind: 'decide' };

const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));
const AUTO_EXIT = fileURLToPath(new URL('../extensions/interactive-subagents/pi-extension/subagents/subagent-done.ts', import.meta.url));
const ISSUE_FIELDS = 'id identifier title description url createdAt state { type } labels { nodes { name } }';
/** Pi variables a lead keeps from the runner's environment. Every other `PI_*` and `PSTACK_*` belongs to another session. */
const KEEP_ENV = ['PI_AUTH_PROFILE', 'PI_CODING_AGENT_DIR'];
const bin = (name: 'pi' | 'tmux' | 'memory_pressure') => process.env[`JOB_RUNNER_${name.toUpperCase()}`] ?? name;
/**
 * Quotes one shell word. Plain words stay bare and simple ones get double quotes, so the status commands stay
 * readable. A word that starts with `=` is always quoted: zsh expands `=word` to a command path.
 */
export const sh = (value: string) =>
  /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(value) ? value : /^[^"$`\\!]*$/.test(value) ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;
/** tmux matches `-t ALE-1` to `ALE-10` by prefix when `ALE-1` is gone. `=` asks for the exact name. */
const session = (key: string) => `=${key}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function loadConfig(file: string): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['linearTokenCommand', 'team', 'runnerUser', 'decisionAssignee', 'repos', 'models', 'worktreeRoot']) {
    if (!raw[key]) throw new Error(`${file}: missing "${key}"`);
  }
  if (!raw.models.lead || !raw.models.review) throw new Error(`${file}: "models" needs "lead" and "review"`);
  return { thinking: 'high', pollSeconds: 30, maxLeads: 2, minFreeMemoryPercent: 20, stallMinutes: 30, host: os.hostname().replace(/\.local$/, ''), ...raw };
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

const tail = (text: string, lines: number) => text.trimEnd().split('\n').slice(-lines).join('\n');

async function must(cmd: string, args: string[], cwd: string): Promise<string> {
  const { code, out } = await run(cmd, args, cwd);
  if (code !== 0) throw new Error(`${path.basename(cmd)} ${args[0]} exited ${code}:\n${tail(out, 20)}`);
  return out.trim();
}

/** Writes a file whole or not at all: temp file, flush, rename. */
export function put(file: string, content: string) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w');
  try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
}
const readOr = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

function linearClient(config: Config, fetchFn: typeof fetch) {
  let decisionIds: { team: string; assignee: string } | undefined;
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await must('/bin/sh', ['-c', config.linearTokenCommand], process.cwd());
    const res = await fetchFn('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: unknown };
    if (!res.ok || body.errors || !body.data) throw new Error(`Linear ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
    return body.data;
  }
  const CHILD = 'id identifier title url createdAt completedAt canceledAt assignee { name }';
  return {
    /**
     * Open tickets delegated to the runner: Todo (unstarted) and any started state, such as In Progress or the
     * In Review that Linear's GitHub link sets when a PR opens. Started ones come first, so they keep their slots.
     */
    async issues(): Promise<Issue[]> {
      const data = await gql<{ issues: { nodes: Issue[] } }>(
        `query Issues($team: String!, $user: String!) { issues(first: 100, filter: { team: { key: { eq: $team } }, state: { type: { in: ["unstarted", "started"] } }, delegate: { name: { eq: $user } } }) { nodes { ${ISSUE_FIELDS} } } }`,
        { team: config.team, user: config.runnerUser },
      );
      return data.issues.nodes.sort((a, b) => b.state.type.localeCompare(a.state.type) || a.createdAt.localeCompare(b.createdAt));
    },
    /** The ticket's state, comments and sub-issues in one read, or null when no issue has that id. */
    async ticket(id: string): Promise<Ticket | null> {
      type Wire = { state: { type: string }; delegate: { name: string } | null; comments: { nodes: Comment[] }; children: { nodes: Child[] } };
      const found = (await gql<{ issues: { nodes: Wire[] } }>(
        `query IssueById($id: ID!) { issues(first: 1, filter: { id: { eq: $id } }) { nodes { state { type } delegate { name } comments(first: 100) { nodes { id body createdAt user { name } } } children(first: 50) { nodes { ${CHILD} } } } } }`,
        { id },
      )).issues.nodes[0];
      if (!found) return null;
      return {
        state: found.state.type, delegate: found.delegate?.name ?? null,
        comments: found.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), children: found.children.nodes,
      };
    },
    async setState(id: string, state: string) {
      const { workflowStates } = await gql<{ workflowStates: { nodes: { id: string }[] } }>(
        'query State($team: String!, $name: String!) { workflowStates(filter: { team: { key: { eq: $team } }, name: { eq: $name } }) { nodes { id } } }',
        { team: config.team, name: state },
      );
      await gql('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input: { stateId: workflowStates.nodes[0]?.id } });
    },
    async clearDelegate(id: string) {
      await gql('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input: { delegateId: null } });
    },
    async comment(issueId: string, body: string) {
      await gql('mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body } });
    },
    async editComment(id: string, body: string) {
      await gql('mutation EditComment($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', { id, input: { body } });
    },
    /** Files a Decision issue as a sub-issue of the ticket, in one write, so no crash can leave it unfindable. */
    async fileDecision(parentId: string, title: string, description: string): Promise<{ identifier: string; url: string }> {
      if (!decisionIds) {
        const team = await gql<{ teams: { nodes: { id: string }[] } }>('query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: config.team });
        const user = await gql<{ users: { nodes: { id: string }[] } }>('query User($name: String!) { users(filter: { name: { eq: $name } }) { nodes { id } } }', { name: config.decisionAssignee });
        if (!team.teams.nodes[0] || !user.users.nodes[0]) throw new Error(`Linear has no team ${config.team} or no user ${config.decisionAssignee}`);
        decisionIds = { team: team.teams.nodes[0].id, assignee: user.users.nodes[0].id };
      }
      return (await gql<{ issueCreate: { issue: { identifier: string; url: string } } }>(
        'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }',
        { input: { teamId: decisionIds.team, assigneeId: decisionIds.assignee, parentId, title, description } },
      )).issueCreate.issue;
    },
  };
}

/** The commands Alex copies from the status comment. Each word is quoted for the local shell and again for the remote one. */
export function commands(w: Pick<Work, 'key' | 'dir' | 'branch'>, sessionId: string, host: string) {
  const ssh = (...remote: string[]) => `ssh -t ${sh(host)} ${sh(remote.join(' '))}`;
  const quiz = `${w.dir}-quiz`;
  return {
    watch: ssh('tmux attach -t', sh(session(w.key))),
    takeOver: ssh('touch', sh(path.join(w.dir, '.runner', 'takeover')), '&& tmux attach -t', sh(session(w.key))),
    quiz: ssh('cd', sh(w.dir), '&& git worktree add -B', sh(`${w.branch}-quiz`), sh(quiz), 'HEAD && cd', sh(quiz), '&& tmux new -s', sh(`${w.key}-quiz`), 'pi --fork', sh(sessionId)),
    stop: ssh('tmux kill-session -t', sh(session(w.key))),
  };
}

export function renderStatus(w: Pick<Work, 'key' | 'dir' | 'branch'>, sessionId: string, host: string, state: string) {
  const c = commands(w, sessionId, host);
  return [
    `**Runner:** ${state}`,
    '',
    `- Host: ${host}`,
    `- tmux session: \`${w.key}\``,
    `- Session id: \`${sessionId}\``,
    `- Worktree: \`${w.dir}\` on \`${w.branch}\``,
    `- Watch or steer: \`${c.watch}\``,
    `- Take over (auto-exit stays off until you quit Pi): \`${c.takeOver}\``,
    `- Quiz a fork: \`${c.quiz}\``,
  ].join('\n');
}

/** Why a lead cannot start now, or null. `freeMemory` is the percentage macOS `memory_pressure -Q` reports as free. */
export function startBlock(o: { running: number; maxLeads: number; freeMemory: number; minFreeMemory: number; needsScreen: boolean; screenTaken: boolean }): string | null {
  if (o.running >= o.maxLeads) return `all ${o.maxLeads} lead slots are busy`;
  if (o.freeMemory < o.minFreeMemory) return `only ${o.freeMemory}% of memory is free, under the ${o.minFreeMemory}% floor`;
  if (o.needsScreen && o.screenTaken) return 'another running ticket has the screen';
  return null;
}

export const needsScreen = (description: string) => /^Needs:\s*screen\s*$/im.test(description);

const rf = (w: Pick<Work, 'dir'>, name: string) => path.join(w.dir, '.runner', name);
const sessionId = (w: Work) => readOr(rf(w, 'session-id'))?.trim() ?? '';
/** The one fact the runner keeps per ticket: when it last started the lead. */
export const lastStart = (w: Pick<Work, 'dir'>) => readOr(rf(w, 'started'))?.trim() || null;
const isDecision = (config: Config, c: Child) => c.assignee?.name === config.decisionAssignee;
const closedAt = (c: Child) => c.completedAt ?? c.canceledAt;

/**
 * The runner's move for a ticket whose lead is not running, from Linear and the last start time alone.
 * News is anything Alex did after that start: delegated the ticket (it sits in Todo), closed a Decision issue, or commented.
 */
export function nextMove(config: Config, ticket: Ticket, started: string | null): Move {
  const open = ticket.children.find((c) => isDecision(config, c) && !closedAt(c));
  if (open) return { kind: 'wait', on: open };
  const after = (at: string) => started === null || at > started;
  const news = [
    ...(started === null || ticket.state === 'unstarted' ? ['The ticket was delegated to you.'] : []),
    ...ticket.children.filter((c) => isDecision(config, c) && after(closedAt(c)!))
      .map((c) => `Alex ${c.completedAt ? 'closed' : 'canceled'} ${c.identifier} (${c.title}): ${c.url}`),
    ...ticket.comments.filter((c) => c.user?.name !== config.runnerUser && after(c.createdAt))
      .map((c) => `${c.user?.name ?? 'Someone'} commented: ${c.body}`),
  ];
  return news.length ? { kind: 'start', news } : { kind: 'decide' };
}

const repoLocks = new Map<string, Promise<unknown>>();
/** Runs git setup for one repo at a time: two leads starting together would fight over `.git/config.lock`. */
function worktree(repo: Repo, w: Work) {
  const next = (repoLocks.get(repo.path) ?? Promise.resolve()).catch(() => {}).then(() => makeWorktree(repo, w));
  repoLocks.set(repo.path, next);
  return next;
}

/** Reuses the ticket's worktree or branch when they exist. It never removes a worktree or resets a branch. */
async function makeWorktree(repo: Repo, w: Work) {
  if (existsSync(w.dir)) {
    const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], w.dir);
    if (head.code !== 0 || head.out.trim() !== w.branch) throw new Error(`${w.dir} exists but is not a worktree on ${w.branch}, so the runner left it alone.`);
  } else {
    await must('git', ['fetch', 'origin', repo.base], repo.path);
    await must('git', ['worktree', 'prune'], repo.path);
    mkdirSync(path.dirname(w.dir), { recursive: true });
    const known = (await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`], repo.path)).code === 0;
    await must('git', ['worktree', 'add', ...(known ? [w.dir, w.branch] : ['-b', w.branch, w.dir, `origin/${repo.base}`])], repo.path);
  }
  const exclude = path.join(path.resolve(w.dir, await must('git', ['rev-parse', '--git-common-dir'], w.dir)), 'info', 'exclude');
  if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes('.runner/')) {
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, '\n.runner/\n');
  }
  mkdirSync(path.join(w.dir, '.runner'), { recursive: true });
}

/** Edits the ticket's one status comment, or posts it if Linear has none yet. */
async function status(ctx: Ctx, w: Work, ticket: Ticket, state: string) {
  const body = renderStatus(w, sessionId(w), ctx.config.host, state);
  const mine = ticket.comments.find((c) => c.user?.name === ctx.config.runnerUser && c.body.startsWith('**Runner:**'));
  if (mine) await ctx.linear.editComment(mine.id, body);
  else await ctx.linear.comment(w.id, body);
}

/** The first message of each lead start: the ticket, the facts it needs to reach Linear, and what Alex did since. */
function startMessage(ctx: Ctx, w: Work, news: string[]) {
  return [
    `Issue ${w.key}: ${w.title}`,
    w.url,
    '',
    w.description,
    '',
    `Linear issue id: ${w.id}. Team: ${ctx.config.team}. File Decision issues as sub-issues assigned to ${ctx.config.decisionAssignee}.`,
    `Branch: ${w.branch}. Base: ${ctx.config.repos[w.repo].base}. Review model: ${w.models.review}. Prompts: ${PROMPTS}.`,
    '',
    'Since your last start:',
    ...news.map((line) => `- ${line}`),
  ].join('\n');
}

/**
 * Starts or resumes the lead in a detached tmux session named for the ticket, and saves the start time.
 * Pi exits when its turn ends (auto-exit). The launch script drops every Pi variable the tmux server holds from
 * another session, and reads the Linear token itself, so the token never lands on disk.
 */
async function launch(ctx: Ctx, w: Work, news: string[]) {
  await worktree(ctx.config.repos[w.repo], w);
  if (!sessionId(w)) put(rf(w, 'session-id'), randomUUID());
  put(rf(w, 'input.md'), startMessage(ctx, w, news));
  for (const file of ['takeover', 'held']) rmSync(rf(w, file), { force: true });
  // The lead gets no subagent tools, so its reviewer is a `pi -p` with a real session id and file. In a real run a
  // lead used background subagents, which auto-exit killed, then blocking_subagent, whose reviewer had no session id.
  const pi = (...extra: string[]) => [bin('pi'), '--session-id', sessionId(w), '-e', AUTO_EXIT, '--exclude-tools', 'subagent,subagent_resume,blocking_subagent',
    '--model', w.models.lead, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, 'lead.md'), ...extra].map(sh).join(' ');
  const keep = KEEP_ENV.filter((name) => process.env[name]).map((name) => `export ${name}=${sh(process.env[name]!)}`);
  put(rf(w, 'lead.sh'), [
    '#!/bin/sh',
    `cd ${sh(w.dir)} || exit 1`,
    `export PATH=${sh(process.env.PATH ?? '')}`,
    '# The tmux server keeps the environment of whoever started it. Drop Pi variables from another session.',
    "for v in $(env | sed -n 's/^\\(PI_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(PSTACK_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset \"$v\"; done",
    ...keep,
    `LINEAR_TOKEN=$(${ctx.config.linearTokenCommand}) || exit 1`,
    'export LINEAR_TOKEN',
    `PI_SUBAGENT_AUTO_EXIT=1 PI_SUBAGENT_ID=${sh(w.key)} PI_SUBAGENT_ACTIVITY_FILE=${sh(rf(w, 'activity.json'))} ${pi(`@${rf(w, 'input.md')}`)}`,
    '# A person who touched .runner/takeover keeps the session, without auto-exit, until they quit Pi.',
    `if [ -f .runner/takeover ]; then mv .runner/takeover .runner/held; ${pi()}; rm -f .runner/held; fi`,
    '',
  ].join('\n'));
  put(rf(w, 'started'), new Date().toISOString());
  await run(bin('tmux'), ['kill-session', '-t', session(w.key)], w.dir);
  await must(bin('tmux'), ['new-session', '-d', '-s', w.key, '-x', '200', '-y', '50', '-c', w.dir, `sh ${sh(rf(w, 'lead.sh'))}`], w.dir);
}

const live = async (w: Pick<Work, 'key'>) => (await run(bin('tmux'), ['has-session', '-t', session(w.key)], process.cwd())).code === 0;

/** Minutes since the lead last did anything, from its activity file, or since it started. */
export function quietMinutes(w: Pick<Work, 'dir'>, now = Date.now()) {
  const started = lastStart(w);
  let last = started ? Date.parse(started) : 0;
  try { last = Math.max(last, JSON.parse(readFileSync(rf(w, 'activity.json'), 'utf8')).updatedAt ?? 0); } catch { /* no activity yet */ }
  return last ? Math.floor((now - last) / 60000) : 0;
}

/**
 * Files a Decision issue for a live lead quiet for `stallMinutes`, unless one was filed since it went quiet.
 * It does not stop the lead.
 */
async function checkStall(ctx: Ctx, w: Work, ticket: Ticket) {
  if (existsSync(rf(w, 'held'))) return;
  const quiet = quietMinutes(w);
  if (quiet < ctx.config.stallMinutes) return;
  const quietSince = new Date(Date.now() - quiet * 60000 - 60000).toISOString();
  if (ticket.children.some((c) => isDecision(ctx.config, c) && c.createdAt >= quietSince)) return;
  const c = commands(w, sessionId(w), ctx.config.host);
  const issue = await ctx.linear.fileDecision(w.id, `Check ${w.key}: the lead looks stuck`, [
    `The lead has shown no activity for ${quiet} minutes and still holds a lead slot.`,
    `Watch it with \`${c.watch}\`. If it is stuck, stop it with \`${c.stop}\`. Comment what it should do and close this issue; the runner then starts it again.`,
  ].join('\n\n'));
  await status(ctx, w, ticket, `Lead quiet for ${quiet} minutes; asked in [${issue.identifier}](${issue.url}). It still holds a slot.`);
}

/** Files the runner's own Decision issue: the lead stopped, or could not start, with nothing open to wait for. */
async function decide(ctx: Ctx, w: Work, ticket: Ticket, why: string) {
  const c = commands(w, sessionId(w), ctx.config.host);
  const issue = await ctx.linear.fileDecision(w.id, `Decision for ${w.key}: ${why}`, [
    `${why}. The ticket is still open and delegated to the runner.`,
    `Read the ticket and its PRs, or quiz the lead with \`${c.quiz}\`. Comment what it should do, then close this issue (Done or Canceled). The runner starts the lead again with your comments.`,
    `To stop the work instead, mark ${w.key} Done or Canceled, or clear its delegate, first.`,
  ].join('\n\n'));
  await status(ctx, w, ticket, `Waiting on [${issue.identifier}](${issue.url}). The lead holds no slot.`);
}

/** The ticket's worktree is the shortest folder named for its key, so a title change or a quiz worktree does not move it. */
export function workFor(config: Config, issue: Issue): Work | null {
  const repo = issue.labels.nodes.map((l) => l.name).find((name) => Object.hasOwn(config.repos, name));
  if (!repo) return null;
  const description = issue.description ?? '';
  const line = (key: string) => new RegExp(`^${key}:\\s*(\\S+)`, 'im').exec(description)?.[1];
  const prefix = `job-${issue.identifier.toLowerCase()}-`;
  const existing = existsSync(config.worktreeRoot) ? readdirSync(config.worktreeRoot).filter((name) => name.startsWith(prefix)).sort((a, b) => a.length - b.length)[0] : undefined;
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  const folder = existing ?? `${prefix}${slug}`;
  return {
    id: issue.id, key: issue.identifier, title: issue.title, url: issue.url, description, repo,
    branch: `job/${folder.slice(4)}`, dir: path.join(config.worktreeRoot, folder),
    models: { lead: line('(?:Lead|Implement) model') ?? config.models.lead, review: line('Review model') ?? config.models.review },
  };
}

/** The free memory percentage from macOS `memory_pressure -Q`, or 100 where that tool does not exist. */
async function freeMemory(): Promise<number> {
  if (process.platform !== 'darwin' && !process.env.JOB_RUNNER_MEMORY_PRESSURE) return 100;
  const { out } = await run(bin('memory_pressure'), ['-Q'], process.cwd());
  const free = /free percentage:\s*(\d+)%/.exec(out)?.[1];
  if (free === undefined) throw new Error(`memory_pressure -Q printed no free percentage:\n${tail(out, 5)}`);
  return Number(free);
}

/** One poll: every open ticket delegated to the runner. */
async function poll(ctx: Ctx, dryRun: boolean, say: (line: string) => void) {
  const { config, linear } = ctx;
  const free = await freeMemory();
  const tickets: { w: Work; ticket: Ticket; live: boolean }[] = [];
  for (const issue of await linear.issues()) {
    const w = workFor(config, issue);
    if (!w) {
      if (dryRun) { console.log(`${issue.identifier}: no repo label`); continue; }
      await linear.comment(issue.id, `No repo label, so the runner skipped this. Add one of ${Object.keys(config.repos).join(', ')} and delegate it again.`);
      await linear.clearDelegate(issue.id);
      continue;
    }
    const ticket = await linear.ticket(issue.id);
    if (ticket) tickets.push({ w, ticket, live: await live(w) });
  }
  const running = tickets.filter((t) => t.live);
  for (const { w, ticket, live: isLive } of tickets) {
    try {
      if (isLive) {
        if (dryRun) console.log(`${w.key}: lead running`);
        else await checkStall(ctx, w, ticket);
        continue;
      }
      const move = nextMove(config, ticket, lastStart(w));
      if (dryRun) { console.log(`${w.key}: ${move.kind}`); continue; }
      if (move.kind === 'wait') continue;
      if (move.kind === 'decide') { await decide(ctx, w, ticket, 'the lead stopped with nothing open to wait for'); continue; }
      const reason = startBlock({
        running: running.length, maxLeads: config.maxLeads, freeMemory: free, minFreeMemory: config.minFreeMemoryPercent,
        needsScreen: needsScreen(w.description), screenTaken: running.some((r) => needsScreen(r.w.description)),
      });
      if (reason) { say(`Not starting ${w.key} yet: ${reason}`); continue; }
      try {
        await launch(ctx, w, move.news);
      } catch (error) {
        await decide(ctx, w, ticket, `the runner could not start the lead: ${message(error).split('\n')[0]}`);
        continue;
      }
      running.push({ w, ticket, live: true });
      if (ticket.state === 'unstarted') await linear.setState(w.id, 'In Progress');
      await status(ctx, w, ticket, 'Lead running');
    } catch (error) {
      console.error(`${w.key}: failed; the next poll tries again`, error);
    }
  }
}

export async function main(argv: string[], config: Config, fetchFn: typeof fetch = fetch) {
  const dryRun = argv.includes('--dry-run');
  const once = dryRun || argv.includes('--once');
  let said = new Set<string>();
  let next = new Set<string>();
  /** Logs a line once while it stays true, so a blocked queue does not repeat itself every poll. */
  const say = (line: string) => { if (!said.has(line)) console.log(line); next.add(line); };
  const ctx: Ctx = { config, linear: linearClient(config, fetchFn) };
  if (dryRun) console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  for (;;) {
    try {
      await poll(ctx, dryRun, say);
    } catch (error) {
      console.error('poll failed', error);
    }
    [said, next] = [next, new Set()];
    if (once) return;
    await sleep(config.pollSeconds * 1000);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), loadConfig(process.env.JOB_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'job-runner', 'config.json')));
}
