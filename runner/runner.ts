import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDueRoutines, parseSchedule, type Routine } from './routines.ts';

export type Repo = { path: string; base: string };
export type Config = {
  linearTokenCommand: string;
  /** Optional. Prints a GitHub token; the lead and its subagents get it as GH_TOKEN. */
  ghTokenCommand?: string;
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
  toolQuietMinutes: number;
  host: string;
  worktreeRoot: string;
  routines?: Routine[];
};
type Comment = { id: string; body: string; createdAt: string; parentId?: string | null; user: { name: string; app?: boolean } | null; botActor?: { name: string } | null };
/** Only a person's comment counts as Alex acting: not the runner, its leads, or any other app or bot. */
const human = (c: Comment) => !!c.user && !c.user.app && !c.botActor;
type Issue = { id: string; identifier: string; title: string; description: string | null; url: string; createdAt: string; state: { type: string }; labels: { nodes: { name: string }[] } };
/**
 * A sub-issue of a ticket. One assigned to `decisionAssignee` is a Decision issue: Alex owes a move on it.
 * `closedBy` names who last moved it to Done or Canceled, from its history, so a lead's own closure is not news.
 * Linear lists history newest first, so the latest closure sits in the first page unless 50 changes followed it.
 */
export type Child = { id: string; identifier: string; title: string; url: string; createdAt: string; completedAt: string | null; canceledAt: string | null; closedBy: string | null; assignee: { name: string } | null };
type History = { nodes: { createdAt: string; actor: { name: string } | null; toState: { type: string } | null }[] };
/** What Linear says about a ticket this poll. `state` is the state type: `unstarted` for Todo, `started` for In Progress or In Review. */
export type Ticket = { state: string; delegate: string | null; comments: Comment[]; children: Child[] };
/** A ticket as the runner sees it this poll. */
export type Work = { id: string; key: string; title: string; url: string; description: string; repo: string; branch: string; dir: string; models: { lead: string; review: string } };
type Ctx = { config: Config; linear: ReturnType<typeof linearClient> };
/** The runner's move for an idle ticket. It mirrors `model/Ticket.tla`: wait, start the lead, or file a Decision issue. */
export type Move = { kind: 'wait'; on: Child } | { kind: 'start'; news: string[] } | { kind: 'decide' };

const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));
const SUBAGENT_DONE = fileURLToPath(new URL('../extensions/interactive-subagents/pi-extension/subagents/subagent-done.ts', import.meta.url));
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
  for (const r of raw.routines ?? []) parseSchedule(r.schedule);
  return { thinking: 'high', pollSeconds: 30, maxLeads: 2, minFreeMemoryPercent: 20, stallMinutes: 5, toolQuietMinutes: 60, host: os.hostname().replace(/\.local$/, ''), ...raw };
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
  const CHILD = 'id identifier title url createdAt completedAt canceledAt assignee { name } history(first: 50) { nodes { createdAt actor { name } toState { type } } }';
  return {
    /**
     * Open tickets delegated to the runner: Todo (unstarted) and any started state, such as In Progress or the
     * In Review that Linear's GitHub link sets when a PR opens. Todo ones come first, then the oldest; `poll` puts tickets with news from Alex ahead of both.
     */
    async issues(): Promise<Issue[]> {
      const nodes: Issue[] = [];
      for (let after: string | null = null; ;) {
        const page: { issues: { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
          `query Issues($team: String!, $user: String!, $after: String) { issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, state: { type: { in: ["unstarted", "started"] } }, delegate: { name: { eq: $user } } }) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
          { team: config.team, user: config.runnerUser, after },
        );
        nodes.push(...page.issues.nodes);
        if (!page.issues.pageInfo.hasNextPage) break;
        after = page.issues.pageInfo.endCursor;
        if (!after) throw new Error('Linear gave no cursor');
      }
      return nodes.sort((a, b) => b.state.type.localeCompare(a.state.type) || a.createdAt.localeCompare(b.createdAt));
    },
    /** Whether the ticket with this key is Done, Canceled or no longer delegated to the runner. Throws when Linear has no such ticket. */
    async closed(key: string): Promise<boolean> {
      const { issue } = await gql<{ issue: { state: { type: string }; delegate: { name: string } | null } | null }>(
        'query IssueByKey($key: String!) { issue(id: $key) { state { type } delegate { name } } }', { key },
      );
      if (!issue) throw new Error(`Linear has no ticket ${key}`);
      return ['completed', 'canceled'].includes(issue.state.type) || issue.delegate?.name !== config.runnerUser;
    },
    /** The ticket's state, comments and sub-issues in one read, or null when no issue has that id. */
    async ticket(id: string): Promise<Ticket | null> {
      type Wire = { state: { type: string }; delegate: { name: string } | null; comments: { nodes: Comment[] }; children: { nodes: (Omit<Child, 'closedBy'> & { history: History })[] } };
      const found = (await gql<{ issues: { nodes: Wire[] } }>(
        `query IssueById($id: ID!) { issues(first: 1, filter: { id: { eq: $id } }) { nodes { state { type } delegate { name } comments(first: 100) { nodes { id body createdAt parentId user { name app } botActor { name } } } children(first: 50) { nodes { ${CHILD} } } } } }`,
        { id },
      )).issues.nodes[0];
      if (!found) return null;
      return {
        state: found.state.type, delegate: found.delegate?.name ?? null,
        comments: found.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        children: found.children.nodes.map(({ history, ...c }) => ({
          ...c,
          closedBy: history.nodes.filter((h) => ['completed', 'canceled'].includes(h.toState?.type ?? ''))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.actor?.name ?? null,
        })),
      };
    },
    async setState(id: string, state: string) {
      const { workflowStates } = await gql<{ workflowStates: { nodes: { id: string }[] } }>(
        'query State($team: String!, $name: String!) { workflowStates(filter: { team: { key: { eq: $team } }, name: { eq: $name } }) { nodes { id } } }',
        { team: config.team, name: state },
      );
      const stateId = workflowStates.nodes[0]?.id;
      if (!stateId) throw new Error(`Linear team ${config.team} has no state named "${state}"`);
      const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input: { stateId } });
      if (!issueUpdate.success) throw new Error(`Linear did not move ${id} to ${state}`);
    },
    async clearDelegate(id: string) {
      await gql('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input: { delegateId: null } });
    },
    async comment(issueId: string, body: string, parentId?: string) {
      await gql('mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body, ...(parentId ? { parentId } : {}) } });
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
    `- Take over (no stall nudges until you quit Pi): \`${c.takeOver}\``,
    `- Quiz a fork: \`${c.quiz}\``,
  ].join('\n');
}

/** Why a lead cannot start now, or null. `freeMemory` is the percentage macOS `memory_pressure -Q` reports as free. */
export function startBlock(o: { running: number; maxLeads: number; freeMemory: number; minFreeMemory: number; needsScreen: boolean; screenHolder: string | null }): string | null {
  if (o.running >= o.maxLeads) return `all ${o.maxLeads} lead slots are busy`;
  if (o.freeMemory < o.minFreeMemory) return `only ${o.freeMemory}% of memory is free, under the ${o.minFreeMemory}% floor`;
  if (o.needsScreen && o.screenHolder) return `${o.screenHolder} has the screen`;
  return null;
}

export const needsScreen = (description: string) => /^Needs:\s*screen\s*$/im.test(description);

const rf = (w: Pick<Work, 'dir'>, name: string) => path.join(w.dir, '.runner', name);
const sessionId = (w: Work) => readOr(rf(w, 'session-id'))?.trim() ?? '';
/** The one fact the runner keeps per ticket: when it last started the lead. */
export const lastStart = (w: Pick<Work, 'dir'>) => readOr(rf(w, 'started'))?.trim() || null;
const isDecision = (config: Config, c: Child) => c.assignee?.name === config.decisionAssignee;
const closedAt = (c: Child) => c.completedAt ?? c.canceledAt;
/** When Alex closed this Decision issue, or null if it is open or the runner's token (the runner or a lead) closed it. */
const answeredAt = (config: Config, c: Child) => isDecision(config, c) && c.closedBy !== null && c.closedBy !== config.runnerUser ? closedAt(c) : null;

/**
 * The runner's move for a ticket whose lead is not running, from Linear and the last start time alone.
 * News is anything Alex did after that start: delegated the ticket (it sits in Todo), closed a Decision issue, or commented.
 * An open Decision issue makes the runner wait unless Alex commented or closed another Decision since the start:
 * he may answer on the ticket instead, and the lead judges whether that answers the open one.
 */
const DELEGATED = 'The ticket was delegated to you.';

export function nextMove(config: Config, ticket: Ticket, started: string | null): Move {
  const after = (at: string) => started === null || at > started;
  const answers = [
    ...ticket.children.filter((c) => answeredAt(config, c) && after(answeredAt(config, c)!))
      .map((c) => `Alex ${c.completedAt ? 'closed' : 'canceled'} ${c.identifier} (${c.title}): ${c.url}`),
    ...ticket.comments.filter((c) => human(c) && c.user?.name !== config.runnerUser && after(c.createdAt))
      .map((c) => `${c.user?.name ?? 'Someone'} commented: ${c.body}`),
  ];
  const open = ticket.children.find((c) => isDecision(config, c) && !closedAt(c));
  if (open && !answers.length) return { kind: 'wait', on: open };
  const news = [...(!open && (started === null || ticket.state === 'unstarted') ? [DELEGATED] : []), ...answers];
  return news.length ? { kind: 'start', news } : { kind: 'decide' };
}

/**
 * Tells Alex the runner saw his latest move on a ticket it cannot start yet, and why it waits. It replies once per move:
 * it skips a move it already acked, judged from its own comments, so it keeps no state. A comment gets a reply in its thread.
 */
async function ack(ctx: Ctx, w: Work, ticket: Ticket, started: string, reason: string) {
  const runner = (c: Comment) => c.user?.name === ctx.config.runnerUser;
  const comment = ticket.comments.filter((c) => human(c) && !runner(c) && c.createdAt > started).at(-1);
  const closed = ticket.children.map((c) => answeredAt(ctx.config, c)).filter((at) => at !== null && at > started).sort().at(-1);
  const latest = [comment?.createdAt, closed].filter((at) => at !== undefined).sort().at(-1);
  if (!latest || ticket.comments.some((c) => runner(c) && c.body.startsWith('Seen.') && c.createdAt > latest)) return;
  await ctx.linear.comment(w.id, `Seen. Waiting to start: ${reason}.`, latest === comment?.createdAt ? comment.parentId ?? comment.id : undefined);
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
 * Pi runs until the lead calls `subagent_done`.
 * The launch script drops every Pi variable the tmux server holds from another session, and reads the tokens itself,
 * so they never land on disk. It mirrors both into the tmux session, so windows the lead's subagents open match it.
 */
function envScript(ctx: Ctx, w: Work, name: string) {
  const keep = KEEP_ENV.filter((env) => process.env[env]);
  const tmuxEnv = `${sh(bin('tmux'))} set-environment -t ${sh(session(name))}`;
  const tokens = [['LINEAR_TOKEN', ctx.config.linearTokenCommand], ...(ctx.config.ghTokenCommand ? [['GH_TOKEN', ctx.config.ghTokenCommand]] : [])];
  return [
    '#!/bin/sh',
    `cd ${sh(w.dir)} || exit 1`,
    `export PATH=${sh(process.env.PATH ?? '')}`,
    '# The tmux server keeps the environment of whoever started it. Drop Pi and cmux variables from another session.',
    `for v in $(env | sed -n 's/^\\(PI_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(PSTACK_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(CMUX_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; ${tmuxEnv} -r "$v"; done`,
    ...keep.map((env) => `export ${env}=${sh(process.env[env]!)}`),
    ...tokens.flatMap(([env, command]) => [`${env}=$(${command}) || exit 1`, `export ${env}`]),
    ...[...keep, ...tokens.map(([env]) => env)].map((env) => `${tmuxEnv} ${env} "$${env}"`),
  ];
}

async function launch(ctx: Ctx, w: Work, news: string[]) {
  await worktree(ctx.config.repos[w.repo], w);
  if (!sessionId(w)) put(rf(w, 'session-id'), randomUUID());
  put(rf(w, 'input.md'), startMessage(ctx, w, news));
  for (const file of ['takeover', 'held', 'stall.json']) rmSync(rf(w, file), { force: true });
  const pi = (...extra: string[]) => [bin('pi'), '--session-id', sessionId(w), '-e', SUBAGENT_DONE,
    '--model', w.models.lead, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, 'lead.md'), ...extra].map(sh).join(' ');
  put(rf(w, 'lead.sh'), [
    ...envScript(ctx, w, w.key),
    `PI_SUBAGENT_ID=${sh(w.key)} ${pi(`@${rf(w, 'input.md')}`)}`,
    '# A person who touched .runner/takeover keeps the session, with no stall nudges, until they quit Pi.',
    `if [ -f .runner/takeover ]; then mv .runner/takeover .runner/held; ${pi()}; rm -f .runner/held; fi`,
    '',
  ].join('\n'));
  put(rf(w, 'started'), new Date().toISOString());
  await run(bin('tmux'), ['kill-session', '-t', session(w.key)], w.dir);
  const pane = await must(bin('tmux'), ['new-session', '-d', '-s', w.key, '-x', '200', '-y', '50', '-c', w.dir, '-P', '-F', '#{pane_id}', `sh ${sh(rf(w, 'lead.sh'))}`], w.dir);
  put(rf(w, 'pane'), pane);
  const tagged = await run(bin('tmux'), ['set-option', '-t', `${session(w.key)}:`, '@job-runner', w.key], w.dir);
  if (tagged.code !== 0) {
    const stopped = (await run(bin('tmux'), ['kill-session', '-t', session(w.key)], w.dir)).code === 0;
    throw new Error(stopped
      ? `could not tag the tmux session, so it was stopped: ${tagged.out.trim()}`
      : `could not tag the tmux session or stop it; stop it by hand with tmux kill-session -t '${session(w.key)}': ${tagged.out.trim()}`);
  }
}

const live = async (w: Pick<Work, 'key'>) => (await run(bin('tmux'), ['has-session', '-t', session(w.key)], process.cwd())).code === 0;

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
/** Pi's session folder for a cwd, named the way Pi names it. */
const sessionFolder = (cwd: string) => path.join(agentDir(), 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);

/** The last message in the last 1 MB of a session log, or null. */
function lastMessage(file: string): { role?: string; stopReason?: string; text?: string } | null {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 1 << 20));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    for (const line of buffer.toString('utf8').trimEnd().split('\n').reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message') continue;
        const content = entry.message?.content;
        return { ...entry.message, text: typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('') : '' };
      } catch { /* a partial first line */ }
    }
    return null;
  } finally { closeSync(fd); }
}

/**
 * The lead's heartbeat: the newest write to any Pi session log of the worktree or a sibling named `<worktree>-<unit>`,
 * where sub-leads work; each cwd has its own folder, and the investigator's (`.runner`) is left out. Also whether that log's last message is mid-step. A tool call with no result,
 * or a user message or tool result with no reply, is busy; anything else is idle. The lead start is the floor.
 */
export function heartbeat(w: Pick<Work, 'dir'>) {
  const started = lastStart(w);
  let newest = { at: started ? Date.parse(started) : 0, file: '' };
  const sessions = path.join(agentDir(), 'sessions');
  const prefixes = [...new Set([w.dir, existsSync(w.dir) ? realpathSync(w.dir) : w.dir])].map((dir) => path.basename(sessionFolder(dir)).slice(0, -1));
  const investigator = [rf(w, ''), existsSync(w.dir) ? path.join(realpathSync(w.dir), '.runner') : ''].map((dir) => path.basename(sessionFolder(dir)));
  const folders = existsSync(sessions) ? readdirSync(sessions).filter((f) => prefixes.some((p) => f.startsWith(p)) && !investigator.includes(f)) : [];
  for (const folder of folders.map((f) => path.join(sessions, f))) {
    for (const name of readdirSync(folder).filter((f) => f.endsWith('.jsonl'))) {
      const at = statSync(path.join(folder, name)).mtimeMs;
      if (at > newest.at) newest = { at, file: path.join(folder, name) };
    }
  }
  const last = newest.file ? lastMessage(newest.file) : null;
  const busy = !!last && ((last.role === 'assistant' && last.stopReason === 'toolUse') || last.role === 'user' || last.role === 'toolResult');
  return { at: newest.at, busy, nudge: !!last && last.role === 'user' && last.text?.startsWith(NUDGE) };
}

const NUDGE = 'No progress from you or your subagents for';
/** What the runner did about the current quiet stretch, kept in `.runner/stall.json`. */
type Stall = { nudgedAt: number; investigatedAt?: number };

/**
 * A live lead belongs to the lead: the runner never starts, restarts or kills it. A quiet stretch is `stallMinutes`
 * with no heartbeat while idle, or `toolQuietMinutes` while busy. The first in a lead run gets Escape (closing a
 * selector, or stopping the tool or wait) and one nudge. The second, whether or not the lead wrote in between, starts
 * one investigator that reports on the ticket. After that the runner does nothing until it starts the lead again.
 */
async function checkStall(ctx: Ctx, w: Work, ticket: Ticket) {
  if (existsSync(rf(w, 'held')) || existsSync(rf(w, 'takeover'))) return;
  const beat = heartbeat(w);
  let stall: Stall | null = null;
  try { stall = JSON.parse(readFileSync(rf(w, 'stall.json'), 'utf8')); } catch { /* no quiet stretch this run */ }
  if (stall?.investigatedAt) return;
  const limit = (beat.busy && !beat.nudge ? ctx.config.toolQuietMinutes : ctx.config.stallMinutes) * 60000;
  const quiet = Math.floor((Date.now() - beat.at) / 60000);
  if (!beat.at || Date.now() - Math.max(beat.at, stall?.nudgedAt ?? 0) < limit) return;
  if (!stall) {
    const target = readOr(rf(w, 'pane'))?.trim() || `${session(w.key)}:`;
    await must(bin('tmux'), ['send-keys', '-t', target, 'Escape'], w.dir);
    await sleep(500);
    await must(bin('tmux'), ['send-keys', '-t', target, '-l', `${NUDGE} ${quiet} minutes${beat.busy ? ', so the runner pressed Escape to stop your tool or wait' : ''}. Check each subagent, take any finished result (from its pane, its session or the PR), close the ones that are done, then continue or end.`], w.dir);
    await must(bin('tmux'), ['send-keys', '-t', target, 'Enter'], w.dir);
    put(rf(w, 'stall.json'), JSON.stringify({ nudgedAt: Date.now() }));
    await status(ctx, w, ticket, `Lead running. No heartbeat for ${quiet} minutes${beat.busy ? ' with a step in flight' : ''}, so the runner nudged it.`);
  } else {
    await investigate(ctx, w, quiet);
    put(rf(w, 'stall.json'), JSON.stringify({ ...stall, investigatedAt: Date.now() }));
    await status(ctx, w, ticket, `Lead running. Quiet again after the nudge, so an investigator (tmux session \`${w.key}-stall\`) is looking into it.`);
  }
}

/** Starts a one-shot Pi in its own tmux session that finds out why the lead is stuck and comments on the ticket. It takes no lead slot. */
async function investigate(ctx: Ctx, w: Work, quiet: number) {
  put(rf(w, 'stall-input.md'), [
    `Issue ${w.key}: ${w.title}`, w.url, '',
    `Linear issue id: ${w.id}. Team: ${ctx.config.team}. File Decision issues as sub-issues assigned to ${ctx.config.decisionAssignee}.`,
    `The lead went quiet a second time since the runner nudged it: its session logs have had no write for ${quiet} minutes.`,
    `Lead tmux session: ${w.key}. Lead Pi session id: ${sessionId(w)}. Worktree: ${w.dir} on ${w.branch}.`,
    `Session logs of the lead and its subagents: ${sessionFolder(w.dir)}.`,
  ].join('\n'));
  const script = rf(w, 'stall.sh');
  put(script, [
    ...envScript(ctx, w, `${w.key}-stall`),
    '# Run from .runner so this session logs to its own folder, never the lead\'s heartbeat.',
    `cd ${sh(rf(w, ''))} || exit 1`,
    [bin('pi'), '-p', '--model', w.models.lead, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, 'stall.md'), `@${rf(w, 'stall-input.md')}`].map(sh).join(' '),
    '',
  ].join('\n'));
  await run(bin('tmux'), ['kill-session', '-t', session(`${w.key}-stall`)], w.dir);
  await must(bin('tmux'), ['new-session', '-d', '-s', `${w.key}-stall`, '-x', '200', '-y', '50', '-c', rf(w, ''), `sh ${sh(script)}`], w.dir);
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

/**
 * Kills the tmux session of a ticket the runner started that is no longer open: Done, Canceled, or no longer
 * delegated to the runner. The only time the runner kills a lead. It kills only a session the runner tagged with
 * `@job-runner` when it made it, never one a person took over, and only after Linear confirms that one ticket is
 * closed; on any doubt it leaves it.
 */
async function reapClosed(ctx: Ctx, open: Issue[]) {
  const keys = new Set(open.map((i) => i.identifier));
  const folders = existsSync(ctx.config.worktreeRoot) ? readdirSync(ctx.config.worktreeRoot) : [];
  const { out } = await run(bin('tmux'), ['list-sessions', '-F', '#{session_name} #{@job-runner}'], process.cwd());
  for (const [name, tag] of out.split('\n').map((line) => line.split(' '))) {
    if (!name || tag !== name || keys.has(name)) continue;
    const prefix = `job-${name.toLowerCase()}-`;
    const held = (f: string) => ['takeover', 'held'].some((m) => existsSync(path.join(ctx.config.worktreeRoot, f, '.runner', m)));
    if (folders.some((f) => f.startsWith(prefix) && held(f))) continue;
    try {
      if (await ctx.linear.closed(name)) await run(bin('tmux'), ['kill-session', '-t', session(name)], process.cwd());
    } catch (error) {
      console.error(`${name}: could not confirm the ticket is closed, so its session stays`, error);
    }
  }
}

/** One poll: every open ticket delegated to the runner. */
async function poll(ctx: Ctx, dryRun: boolean, say: (line: string) => void) {
  const { config, linear } = ctx;
  const free = await freeMemory();
  const tickets: { w: Work; ticket: Ticket; live: boolean }[] = [];
  const issues = await linear.issues();
  if (!dryRun) await reapClosed(ctx, issues);
  for (const issue of issues) {
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
  // Tickets with news from Alex start first; delegation alone is not news, even on a Todo ticket with an old start.
  // All other tickets tie and keep Linear's order (Todo first, then oldest), so an older Todo ticket with an old
  // start still goes before a newer one that never started: there is no separate never-started tier.
  const hasNews = (t: (typeof tickets)[number]) => {
    if (t.live || lastStart(t.w) === null) return false;
    const move = nextMove(config, t.ticket, lastStart(t.w));
    return move.kind === 'start' && move.news.some((line) => line !== DELEGATED);
  };
  tickets.sort((a, b) => Number(hasNews(b)) - Number(hasNews(a)));
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
        needsScreen: needsScreen(w.description), screenHolder: running.find((r) => needsScreen(r.w.description))?.w.key ?? null,
      });
      if (reason) {
        say(`Not starting ${w.key} yet: ${reason}`);
        const started = lastStart(w);
        if (started) await ack(ctx, w, ticket, started, reason);
        continue;
      }
      // Moving a Todo ticket to In Progress consumes the delegation before the start is recorded, so a crash
      // anywhere after it can only lead to a Decision issue, never a second start (model/Ticket.tla, NoSpin).
      if (ticket.state === 'unstarted') await linear.setState(w.id, 'In Progress');
      try {
        await launch(ctx, w, move.news);
      } catch (error) {
        await decide(ctx, w, ticket, `the runner could not start the lead: ${message(error).split('\n')[0]}`);
        continue;
      }
      running.push({ w, ticket, live: true });
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
      if (!dryRun) await createDueRoutines(config, fetchFn);
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
