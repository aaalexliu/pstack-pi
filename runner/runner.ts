import { spawn } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDueRoutines, parseSchedule, ROUTINE_MARK, type Routine } from './routines.ts';

export type Repo = { path: string; base: string };
export type Config = {
  linearTokenCommand: string;
  /** Optional. Prints a GitHub token; the lead and its subagents get it as GH_TOKEN. */
  ghTokenCommand?: string;
  team: string;
  runnerUser: string;
  /** Alex's Linear name. A ticket assigned to him waits for him. */
  askAssignee: string;
  repos: Record<string, Repo>;
  models: { lead: string; review: string };
  thinking: string;
  pollSeconds: number;
  /** Optional. Prints the Linear webhook signing secret. Without it the runner polls Linear every `pollSeconds`. */
  webhookSecretCommand?: string;
  /** The local port the webhook listens on, at `/linear`. Default 8787. */
  webhookPort: number;
  maxLeads: number;
  minFreeMemoryPercent: number;
  stallMinutes: number;
  toolQuietMinutes: number;
  host: string;
  worktreeRoot: string;
  routines?: Routine[];
};
type Comment = { id: string; body: string; url?: string; createdAt: string; parentId?: string | null; user: { name: string } | null; botActor?: { name: string } | null; reactions?: { emoji: string; user: { name: string } | null }[] };
/** One entry of an issue's history. A `botActor` marks an integration; `attachment` is the link it added. */
type Change = {
  createdAt: string; actor: { name: string } | null; botActor: { name: string } | null; attachment: { sourceType: string } | null;
  toState: { name: string } | null; toDelegate: { name: string } | null; fromDelegate: { name: string } | null; toAssignee: { name: string } | null; fromAssignee: { name: string } | null;
  addedLabelIds: string[] | null; removedLabelIds: string[] | null; toTitle: string | null; updatedDescription: boolean | null;
};
type Newest = { updatedAt: string; comments: { nodes: { createdAt: string }[] } };
/** An open ticket from the list query, with its sub-issues and, for each, the last change and newest comment. */
type Issue = Newest & {
  assignee: { name: string } | null; asked: { nodes: { createdAt: string }[] }; answered: { nodes: { createdAt: string }[] }; id: string; identifier: string; title: string; description: string | null; url: string; createdAt: string; state: { type: string }; labels: { nodes: { name: string }[] };
  children: { nodes: (Child & Newest)[]; pageInfo: { hasNextPage: boolean } };
};
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
/** A sub-issue of a ticket. */
export type Child = { id: string; identifier: string; title: string; url: string; createdAt: string };
/**
 * Something someone other than the runner did on the ticket or a sub-issue. `comment` is set for a comment, so an ack
 * can react to it or reply in its thread; `reacted` says the runner already put its 👀 on it.
 */
export type Event = { at: string; what: string; issue?: string; comment?: { id: string; issueId: string; thread: string; reacted: boolean; url?: string } };
/**
 * What Linear says about a ticket this poll. `state` is the state type: `unstarted` for Todo, `started` for In Progress or In Review.
 * `asking` says an ask is open: the newest `**Needs Alex:**` comment has no comment by Alex after it. `events` and `mine`, the runner's comments, cover the ticket and its sub-issues back to the lead's last start.
 */
export type Ticket = { state: string; assignee: string | null; asking: boolean; description: string; createdAt: string; mine: Comment[]; children: Child[]; events: Event[] };
/** A ticket as the runner sees it this poll. With no repo label, `repo` and `branch` are empty and `dir` is a folder with no repo. */
export type Work = { id: string; key: string; title: string; url: string; description: string; repo: string; branch: string; dir: string; models: { lead: string; review: string } };
/**
 * `quiet` holds, per ticket, the newest touch the runner read with no events, so it reads that ticket again only once something changes.
 * With a webhook, `webhook` is set: `handled` holds the events a pass has acted on,
 * so the backup poll can name one no webhook delivered, and `since` is when the runner started listening.
 * `reacted` holds comments the runner put its 👀 on this run, before Linear shows the reaction.
 */
type Ctx = {
  config: Config; linear: ReturnType<typeof linearClient>; quiet: Map<string, string>; reacted: Set<string>;
  webhook: boolean; since: string; handled: Set<string>;
  /** Per issue id, when its last webhook arrived: an event on it no later than that was delivered, even if a live lead meant no pass acted on it. */
  delivered: Map<string, string>;
  /** Per message typed into a live lead, when the runner last typed it, so it retypes at most once a minute. */
  typed: Map<string, number>;
};
/** The runner's move for an idle ticket. It mirrors `model/Ticket.tla`: wait, start the lead, or ask Alex. */
export type Move = { kind: 'wait' } | { kind: 'start'; events: Event[] } | { kind: 'ask' };

/** Linear's canonical name for 👀. A reaction on a person's comment is the runner's ack that it saw it. */
const EYES = 'eyes';
const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));
const SUBAGENT_DONE = fileURLToPath(new URL('../extensions/interactive-subagents/pi-extension/subagents/subagent-done.ts', import.meta.url));
const NEWEST = 'updatedAt comments(first: 1) { nodes { createdAt } }';
const ISSUE_FIELDS = `assignee { name } asked: comments(first: 1, filter: { body: { startsWith: "**Needs Alex:**" }, user: { name: { eq: $user } } }) { nodes { createdAt } } answered: comments(first: 1, filter: { user: { name: { eq: $alex } } }) { nodes { createdAt } } id identifier title description url createdAt state { type } labels { nodes { name } } ${NEWEST} children(first: 100) { nodes { id identifier title url createdAt ${NEWEST} } pageInfo { hasNextPage } }`;
/** Variables a lead keeps from the runner's environment. Every other `PI_*` and `PSTACK_*` belongs to another session. */
const KEEP_ENV = ['PI_AUTH_PROFILE', 'PI_CODING_AGENT_DIR', 'JOB_RUNNER_CONFIG'];
/** The runner's config file. The lead's `ticket` command reads it too. */
export const configFile = () => process.env.JOB_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'job-runner', 'config.json');
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
  for (const key of ['linearTokenCommand', 'team', 'runnerUser', 'askAssignee', 'repos', 'models', 'worktreeRoot']) {
    if (!raw[key]) throw new Error(`${file}: missing "${key}"`);
  }
  if (!raw.models.lead || !raw.models.review) throw new Error(`${file}: "models" needs "lead" and "review"`);
  for (const r of raw.routines ?? []) parseSchedule(r.schedule);
  return { thinking: 'high', pollSeconds: 30, webhookPort: 8787, maxLeads: 2, minFreeMemoryPercent: 20, stallMinutes: 5, toolQuietMinutes: 60, host: os.hostname().replace(/\.local$/, ''), ...raw };
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

/** The runner's Linear calls. The lead's `ticket` command makes its calls through this client too. */
export function linearClient(config: Config, fetchFn: typeof fetch) {
  let askAssigneeId: string | undefined;
  /**
   * One GraphQL call. The runner and every lead share the app's hourly budgets of requests and complexity. On a
   * 429 the call waits as long as Linear's `Retry-After` says and tries again.
   */
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (;;) {
      const token = await must('/bin/sh', ['-c', config.linearTokenCommand], process.cwd());
      const res = await fetchFn('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json()) as { data?: T; errors?: { extensions?: { code?: string } }[] };
      if (res.status === 429 || body.errors?.some((e) => e.extensions?.code === 'RATELIMITED')) {
        const wait = Number(res.headers.get('Retry-After')) || 60;
        console.log(`Linear rate limit hit; waiting ${wait} s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok || body.errors || !body.data) throw new Error(`Linear ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
      return body.data;
    }
  }
  const COMMENT = 'id body url createdAt parentId user { name } botActor { name } reactions { emoji user { name } }';
  const CHANGE = 'createdAt actor { name } botActor { name } attachment { sourceType } toState { name } toDelegate { name } fromDelegate { name } toAssignee { name } fromAssignee { name } addedLabelIds removedLabelIds toTitle updatedDescription';
  const page = (conn: string, fields: string, after = '') => `${conn}(first: 25${after}) { nodes { ${fields} } pageInfo { hasNextPage endCursor } }`;
  /**
   * The rest of one issue's comments or history back past `since`. Linear lists both newest first,
   * so the first page of a busy issue can stop short of the lead's last start.
   */
  async function back<T extends { createdAt: string }>(id: string, conn: string, fields: string, first: Page<T>, since: string) {
    const nodes = [...first.nodes];
    for (let info = first.pageInfo; info.hasNextPage && nodes.at(-1)!.createdAt > since;) {
      const { issue } = await gql<{ issue: Record<string, Page<T>> }>(
        `query More($id: String!, $after: String) { issue(id: $id) { ${page(conn, fields, ', after: $after')} } }`, { id, after: info.endCursor },
      );
      nodes.push(...issue[conn].nodes);
      info = issue[conn].pageInfo;
    }
    return nodes;
  }
  /** The events on one issue, by anyone but the runner and integrations. */
  const eventsOf = (key: string, id: string, comments: Comment[], history: Change[]): Event[] => {
    // Linear credits a change the GitHub link makes, such as In Review or assigning Alex when a PR links, to the PR author.
    // Its only mark is the link's own entry a moment before: a state or assignee change within 2 s after it is the link's.
    const links = history.filter((h) => h.botActor && h.attachment).map((h) => Date.parse(h.createdAt));
    const byIntegration = (h: Change) => !!h.botActor || (!!(h.toState || h.toAssignee)
      && links.some((at) => Date.parse(h.createdAt) - at >= 0 && Date.parse(h.createdAt) - at < 2000));
    return [
      ...comments.filter((c) => c.user && !c.botActor && c.user.name !== config.runnerUser)
        .map((c) => ({
          at: c.createdAt, what: `${key}: ${c.user!.name} commented: ${c.body}`, issue: id,
          comment: { id: c.id, issueId: id, thread: c.parentId ?? c.id, url: c.url, reacted: !!c.reactions?.some((r) => r.emoji === EYES && r.user?.name === config.runnerUser) },
        })),
      ...history.filter((h) => h.actor && h.actor.name !== config.runnerUser && !byIntegration(h))
        .map((h) => ({ at: h.createdAt, what: `${key}: ${h.actor!.name} ${change(h)}`, issue: id })),
    ];
  };
  return {
    gql,
    /**
     * Open tickets delegated to the runner: Todo (unstarted) and any started state, such as In Progress or the
     * In Review that Linear's GitHub link sets when a PR opens. Todo ones come first, then the oldest.
     */
    async issues(): Promise<Issue[]> {
      const nodes: Issue[] = [];
      for (let after: string | null = null; ;) {
        const page: { issues: { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
          `query Issues($team: String!, $user: String!, $alex: String!, $after: String) { issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, state: { type: { in: ["unstarted", "started"] } }, delegate: { name: { eq: $user } } }) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
          { team: config.team, user: config.runnerUser, alex: config.askAssignee, after },
        );
        const full = page.issues.nodes.find((i) => i.children.pageInfo.hasNextPage);
        if (full) throw new Error(`${full.identifier} has over 100 sub-issues; the runner reads at most 100`);
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
    /**
     * The events and the runner's comments since `since` on the ticket and its sub-issues, or null when Linear finds
     * none of them. It reads only the issues the list query shows changed since then: complexity grows with each page asked for.
     */
    async events(issue: Issue, since: string): Promise<Pick<Ticket, 'events' | 'mine'> | null> {
      const ids = [issue, ...issue.children.nodes].filter((i) => newest(i) > since).map((i) => i.id);
      type Wire = { id: string; identifier: string; comments: Page<Comment>; history: Page<Change> };
      const found = (await gql<{ issues: { nodes: Wire[] } }>(
        `query IssueById($ids: [ID!]!) { issues(first: ${ids.length}, filter: { id: { in: $ids } }) { nodes { id identifier ${page('comments', COMMENT)} ${page('history', CHANGE)} } } }`,
        { ids },
      )).issues.nodes;
      if (!found.length) return null;
      const events: Event[] = [];
      const mine: Comment[] = [];
      for (const i of found) {
        const comments = await back(i.id, 'comments', COMMENT, i.comments, since);
        events.push(...eventsOf(i.identifier, i.id, comments, await back(i.id, 'history', CHANGE, i.history, since)));
        mine.push(...comments.filter((c) => c.user?.name === config.runnerUser));
      }
      return { events: events.filter((e) => e.at > since).sort((a, b) => a.at.localeCompare(b.at)), mine };
    },
    /** The runner's status comment on a ticket, if it posted one. */
    async statusComment(id: string): Promise<Comment | undefined> {
      const { issue } = await gql<{ issue: { comments: { nodes: Comment[] } } }>(
        `query StatusComment($id: String!) { issue(id: $id) { comments(first: 10, filter: { body: { startsWith: "**Runner:**" } }) { nodes { ${COMMENT} } } } }`, { id },
      );
      return issue.comments.nodes.find((c) => c.user?.name === config.runnerUser);
    },
    async setState(id: string, state: string, unassign = false) {
      const { workflowStates } = await gql<{ workflowStates: { nodes: { id: string }[] } }>(
        'query State($team: String!, $name: String!) { workflowStates(filter: { team: { key: { eq: $team } }, name: { eq: $name } }) { nodes { id } } }',
        { team: config.team, name: state },
      );
      const stateId = workflowStates.nodes[0]?.id;
      if (!stateId) throw new Error(`Linear team ${config.team} has no state named "${state}"`);
      const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input: { stateId, ...(unassign ? { assigneeId: null } : {}) } });
      if (!issueUpdate.success) throw new Error(`Linear did not move ${id} to ${state}`);
    },
    /** Assigns the ticket to `askAssignee`, Alex, so it shows as his to act on, or unassigns it. */
    async assign(id: string, toAlex: boolean) {
      if (toAlex) askAssigneeId ??= (await gql<{ users: { nodes: { id: string }[] } }>('query User($name: String!) { users(filter: { name: { eq: $name } }) { nodes { id } } }', { name: config.askAssignee })).users.nodes[0]?.id;
      if (toAlex && !askAssigneeId) throw new Error(`Linear has no user ${config.askAssignee}`);
      const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input: { assigneeId: toAlex ? askAssigneeId : null } });
      if (!issueUpdate.success) throw new Error(`Linear did not ${toAlex ? 'assign' : 'unassign'} ${id}`);
    },
    async comment(issueId: string, body: string, parentId?: string) {
      await gql('mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body, ...(parentId ? { parentId } : {}) } });
    },
    /** Puts the runner's 👀 on a comment. */
    async react(commentId: string) {
      await gql('mutation React($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }', { input: { commentId, emoji: EYES } });
    },
    async editComment(id: string, body: string) {
      await gql('mutation EditComment($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', { id, input: { body } });
    },
  };
}

/** The commands Alex copies from the status comment. Each word is quoted for the local shell and again for the remote one. */
export function commands(w: Pick<Work, 'key' | 'dir'>, host: string) {
  const ssh = (...remote: string[]) => `ssh -t ${sh(host)} ${sh(remote.join(' '))}`;
  return {
    watch: ssh('tmux attach -t', sh(session(w.key))),
    takeOver: ssh('touch', sh(path.join(w.dir, '.runner', 'takeover')), '&& tmux attach -t', sh(session(w.key))),
    stop: ssh('tmux kill-session -t', sh(session(w.key))),
  };
}

export function renderStatus(w: Pick<Work, 'key' | 'dir' | 'branch'>, sessionId: string, host: string, state: string) {
  const c = commands(w, host);
  return [
    `**Runner:** ${state}`,
    '',
    `- Host: ${host}`,
    `- tmux session: \`${w.key}\``,
    `- Session id: \`${sessionId}\``,
    w.branch ? `- Worktree: \`${w.dir}\` on \`${w.branch}\`` : `- Folder: \`${w.dir}\`, with no repo until the lead adds a repo label`,
    `- Watch or steer: \`${c.watch}\``,
    `- Take over (no stall nudges until you quit Pi): \`${c.takeOver}\``,
  ].join('\n');
}

/** Why a lead cannot start now, or null. `freeMemory` is the percentage macOS `memory_pressure -Q` reports as free. */
export function startBlock(o: { running: number; maxLeads: number; freeMemory: number; minFreeMemory: number }): string | null {
  if (o.running >= o.maxLeads) return `all ${o.maxLeads} lead slots are busy`;
  if (o.freeMemory < o.minFreeMemory) return `only ${o.freeMemory}% of memory is free, under the ${o.minFreeMemory}% floor`;
  return null;
}

export const needsScreen = (description: string) => /^Needs:\s*screen\s*$/im.test(description);

/** One running lead as `running.json` lists it, so leads can see who else may want the screen. */
const runningEntry = (w: Work) => ({
  key: w.key, title: w.title, tmux: w.key, worktree: w.dir, sessionId: sessionId(w), needsScreen: needsScreen(w.description),
});
const runningFile = (config: Config) => path.join(config.worktreeRoot, 'running.json');

/** Writes the running leads to `<worktreeRoot>/running.json`. Leads take turns with the screen through `runner/screen-lock`. */
function writeRunning(config: Config, running: Work[]) {
  mkdirSync(config.worktreeRoot, { recursive: true });
  put(runningFile(config), `${JSON.stringify(running.map(runningEntry), null, 2)}\n`);
}

const rf = (w: Pick<Work, 'dir'>, name: string) => path.join(w.dir, '.runner', name);
const sessionId = (w: Work) => readOr(rf(w, 'session-id'))?.trim() ?? '';
/**
 * What the runner keeps per ticket, written whole or not at all: `seen`, the time up to which the lead saw every event, this lead run's `stall`,
 * and `dir`, the folder the lead ran in. A lead in a new folder, as in the repo's worktree once a ticket gets its repo label, starts as if none ran.
 */
type State = { seen: string; dir?: string; stall?: { nudgedAt: number; investigatedAt?: number } };
const stateFile = (config: Config, key: string) => path.join(config.worktreeRoot, '.state', `${key}.json`);
/** The state, or null if no lead ever started; a lead from before it has only `.runner/started`. `seen` must be an ISO UTC time, since events compare to it as strings. Throws on a corrupt file, or none where a lead ran: `poll` then counts only events from now. */
export function readState(config: Config, w: Pick<Work, 'dir' | 'key'>): State | null {
  const file = stateFile(config, w.key), old = readOr(rf(w, 'started'))?.trim();
  if (!existsSync(file) && !old) { if (existsSync(rf(w, 'session-id'))) throw new Error(`${file} is missing`); return null; }
  let s: State | undefined;
  try { s = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { seen: old }; } catch { /* corrupt */ }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(String(s?.seen)) || !Number.isFinite(Date.parse(s!.seen)) || (s!.stall && typeof s!.stall.nudgedAt !== 'number')) throw new Error(`${file} is corrupt`);
  return s!.dir && s!.dir !== w.dir ? null : s!;
}
const writeState = (config: Config, key: string, state: State) => { mkdirSync(path.dirname(stateFile(config, key)), { recursive: true }); put(stateFile(config, key), JSON.stringify(state)); };

/** What one history entry changed, as the lead's start message names it. */
function change(h: Change) {
  if (h.toState) return `moved it to ${h.toState.name}`;
  if (h.toDelegate) return `delegated it to ${h.toDelegate.name}`;
  if (h.fromDelegate) return 'cleared its delegate';
  if (h.toAssignee || h.fromAssignee) return h.toAssignee ? `assigned it to ${h.toAssignee.name}` : `unassigned ${h.fromAssignee!.name}`;
  if (h.addedLabelIds?.length || h.removedLabelIds?.length) return 'changed its labels';
  if (h.toTitle) return `retitled it "${h.toTitle}"`;
  if (h.updatedDescription) return 'edited its description';
  return 'changed it';
}

/**
 * Whether the lead's own session log holds `text` as a user message. Pi writes a typed message there only when it
 * hands it to the model, so a message a dialog swallowed, or one still queued when the lead exits, is not there.
 */
function inLog(w: Work, text: string) {
  const id = sessionId(w);
  const needle = `"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]`;
  return [...new Set([w.dir, realpathSync(w.dir)])].map(sessionFolder).some((folder) =>
    existsSync(folder) && readdirSync(folder).some((f) => f.endsWith(`_${id}.jsonl`) && readFileSync(path.join(folder, f), 'utf8').includes(needle)));
}

/** The one line the runner types into a live lead for an event. */
function eventText(w: Work, ticket: Ticket, e: Event) {
  const child = ticket.children.find((c) => c.id === e.issue);
  const where = child ? `on sub-issue ${child.identifier} "${child.title}"` : 'on the ticket';
  let what = e.what.replace(/^\S+: /, '').replace(/\s+/g, ' ').trim();
  if (what.length > 1500) what = `${what.slice(0, 1500)}...`;
  return `Linear event on ${w.key} while you run, ${where}: ${what}${e.comment?.url ? ` (${e.comment.url})` : ''}. Read it and act on it.`;
}

/**
 * Moves `.runner/passed` past each leading event the lead's log shows, and returns the rest. It runs for a live lead
 * and for one that ended, since a lead may log an event and exit before the runner looks.
 */
function settle(ctx: Ctx, w: Work, ticket: Ticket, events: Event[]) {
  const done = events.findIndex((e) => !inLog(w, eventText(w, ticket, e)));
  const seen = done === -1 ? events : events.slice(0, done);
  if (seen.length) writeState(ctx.config, w.key, { ...readState(ctx.config, w), seen: seen.at(-1)!.at });
  return done === -1 ? [] : events.slice(done);
}

/**
 * Types each event into the live lead's pane, as Alex would, when the runner started it there. No Escape: Pi queues
 * a message typed during a step and hands it over once the step's tools finish. An event counts as seen only once
 * its message is in the lead's log: then `.runner/passed` moves past it, so it is never typed again and does not
 * start the lead after it exits. Until then the runner retypes it at most once a minute, and a lead that exits
 * without it is started with it, as for any event. Skipped while a person holds the session.
 */
async function pass(ctx: Ctx, w: Work, ticket: Ticket, events: Event[]) {
  if (!existsSync(rf(w, 'pane')) || existsSync(rf(w, 'held')) || existsSync(rf(w, 'takeover')) || !(await leadSessions()).some((s) => s.key === w.key)) return;
  const target = readOr(rf(w, 'pane'))!.trim();
  let typed = false;
  for (const e of settle(ctx, w, ticket, events)) {
    const text = eventText(w, ticket, e);
    if (Date.now() - (ctx.typed.get(text) ?? 0) < 60_000) continue;
    await must(bin('tmux'), ['send-keys', '-t', target, '-l', text], w.dir);
    await must(bin('tmux'), ['send-keys', '-t', target, 'Enter'], w.dir);
    ctx.typed.set(text, Date.now());
    typed = true;
  }
  await react(ctx, events);
  if (typed) await status(ctx, w, `Lead running. Passed to the running lead: ${events.at(-1)!.what.split('\n')[0].slice(0, 120)}`);
}

/** The newest change or comment Linear shows on the ticket or a sub-issue. A sub-issue's change does not touch the ticket's `updatedAt`, nor does a comment. */
const newest = (i: Newest) => [i.updatedAt, ...i.comments.nodes.map((c) => c.createdAt)].sort().at(-1)!;
const touched = (issue: Issue) => [issue, ...issue.children.nodes].map(newest).sort().at(-1)!;

/**
 * The events since the runner's last attempt to start the lead. A ticket the runner never tried to start counts its
 * creation: Linear's history has no delegation entry for a ticket filed already delegated, and a routine files its own.
 */
export function newEvents(ticket: Ticket, attempted: string | null): Event[] {
  const since = attempted ?? '';
  const filed = since ? [] : [{ at: ticket.createdAt, what: ticket.description.includes(ROUTINE_MARK) ? 'A routine filed this ticket.' : 'The ticket was filed.' }];
  return [...filed, ...ticket.events.filter((e) => e.at > since)];
}

/**
 * The runner's move for a ticket whose lead is not running. Any event since the lead's last start starts it, even one
 * assigned to Alex: the lead judges whether it answers its ask. With none, one assigned to Alex waits; any other gets an ask.
 */
export function nextMove(ticket: Ticket, attempted: string | null): Move {
  const events = newEvents(ticket, attempted);
  if (events.length) return { kind: 'start', events };
  return ticket.asking ? { kind: 'wait' } : { kind: 'ask' };
}

/**
 * Tells Alex the runner saw the latest event on a ticket it cannot start yet, and why it waits. It replies once per event:
 * it skips one it already acked, judged from its own comments, so it keeps no state. A comment gets a reply in its thread.
 */
async function ack(ctx: Ctx, w: Work, ticket: Ticket, events: Event[], reason: string) {
  const latest = events.at(-1)!;
  if (ticket.mine.some((c) => c.body.startsWith('Seen.') && c.createdAt > latest.at)) return;
  await ctx.linear.comment(latest.comment?.issueId ?? w.id, `Seen. Waiting to start: ${reason}.`, latest.comment?.thread);
}

/**
 * The fast ack: a 👀 on each person's comment among the events, once per comment. Linear's own reactions on the
 * comment carry it across restarts; `reacted` covers the moment before Linear shows a new one. A failed reaction
 * is logged and never holds up the start.
 */
async function react(ctx: Ctx, events: Event[]) {
  for (const { comment } of events) {
    if (!comment || comment.reacted || ctx.reacted.has(comment.id)) continue;
    ctx.reacted.add(comment.id);
    try { await ctx.linear.react(comment.id); } catch (error) { console.error(`could not react to comment ${comment.id}`, error); }
  }
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
    // A lead may check out its PR branch, so any branch is fine; only a folder outside this repo is refused.
    const common = async (dir: string) => { const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], dir); return r.code === 0 ? realpathSync(r.out.trim()) : null; };
    const top = await run('git', ['rev-parse', '--show-toplevel'], w.dir);
    const ours = top.code === 0 && realpathSync(top.out.trim()) === realpathSync(w.dir) && (await common(w.dir)) === (await common(repo.path));
    if (!ours) throw new Error(`${w.dir} exists but is not a worktree of ${repo.path}, so the runner left it alone.`);
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
async function status(ctx: Ctx, w: Work, state: string) {
  const body = renderStatus(w, sessionId(w), ctx.config.host, state);
  const mine = await ctx.linear.statusComment(w.id);
  if (mine) await ctx.linear.editComment(mine.id, body);
  else await ctx.linear.comment(w.id, body);
}

/** The first message of each lead start: the ticket, the facts it needs to reach Linear, the events since its last start, and the other running leads. */
function startMessage(ctx: Ctx, w: Work, events: Event[], running: Work[]) {
  return [
    `Issue ${w.key}: ${w.title}`,
    w.url,
    '',
    w.description,
    '',
    `Linear issue id: ${w.id}. Team: ${ctx.config.team}. Alex in Linear: ${ctx.config.askAssignee}.`,
    `${w.repo ? `Branch: ${w.branch}. Base: ${ctx.config.repos[w.repo].base}.` : `No repo label yet, so you run in a folder with no repo. Repo labels: ${Object.keys(ctx.config.repos).join(', ')}.`} Review model: ${w.models.review}. Prompts: ${PROMPTS}.`,
    '',
    'Events since your last start:',
    ...events.map((e) => `- ${e.at} ${e.what}`),
    '',
    `Other leads running now (the runner keeps the live list in ${runningFile(ctx.config)}):`,
    ...(running.length ? running.map((r) => `- ${r.key}: ${r.title} (tmux ${r.key}, worktree ${r.dir}${needsScreen(r.description) ? ', Needs: screen' : ''})`) : ['- none']),
  ].join('\n');
}

/** GitHub and Linear token prefixes, then any run of 32 or more token characters. A UUID survives; a long path component may not. */
const REDACT = 's/(gh[pousr]_|github_pat_|lin_[a-z]+_)[A-Za-z0-9_]+/\\1[redacted]/g; s/[A-Za-z0-9_+=]{32,}/[redacted]/g';

/**
 * Starts or resumes the lead in a detached tmux session named for the ticket, and saves the start time.
 * Pi runs until the lead calls `subagent_done`.
 * The launch script drops every Pi variable the tmux server holds from another session, and reads the tokens itself,
 * so they never land on disk. It mirrors both into the tmux session, so windows the lead's subagents open match it.
 * A token command that fails writes its name, exit code and stderr, never its output, to `failed`, and the script exits.
 */
function envScript(ctx: Ctx, w: Work, name: string, failed: string) {
  const keep = KEEP_ENV.filter((env) => process.env[env]);
  const tmuxEnv = `${sh(bin('tmux'))} set-environment -t ${sh(session(name))}`;
  const tokens = [['LINEAR_TOKEN', ctx.config.linearTokenCommand], ...(ctx.config.ghTokenCommand ? [['GH_TOKEN', ctx.config.ghTokenCommand]] : [])];
  const stderr = `${failed}.stderr`;
  return [
    '#!/bin/sh',
    `cd ${sh(w.dir)} || exit 1`,
    `export PATH=${sh(process.env.PATH ?? '')}`,
    '# The tmux server keeps the environment of whoever started it. Drop Pi and cmux variables from another session.',
    `for v in $(env | sed -n 's/^\\(PI_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(PSTACK_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(CMUX_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; ${tmuxEnv} -r "$v"; done`,
    ...keep.map((env) => `export ${env}=${sh(process.env[env]!)}`),
    // Command output never reaches the file. Stderr does, with token-shaped strings blanked, since a helper may echo one.
    `failed() { s=$?; { printf '%s exited %s\\n' "$1" "$s"; sed -E ${sh(REDACT)} ${sh(stderr)} | tail -c 4000; } > ${sh(failed)}; rm -f ${sh(stderr)}; exit 1; }`,
    // Its own `sh -c` parses the command, so nothing in it, such as a trailing comment or a heredoc with `)`, can break this script.
    ...tokens.flatMap(([env, command]) => [`${env}=$(sh -c ${sh(command)} 2>${sh(stderr)}) || failed ${sh(`the ${env} command \`${command.replace(/\s*\n\s*/g, ' ')}\``)}`, `export ${env}`]),
    `rm -f ${sh(stderr)}`,
    ...[...keep, ...tokens.map(([env]) => env)].map((env) => `${tmuxEnv} ${env} "$${env}"`),
  ];
}

async function launch(ctx: Ctx, w: Work, events: Event[], running: Work[]) {
  if (w.repo) await worktree(ctx.config.repos[w.repo], w); else mkdirSync(rf(w, ''), { recursive: true });
  if (!sessionId(w)) put(rf(w, 'session-id'), randomUUID());
  put(rf(w, 'input.md'), startMessage(ctx, w, events, running));
  // The heartbeat reads the ticket from here, so it needs no Linear call and survives a runner restart.
  put(rf(w, 'work.json'), JSON.stringify(w));
  for (const file of ['takeover', 'held', 'started', 'passed', 'stall.json', START_FAILED]) rmSync(rf(w, file), { force: true });
  const pi = (...extra: string[]) => [bin('pi'), '--session-id', sessionId(w), '-e', SUBAGENT_DONE,
    '--model', w.models.lead, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, 'lead.md'), ...extra].map(sh).join(' ');
  put(rf(w, 'lead.sh'), [
    ...envScript(ctx, w, w.key, rf(w, START_FAILED)),
    `PI_SUBAGENT_ID=${sh(w.key)} ${pi(`@${rf(w, 'input.md')}`)}`,
    '# A person who touched .runner/takeover keeps the session, with no stall nudges, until they quit Pi.',
    `if [ -f .runner/takeover ]; then mv .runner/takeover .runner/held; ${pi()}; rm -f .runner/held; fi`,
    '',
  ].join('\n'));
  writeState(ctx.config, w.key, { seen: new Date().toISOString(), dir: w.dir });
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

/**
 * The tmux sessions the runner tagged as leads, each with the folder it started the lead in: the live leads the
 * heartbeat checks, the reaper may stop, and the runner types events into.
 */
async function leadSessions() {
  // Under launchd, with no UTF-8 locale, tmux prints a tab as `_`. So spaces split the fields, and the path, which may hold one, goes last.
  const { out } = await run(bin('tmux'), ['list-sessions', '-F', '#{session_name} #{@job-runner} #{session_path}'], process.cwd());
  return out.split('\n').map((line) => line.split(' ')).filter(([name, tag]) => name && tag === name).map(([key, , ...dir]) => ({ key, dir: dir.join(' ') }));
}

const live = async (w: Pick<Work, 'key'>) => (await run(bin('tmux'), ['has-session', '-t', session(w.key)], process.cwd())).code === 0;

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
/** Pi's session folder for a cwd, named the way Pi names it. */
const sessionFolder = (cwd: string) => path.join(agentDir(), 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);

/**
 * The last message in the last 1 MB of a session log, or null. A tail with no whole message, such as one huge
 * screenshot result, reads as `unknown`, which counts as busy so the longer limit applies.
 */
function lastMessage(file: string): { role?: string; stopReason?: string; text?: string; unknown?: boolean } | null {
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
    return buffer.length < size ? { unknown: true } : null;
  } finally { closeSync(fd); }
}

/**
 * The lead's heartbeat: the newest write to any Pi session log of the worktree or a sibling named `<worktree>-<sub-issue key>`,
 * where sub-leads work; each cwd has its own folder. The investigator's (`.runner`) is left out. Also whether that log's last message is mid-step. A tool call with no result,
 * or a user message or tool result with no reply, is busy; anything else is idle. `since`, the lead start or a later event it got, is the floor.
 */
export function heartbeat(w: Pick<Work, 'dir'>, since: string) {
  let newest = { at: Date.parse(since), file: '' };
  const sessions = path.join(agentDir(), 'sessions');
  const dirs = [...new Set([w.dir, existsSync(w.dir) ? realpathSync(w.dir) : w.dir])];
  const notLead = dirs.map((dir) => path.basename(sessionFolder(path.join(dir, '.runner'))));
  const folders = existsSync(sessions) ? readdirSync(sessions).filter((f) => dirs.some((d) => f.startsWith(path.basename(sessionFolder(d)).slice(0, -1))) && !notLead.includes(f)) : [];
  for (const folder of folders.map((f) => path.join(sessions, f))) {
    for (const name of readdirSync(folder).filter((f) => f.endsWith('.jsonl'))) {
      const at = statSync(path.join(folder, name)).mtimeMs;
      if (at > newest.at) newest = { at, file: path.join(folder, name) };
    }
  }
  const last = newest.file ? lastMessage(newest.file) : null;
  const busy = !!last && (!!last.unknown || (last.role === 'assistant' && last.stopReason === 'toolUse') || last.role === 'user' || last.role === 'toolResult');
  return { at: newest.at, busy, nudge: !!last && last.role === 'user' && last.text?.startsWith(NUDGE) };
}

const NUDGE = 'No progress from you or your subagents for';

/**
 * A live lead belongs to the lead: the runner never starts, restarts or kills it. A quiet stretch is `stallMinutes`
 * with no heartbeat while idle, or `toolQuietMinutes` while busy. The first in a lead run gets Escape (closing a
 * selector, or stopping the tool or wait) and one nudge. The second, whether or not the lead wrote in between, starts
 * one investigator that reports on the ticket. After that the runner does nothing until it starts the lead again.
 */
async function checkStall(ctx: Ctx, w: Work) {
  if (existsSync(rf(w, 'held')) || existsSync(rf(w, 'takeover'))) return;
  const state = (() => { try { return readState(ctx.config, w); } catch { return null; } })();
  if (!state || state.stall?.investigatedAt) return;
  const { stall } = state, beat = heartbeat(w, state.seen);
  const limit = (beat.busy && !beat.nudge ? ctx.config.toolQuietMinutes : ctx.config.stallMinutes) * 60000;
  const quiet = Math.floor((Date.now() - beat.at) / 60000);
  if (!beat.at || Date.now() - Math.max(beat.at, stall?.nudgedAt ?? 0) < limit) return;
  if (!stall) {
    const target = readOr(rf(w, 'pane'))?.trim() || `${session(w.key)}:`;
    await must(bin('tmux'), ['send-keys', '-t', target, 'Escape'], w.dir);
    await sleep(500);
    await must(bin('tmux'), ['send-keys', '-t', target, '-l', `${NUDGE} ${quiet} minutes${beat.busy ? ', so the runner pressed Escape to stop your tool or wait' : ''}. Check each subagent, take any finished result (from its pane, its session or the PR), close the ones that are done, then continue or end.`], w.dir);
    await must(bin('tmux'), ['send-keys', '-t', target, 'Enter'], w.dir);
    writeState(ctx.config, w.key, { ...state, stall: { nudgedAt: Date.now() } });
    await status(ctx, w, `Lead running. No heartbeat for ${quiet} minutes${beat.busy ? ' with a step in flight' : ''}, so the runner nudged it.`);
  } else {
    await investigate(ctx, w, quiet);
    writeState(ctx.config, w.key, { ...state, stall: { ...stall!, investigatedAt: Date.now() } });
    await status(ctx, w, `Lead running. Quiet again after the nudge, so an investigator (tmux session \`${w.key}-stall\`) is looking into it.`);
  }
}

/** Starts a one-shot Pi in its own tmux session that finds out why the lead is stuck and comments on the ticket. It takes no lead slot. */
async function investigate(ctx: Ctx, w: Work, quiet: number) {
  put(rf(w, 'stall-input.md'), [
    `Issue ${w.key}: ${w.title}`, w.url, '',
    `Linear issue id: ${w.id}. Team: ${ctx.config.team}. Alex in Linear: ${ctx.config.askAssignee}.`,
    `The lead went quiet a second time since the runner nudged it: its session logs have had no write for ${quiet} minutes.`,
    `Lead tmux session: ${w.key}. Lead Pi session id: ${sessionId(w)}. Worktree: ${w.dir} on ${w.branch}.`,
    `Session logs of the lead and its subagents: ${sessionFolder(w.dir)}.`,
  ].join('\n'));
  const script = rf(w, 'stall.sh');
  rmSync(rf(w, 'stall-start-failed'), { force: true });
  put(script, [
    ...envScript(ctx, w, `${w.key}-stall`, rf(w, 'stall-start-failed')),
    '# Run from .runner so this session logs to its own folder, never the lead\'s heartbeat.',
    `cd ${sh(rf(w, ''))} || exit 1`,
    [bin('pi'), '-p', '--model', w.models.lead, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, 'stall.md'), `@${rf(w, 'stall-input.md')}`].map(sh).join(' '),
    '',
  ].join('\n'));
  await run(bin('tmux'), ['kill-session', '-t', session(`${w.key}-stall`)], w.dir);
  await must(bin('tmux'), ['new-session', '-d', '-s', `${w.key}-stall`, '-x', '200', '-y', '50', '-c', rf(w, ''), `sh ${sh(script)}`], w.dir);
}

/** `lead.sh` writes this when a step before Pi fails: what failed and its exit code, then its stderr. A start deletes it. */
const START_FAILED = 'start-failed';

/** Why the last start stopped before Pi ran, with the failed step's stderr, or null when Pi started. */
function startFailure(w: Work): { why: string; stderr: string } | null {
  const text = readOr(rf(w, START_FAILED));
  if (text === null) return null;
  const [step, ...stderr] = text.split('\n');
  return { why: `lead.sh stopped before Pi started: ${step}. Its stderr is in ${rf(w, START_FAILED)}`, stderr: tail(stderr.join('\n'), 20).trim() };
}

/** The runner's ask when the lead stopped or could not start. Assigned first: a failed assign posts nothing, and an assigned ticket waits. */
async function ask(ctx: Ctx, w: Work, why: string, detail = '') {
  await ctx.linear.assign(w.id, true);
  await ctx.linear.comment(w.id, [`**Needs Alex:** ${why}. The ticket is still open and delegated to the runner.`,
    ...(detail ? [`\`\`\`text\n${detail}\n\`\`\``] : []),
    `Read the ticket and its PRs. Comment what it should do; your comment starts the lead again.`,
    `To stop the work instead, mark ${w.key} Done or Canceled, or clear its delegate.`,
  ].join('\n\n'));
  await status(ctx, w, 'Waiting on Alex. The lead holds no slot.');
}

/**
 * The ticket's worktree is the shortest folder named for its key, so a title change or a sub-lead's worktree does not move it.
 * With no repo label, the lead runs in `job-<key>` with no repo, so the repo's worktree starts its own lead once the label lands.
 */
export function workFor(config: Config, issue: Issue): Work {
  const repo = issue.labels.nodes.map((l) => l.name).find((name) => Object.hasOwn(config.repos, name)) ?? '';
  const description = issue.description ?? '';
  const line = (key: string) => new RegExp(`^${key}:\\s*(\\S+)`, 'im').exec(description)?.[1];
  const prefix = `job-${issue.identifier.toLowerCase()}-`;
  const existing = existsSync(config.worktreeRoot) ? readdirSync(config.worktreeRoot).filter((name) => name.startsWith(prefix)).sort((a, b) => a.length - b.length)[0] : undefined;
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  const folder = existing ?? `${prefix}${slug}`;
  return {
    id: issue.id, key: issue.identifier, title: issue.title, url: issue.url, description, repo,
    branch: repo && `job/${folder.slice(4)}`, dir: path.join(config.worktreeRoot, repo ? folder : prefix.slice(0, -1)),
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
  for (const { key: name, dir } of await leadSessions()) {
    if (keys.has(name) || ['takeover', 'held'].some((m) => existsSync(path.join(dir, '.runner', m)))) continue;
    try {
      if (await ctx.linear.closed(name)) await run(bin('tmux'), ['kill-session', '-t', session(name)], process.cwd());
    } catch (error) {
      console.error(`${name}: could not confirm the ticket is closed, so its session stays`, error);
    }
  }
}

/**
 * One pass over the open tickets delegated to the runner. A full poll takes every one. A webhook pass takes `only`
 * the tickets an issue id names: the ticket itself, or the parent of a sub-issue. A ticket not
 * delegated to the runner is not in the list, so a webhook about it does nothing. `audit` marks the backup poll,
 * which logs each event no webhook delivered.
 */
async function poll(ctx: Ctx, dryRun: boolean, say: (line: string) => void, opts: { only?: string[]; audit?: boolean } = {}) {
  const { config, linear } = ctx;
  const free = await freeMemory();
  const tickets: { w: Work; ticket: Ticket | null; live: boolean; lost?: string }[] = [];
  const issues = await linear.issues();
  if (!dryRun && !opts.only) await reapClosed(ctx, issues);
  const only = opts.only;
  const mine = (i: Issue) => !only || only.includes(i.id) || i.children.nodes.some((c) => only.includes(c.id));
  for (const issue of issues) {
    // Lead slots and the screen count every live lead, so a webhook pass still looks at the tickets it does not act on.
    const w = workFor(config, issue);
    if (!mine(issue)) {
      if (await live(w)) tickets.push({ w, ticket: null, live: true });
      continue;
    }
    // A live lead's heartbeat needs no Linear. A ticket nothing touched since the lead saw it, or since the
    // runner last read it and found no events, has none now. A live lead gets its events typed in.
    const isLive = await live(w);
    let state: State | null, lost: string | undefined;
    try { state = readState(config, w); } catch (error) { lost = `the runner lost its state (${message(error)}), so it counts only events from now`; state = { seen: new Date().toISOString() }; }
    if (lost && !dryRun) writeState(config, w.key, state!);
    const since = state?.seen ?? '';
    const at = touched(issue);
    const fresh = at > since && ctx.quiet.get(w.key) !== `${since} ${at}`;
    const seen = fresh ? await linear.events(issue, since) : { events: [], mine: [] };
    if (fresh && seen && !seen.events.length) ctx.quiet.set(w.key, `${since} ${at}`);
    // Who must act is read from the comments each pass: an open ask means Alex, a live lead with none means not Alex.
    // So any other assign, such as the GitHub link's when a PR links, is undone.
    const asking = (issue.asked.nodes[0]?.createdAt ?? '') > (issue.answered.nodes[0]?.createdAt ?? '');
    if (!dryRun && (asking || isLive) && asking !== (issue.assignee?.name === config.askAssignee)) { await linear.assign(issue.id, asking); issue.assignee = asking ? { name: config.askAssignee } : null; }
    const ticket = seen && { state: issue.state.type, assignee: issue.assignee?.name ?? null, asking, description: w.description, createdAt: issue.createdAt, children: issue.children.nodes, ...seen };
    if (isLive) tickets.push({ w, live: true, ticket: ticket && ticket.events.length ? ticket : null });
    else if (ticket) tickets.push({ w, live: false, lost, ticket });
  }
  // The ticket whose oldest unseen event is oldest goes first. Tickets with none keep Linear's order after them.
  const oldest = (t: (typeof tickets)[number]) => (t.ticket ? newEvents(t.ticket, readState(config, t.w)?.seen ?? null)[0]?.at : undefined);
  tickets.sort((a, b) => {
    const [x, y] = [oldest(a), oldest(b)];
    return x && y ? (x < y ? -1 : x > y ? 1 : 0) : Number(!x) - Number(!y);
  });
  const running = tickets.filter((t) => t.live);
  /** Marks events as acted on; the backup poll logs each one no webhook delivered. */
  const note = (w: Work, events: Event[]) => {
    for (const e of events) {
      const id = `${w.key} ${e.at} ${e.what}`;
      if (opts.audit && ctx.webhook && e.at >= ctx.since && !ctx.handled.has(id) && !(e.issue && (ctx.delivered.get(e.issue) ?? '') >= e.at)) console.log(`missed: ${w.key} ${e.at} ${e.what.split('\n')[0].slice(0, 120)}`);
      ctx.handled.add(id);
    }
  };
  for (const { w, ticket, live: isLive, lost } of tickets) {
    try {
      if (isLive) {
        if (dryRun) { console.log(`${w.key}: lead running`); continue; }
        if (ticket) { note(w, ticket.events); await pass(ctx, w, ticket, ticket.events); }
        // With a webhook, the heartbeat checks live leads on its own timer.
        if (!ctx.webhook) await checkStall(ctx, w);
        continue;
      }
      if (!ticket) continue;
      if (!dryRun && existsSync(rf(w, 'pane'))) settle(ctx, w, ticket, newEvents(ticket, readState(config, w)?.seen ?? null));
      const move = nextMove(ticket, readState(config, w)?.seen ?? null);
      if (dryRun) { console.log(`${w.key}: ${move.kind}`); continue; }
      if (move.kind === 'wait') continue;
      if (move.kind === 'start') {
        note(w, move.events);
        await react(ctx, move.events);
      }
      if (move.kind === 'ask') {
        const failed = lost ? null : startFailure(w);
        if (failed) console.error(`${w.key}: ${failed.why}\n${failed.stderr}`);
        await ask(ctx, w, lost ?? failed?.why ?? 'the lead stopped with nothing handed in', failed?.stderr);
        continue;
      }
      const reason = startBlock({
        running: running.length, maxLeads: config.maxLeads, freeMemory: free, minFreeMemory: config.minFreeMemoryPercent,
      });
      if (reason) {
        say(`Not starting ${w.key} yet: ${reason}`);
        await ack(ctx, w, ticket, move.events, reason);
        continue;
      }
      // The move is the runner's own, so it is not an event. A crash before the start is recorded starts the lead
      // once more on the same events; after it, nothing new means an ask (model/Ticket.tla, NoSpin).
      // The lead owns the ticket while it runs, so the runner unassigns Alex in the same write that starts it.
      const unassign = ticket.assignee === config.askAssignee && !ticket.asking;
      if (ticket.state === 'unstarted') await linear.setState(w.id, 'In Progress', unassign);
      else if (unassign) await linear.assign(w.id, false);
      try {
        await launch(ctx, w, move.events, running.map((r) => r.w));
      } catch (error) {
        // Record the attempt, so only a new event retries a failed start.
        writeState(config, w.key, { ...readState(config, w), seen: new Date().toISOString() });
        await ask(ctx, w, `the runner could not start the lead: ${message(error).split('\n')[0]}`);
        continue;
      }
      running.push({ w, ticket: null, live: true });
      writeRunning(config, running.map((r) => r.w));
      // For an event that is not a comment, such as a delegation, this edit is the ack.
      await status(ctx, w, 'Lead running');
    } catch (error) {
      console.error(`${w.key}: failed; the next poll tries again`, error);
    }
  }
  if (!dryRun) writeRunning(config, running.map((r) => r.w));
}

const newCtx = (config: Config, fetchFn: typeof fetch, webhook: boolean): Ctx => ({
  config, linear: linearClient(config, fetchFn), quiet: new Map(), reacted: new Set(), webhook, since: new Date().toISOString(), handled: new Set(), delivered: new Map(), typed: new Map(),
});

/** Whether a Linear webhook delivery carries a valid `Linear-Signature`, the hex HMAC-SHA256 of the raw body. */
export function signed(secret: string, raw: Buffer, signature: string | undefined) {
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(signature ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The issue a Linear webhook is about: an Issue event's own id, or a Comment's (or any other entity's) `issueId`.
 * The pass maps a sub-issue to its parent ticket from the list query's children.
 */
function issueOf(payload: { type?: string; data?: { id?: string; issueId?: string } }) {
  return payload.type === 'Issue' ? payload.data?.id : payload.data?.issueId;
}

/**
 * Runs the runner with a Linear webhook: a server on 127.0.0.1 at `/linear`, a 30 s heartbeat for live leads that
 * makes no Linear calls, and a backup poll every 10 minutes. All Linear work runs one pass at a time.
 * It answers a valid delivery with 200 before it acts, since Linear waits at most 5 s.
 */
export async function serve(config: Config, fetchFn: typeof fetch, secret: string, port = config.webhookPort) {
  const ctx = newCtx(config, fetchFn, true);
  let said = new Set<string>();
  const say = (line: string) => { if (!said.has(line)) console.log(line); said.add(line); };
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (what: string, work: () => Promise<unknown>) => {
    queue = queue.then(work).catch((error) => console.error(`${what} failed`, error));
    return queue;
  };
  // The endpoint is public through Funnel, so no request, however broken, may throw out of the handler.
  const server = createServer((req, res) => {
    res.on('error', () => {});
    handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/linear') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1 << 20) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    if (!signed(secret, raw, req.headers['linear-signature'] as string | undefined)) { res.writeHead(401).end(); return; }
    let payload: { type?: string; data?: { id?: string; issueId?: string }; webhookTimestamp?: number };
    try { payload = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400).end(); return; }
    // A replayed delivery carries an old timestamp; Linear's own retries are signed afresh.
    if (!(Math.abs(Date.now() - Number(payload.webhookTimestamp)) <= 60_000)) { res.writeHead(401).end(); return; }
    res.writeHead(200).end();
    const id = issueOf(payload);
    if (id) ctx.delivered.set(id, new Date().toISOString());
    if (id) enqueue(`webhook ${payload.type} ${id}`, () => poll(ctx, false, say, { only: [id] }));
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port: (server.address() as { port: number }).port,
    /** The backup poll: every ticket, logging each event no webhook delivered. */
    audit: () => { said = new Set(); return enqueue('backup poll', () => poll(ctx, false, say, { audit: true })); },
    /** The heartbeat: nudges or investigates a quiet live lead, and rewrites running.json. It reads only tmux and session logs, unless it acts. */
    heartbeat: () => enqueue('heartbeat', async () => {
      // The live leads are the tmux sessions the runner tagged, each with the ticket its launch saved in the lead's folder.
      const leads: Work[] = [];
      for (const { dir } of await leadSessions()) {
        const saved = readOr(rf({ dir }, 'work.json'));
        if (saved) leads.push(JSON.parse(saved));
      }
      for (const w of leads) {
        try { await checkStall(ctx, w); } catch (error) { console.error(`${w.key}: stall check failed`, error); }
      }
      // It keeps running.json fresh, and passes the ticket of a lead that left it at once: a stop gets its ask in 30 s.
      const gone = (JSON.parse(readOr(runningFile(config)) ?? '[]') as { key: string; worktree: string }[]).filter((r) => !leads.some((l) => l.key === r.key)).flatMap((r) => readOr(rf({ dir: r.worktree }, 'work.json')) ?? []);
      writeRunning(config, leads);
      if (gone.length) await poll(ctx, false, say, { only: gone.map((s) => (JSON.parse(s) as Work).id) });
    }),
    /** Resolves once every queued pass is done. */
    idle: () => queue,
    // A pass still queued at close would outlive the server, so close waits for it.
    close: () => queue.then(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  };
}

export async function main(argv: string[], config: Config, fetchFn: typeof fetch = fetch) {
  const dryRun = argv.includes('--dry-run');
  const once = dryRun || argv.includes('--once');
  if (!once && config.webhookSecretCommand) {
    const secret = await must('/bin/sh', ['-c', config.webhookSecretCommand], process.cwd());
    if (!secret) throw new Error('webhookSecretCommand printed nothing');
    const runner = await serve(config, fetchFn, secret);
    console.log(`Listening for Linear webhooks on 127.0.0.1:${runner.port}/linear; backup poll every 10m`);
    setInterval(() => void runner.heartbeat(), 30_000);
    // Routines keep their own timer: the ticket a routine files then starts through its webhook.
    void (async () => { for (;;) { await createDueRoutines(config, fetchFn); await sleep(config.pollSeconds * 1000); } })();
    for (;;) {
      await runner.audit();
      await sleep(600_000);
    }
  }
  let said = new Set<string>();
  let next = new Set<string>();
  /** Logs a line once while it stays true, so a blocked queue does not repeat itself every poll. */
  const say = (line: string) => { if (!said.has(line)) console.log(line); next.add(line); };
  const ctx = newCtx(config, fetchFn, false);
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
  await main(process.argv.slice(2), loadConfig(configFile()));
}
