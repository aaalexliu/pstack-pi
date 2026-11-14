import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Repo = { path: string; base: string; automerge: boolean; ciGate?: boolean; fullSuiteLabel?: string };
export type Config = {
  linearTokenCommand: string;
  team: string;
  runnerUser: string;
  decisionAssignee: string;
  repos: Record<string, Repo>;
  webhooks: Record<string, { url: string; keyFile: string }>;
  models: { lead: string; review: string };
  thinking: string;
  pollSeconds: number;
  maxLeads: number;
  minFreeMemoryPercent: number;
  stallMinutes: number;
  host: string;
  worktreeRoot: string;
};
export type Finding = { must_fix: boolean; caused_by_change: boolean; where: string; what: string; done_when: string };
export type Ask = { question: string; recommendation: string; options: { option: string; pick_this_if: string }[]; context?: string };
type Change = { kind: 'change'; full_suite: boolean; full_suite_why: string };
export type Ending = { kind: 'report'; body: string } | Change | ({ kind: 'decision' } & Ask);
type Comment = { id: string; body: string; createdAt: string; user: { name: string } | null };
type Issue = { id: string; identifier: string; title: string; description: string | null; url: string; createdAt: string; labels: { nodes: { name: string }[] } };
/** A Decision issue, and the ids of the issues it is marked as blocking. */
type Decision = { id: string; identifier: string; url: string; state: string; blocks: string[] };
/** A ticket as the runner sees it this poll. Everything else is read again from Linear, GitHub, tmux and `<dir>/.runner/`. */
export type Work = { id: string; key: string; title: string; url: string; description: string; repo: string; branch: string; dir: string; models: { lead: string; review: string } };
/** Why a turn exists, saved in `.runner/turn-N/cause.json` with the last comment its input carries. */
type Cause = { cause: 'task' | 'again' | 'answer' | 'verify' | 'findings' | 'cut'; decision?: string; round?: number; through?: { id: string; createdAt: string } };
type Review = { round: number; head: string; findings: Finding[] };
type Ctx = { config: Config; linear: ReturnType<typeof linearClient>; fetchFn: typeof fetch };
/** The next step for a ticket, worked out from what is true now. */
export type Observation =
  | { kind: 'start' | 'running' }
  | { kind: 'launch' | 'relaunch' | 'consume'; turn: number }
  | { kind: 'answer' | 'stop' | 'waiting'; turn: number; decision: Decision };

const STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_ROUNDS = 3;
const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));
const AUTO_EXIT = fileURLToPath(new URL('../extensions/interactive-subagents/pi-extension/subagents/subagent-done.ts', import.meta.url));
const ISSUE_FIELDS = 'id identifier title description url createdAt labels { nodes { name } }';
const RESTART_NOTE = 'The runner restarted while you worked on the message below. If you already acted on it, check where the work stands and carry on.';
const bin = (name: 'pi' | 'gh' | 'tmux' | 'memory_pressure') => process.env[`JOB_RUNNER_${name.toUpperCase()}`] ?? name;
/** Quotes one shell word. Plain words stay bare so the commands in the status comment stay readable. */
export const sh = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
/** tmux matches `-t ALE-1` to `ALE-10` by prefix when `ALE-1` is gone. `=` asks for the exact name. */
const session = (key: string) => `=${key}`;
const pane = (key: string) => `=${key}:`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function loadConfig(file: string): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['linearTokenCommand', 'team', 'runnerUser', 'decisionAssignee', 'repos', 'models', 'worktreeRoot']) {
    if (!raw[key]) throw new Error(`${file}: missing "${key}"`);
  }
  if (!raw.models.lead || !raw.models.review) throw new Error(`${file}: "models" needs "lead" and "review"`);
  return { webhooks: {}, thinking: 'high', pollSeconds: 30, maxLeads: 2, minFreeMemoryPercent: 20, stallMinutes: 30, host: os.hostname().replace(/\.local$/, ''), ...raw };
}

function run(cmd: string, args: string[], cwd: string, timeout = 0): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

const tail = (text: string, lines: number) => text.trimEnd().split('\n').slice(-lines).join('\n');

async function must(cmd: string, args: string[], cwd: string, timeout = 0): Promise<string> {
  const { code, out } = await run(cmd, args, cwd, timeout);
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
const readJson = <T>(file: string): T | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; } };

function linearClient(config: Config, fetchFn: typeof fetch) {
  let stateIds: Map<string, string> | undefined;
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
  type Found = { id: string; identifier: string; url: string; state: { type: string }; relations?: { nodes: { type: string; relatedIssue: { id: string } }[] } };
  const ISSUE = 'id identifier url state { type } relations { nodes { type relatedIssue { id } } }';
  const decision = (i: Found): Decision => ({
    id: i.id, identifier: i.identifier, url: i.url, state: i.state.type,
    blocks: (i.relations?.nodes ?? []).filter((r) => r.type === 'blocks').map((r) => r.relatedIssue.id),
  });
  const findMarked = async (mark: string): Promise<Decision | null> => {
    const found = (await gql<{ issues: { nodes: Found[] } }>(
      `query FindMarked($team: String!, $mark: String!) { issues(first: 1, filter: { team: { key: { eq: $team } }, description: { contains: $mark } }) { nodes { ${ISSUE} } } }`,
      { team: config.team, mark },
    )).issues.nodes[0];
    return found ? decision(found) : null;
  };
  /** Adds the `blocks` link Alex sees in Linear. Nothing reads it to decide whether an issue exists. */
  const link = async (issue: Decision, workId: string) => {
    if (issue.blocks.includes(workId)) return;
    await gql('mutation Relate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }', { input: { issueId: issue.id, relatedIssueId: workId, type: 'blocks' } });
  };
  return {
    async issues(state: string): Promise<Issue[]> {
      const data = await gql<{ issues: { nodes: Issue[] } }>(
        `query Issues($team: String!, $state: String!, $user: String!) { issues(first: 50, filter: { team: { key: { eq: $team } }, state: { name: { eq: $state } }, delegate: { name: { eq: $user } } }) { nodes { ${ISSUE_FIELDS} } } }`,
        { team: config.team, state, user: config.runnerUser },
      );
      return data.issues.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async update(id: string, state: string | null, clearDelegate = false) {
      stateIds ??= new Map(
        (await gql<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
          'query States($team: String!) { workflowStates(filter: { team: { key: { eq: $team } } }) { nodes { id name } } }',
          { team: config.team },
        )).workflowStates.nodes.map((s) => [s.name, s.id]),
      );
      const input: Record<string, unknown> = {};
      if (state) input.stateId = stateIds.get(state);
      if (clearDelegate) input.delegateId = null;
      await gql('mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input });
    },
    async comment(issueId: string, body: string): Promise<string> {
      const data = await gql<{ commentCreate: { comment: { id: string } } }>(
        'mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }',
        { input: { issueId, body } },
      );
      return data.commentCreate.comment.id;
    },
    async editComment(id: string, body: string) {
      await gql('mutation EditComment($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', { id, input: { body } });
    },
    async comments(id: string): Promise<Comment[]> {
      const data = await gql<{ issue: { comments: { nodes: Comment[] } } }>(
        'query Comments($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body createdAt user { name } } } } }',
        { id },
      );
      return data.issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    findMarked,
    link,
    /**
     * Files an issue assigned to `decisionAssignee`, with `mark` in its description, unless one with that mark exists.
     * The mark, not the link, says whether it exists: creating and linking are two writes, and a crash can fall between them.
     * The `blocks` link is for Alex to see.
     */
    async fileIssue(workId: string, title: string, description: string, mark: string) {
      if (!decisionIds) {
        const team = await gql<{ teams: { nodes: { id: string }[] } }>('query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: config.team });
        const user = await gql<{ users: { nodes: { id: string }[] } }>('query User($name: String!) { users(filter: { name: { eq: $name } }) { nodes { id } } }', { name: config.decisionAssignee });
        if (!team.teams.nodes[0] || !user.users.nodes[0]) throw new Error(`Linear has no team ${config.team} or no user ${config.decisionAssignee}`);
        decisionIds = { team: team.teams.nodes[0].id, assignee: user.users.nodes[0].id };
      }
      const issue = (await findMarked(mark)) ?? decision((await gql<{ issueCreate: { issue: Found } }>(
        `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE} } } }`,
        { input: { teamId: decisionIds.team, assigneeId: decisionIds.assignee, title, description: `${description}\n\n${mark}` } },
      )).issueCreate.issue);
      await link(issue, workId);
      return issue;
    },
  };
}

/** Reads the lead's `.runner/ending.json`. Anything but one valid ending is an error the runner turns into a Decision issue. */
export function parseEnding(text: string | null, proof: string): Ending | { error: string } {
  if (text === null) return { error: 'the lead exited without writing .runner/ending.json' };
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { return { error: '.runner/ending.json is not valid JSON' }; }
  const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (value?.kind === 'report') return filled(value.body) ? { kind: 'report', body: value.body.trim() } : { error: 'a report ending needs a "body"' };
  if (value?.kind === 'change') {
    if (!proof) return { error: 'a change ending needs a non-empty .runner/PROOF.md' };
    if (typeof value.full_suite !== 'boolean' || !filled(value.full_suite_why)) return { error: 'a change ending needs "full_suite" (true or false) and "full_suite_why"' };
    return { kind: 'change', full_suite: value.full_suite, full_suite_why: value.full_suite_why.trim() };
  }
  if (value?.kind === 'decision') {
    const options = value.options ?? [];
    if (!filled(value.question) || !filled(value.recommendation)) return { error: 'a decision ending needs a "question" and a "recommendation"' };
    if (!Array.isArray(options) || options.length > 3 || !options.every((o) => filled(o?.option) && filled(o?.pick_this_if))) {
      return { error: 'a decision ending allows at most 3 options, each with "option" and "pick_this_if"' };
    }
    return { kind: 'decision', question: value.question.trim(), recommendation: value.recommendation.trim(), options, ...(filled(value.context) ? { context: value.context.trim() } : {}) };
  }
  return { error: '.runner/ending.json needs "kind" set to "report", "change" or "decision"' };
}

/** Accepts an ending only from a Pi that exited 0. */
export function readEnding(exitCode: string | null, text: string | null, proof: string): Ending | { error: string } {
  if (exitCode === null) return { error: 'the lead session ended without an exit record' };
  if (exitCode !== '0') return { error: `Pi exited with code ${exitCode}` };
  return parseEnding(text, proof);
}

export function renderDecision(work: { key: string; url: string }, ask: Ask) {
  const title = `Decision for ${work.key}: ${ask.question.length > 80 ? `${ask.question.slice(0, 77)}...` : ask.question}`;
  const body = [
    `Work ticket: [${work.key}](${work.url})`,
    `**Question:** ${ask.question}`,
    `**Recommendation:** ${ask.recommendation}`,
    ...(ask.options.length ? [ask.options.map((o, i) => `${i + 1}. **${o.option}**. Pick this if ${o.pick_this_if}`).join('\n')] : []),
    ...(ask.context ? [`**Context:**\n\n${ask.context}`] : []),
    `Answer in a comment, then mark this issue Done. The runner resumes ${work.key}'s lead with your comments. Canceling this issue stops ${work.key} and hands it back.`,
  ];
  return { title, body: body.join('\n\n') };
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

export function renderStatus(w: Pick<Work, 'key' | 'dir' | 'branch'>, sessionId: string, host: string, state: string, detail = '') {
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
    ...(detail ? ['', detail] : []),
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
const tf = (w: Pick<Work, 'dir'>, n: number, name: string) => path.join(w.dir, '.runner', `turn-${n}`, name);
const sessionId = (w: Work) => readOr(rf(w, 'session-id'))?.trim() ?? '';
const proof = (w: Work) => (readOr(rf(w, 'PROOF.md')) ?? '').trim();
const brief = (w: Work) => `Issue ${w.key}: ${w.title}\n${w.url}\n\n${w.description}`;
/** The text in a Decision or stall issue's description that finds it again. Linear's relations are not used for this. */
export const marker = (kind: 'decision' | 'stall', key: string, turn: number) => `runner-${kind} ${key} turn ${turn} end`;

/** Turn folders in `.runner/`, oldest first. The newest is the live turn; every older one is consumed. */
export function turns(w: Pick<Work, 'dir'>): number[] {
  const dir = path.join(w.dir, '.runner');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => /^turn-(\d+)$/.exec(name)?.slice(1).map(Number) ?? []).sort((a, b) => a - b);
}
const newest = (w: Work) => turns(w).at(-1) ?? 0;

/**
 * Works out the next step for a ticket from what is true now, and changes nothing. A turn that ended is acted on
 * before Pi ever starts again, and Pi starts only for a newest turn with no exit, no ending and no live session.
 */
export async function observe(w: Work, live: boolean, decisionFor: (turn: number) => Promise<Decision | null>): Promise<Observation> {
  if (!existsSync(w.dir) || !sessionId(w)) return { kind: 'start' };
  if (live) return { kind: 'running' };
  const turn = newest(w);
  if (turn === 0) return { kind: 'start' };
  if (!existsSync(tf(w, turn, 'exit')) && !existsSync(tf(w, turn, 'ending.json'))) {
    return { kind: existsSync(tf(w, turn, 'launched')) ? 'relaunch' : 'launch', turn };
  }
  const decision = await decisionFor(turn);
  if (!decision) return { kind: 'consume', turn };
  if (decision.state === 'completed') return { kind: 'answer', turn, decision };
  if (decision.state === 'canceled') return { kind: 'stop', turn, decision };
  return { kind: 'waiting', turn, decision };
}

const hasVerify = (dir: string) => { try { accessSync(path.join(dir, '.agents', 'verify'), constants.X_OK); return true; } catch { return false; } };

async function verify(dir: string): Promise<{ ok: boolean; text: string }> {
  const { code, out } = await run(path.join(dir, '.agents', 'verify'), [], dir, STEP_TIMEOUT_MS);
  return { ok: code === 0, text: `.agents/verify exited ${code}\n${tail(out, 30)}` };
}

function parseFindings(file: string): Finding[] {
  const value = readJson<unknown>(file);
  const valid = Array.isArray(value) && value.every((f) =>
    typeof f?.must_fix === 'boolean' && typeof f.caused_by_change === 'boolean' &&
    ['where', 'what', 'done_when'].every((key) => typeof f[key] === 'string'));
  if (!valid) throw new Error(`review wrote no valid findings JSON to ${path.basename(path.dirname(file))}/${path.basename(file)}`);
  return value as Finding[];
}

const describe = (f: Finding) =>
  `- [${f.must_fix ? (f.caused_by_change ? 'must fix' : 'must fix, not caused by this change') : 'note'}] ${f.where}: ${f.what} Done when: ${f.done_when}`;
const blocking = (findings: Finding[]) => findings.filter((f) => f.must_fix && f.caused_by_change);

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
async function status(ctx: Ctx, w: Work, state: string, detail = '') {
  const body = renderStatus(w, sessionId(w), ctx.config.host, state, detail);
  const mine = (await ctx.linear.comments(w.id)).find((c) => c.user?.name === ctx.config.runnerUser && c.body.startsWith('**Runner:**'));
  if (mine) await ctx.linear.editComment(mine.id, body);
  else await ctx.linear.comment(w.id, body);
}

/** Posts a comment unless the runner already posted the same body. */
async function postOnce(ctx: Ctx, w: Work, body: string) {
  if (!(await ctx.linear.comments(w.id)).some((c) => c.user?.name === ctx.config.runnerUser && c.body === body)) await ctx.linear.comment(w.id, body);
}

/** Human comments newer than `.runner/delivered.json`, the last one the lead got. */
async function undelivered(ctx: Ctx, w: Work) {
  const delivered = readJson<{ id: string; createdAt: string }>(rf(w, 'delivered.json'));
  return (await ctx.linear.comments(w.id)).filter((c) => c.user?.name !== ctx.config.runnerUser && (!delivered || c.createdAt > delivered.createdAt));
}
const formatComments = (comments: Comment[]) =>
  comments.length ? `\n\nNew comments on the issue:\n${comments.map((c) => `- ${c.user?.name ?? 'unknown'}: ${c.body}`).join('\n')}` : '';
const endLine = (n: number) => `\n\nFor a change, update .runner/PROOF.md first. End this turn by writing .runner/turn-${n}/ending.json.`;
const lastOf = (comments: Comment[]) => { const c = comments.at(-1); return c ? { id: c.id, createdAt: c.createdAt } : undefined; };

/**
 * Makes the next turn: one folder with the input and its cause, built aside and renamed into place, so it
 * appears whole or not at all. The new folder makes the older turn consumed, so one cause never makes two turns.
 */
async function newTurn(ctx: Ctx, w: Work, cause: Cause, input: string) {
  const n = newest(w) + 1;
  const comments = await undelivered(ctx, w);
  const temp = rf(w, `.turn-${n}.${process.pid}.tmp`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp);
  put(path.join(temp, 'input.md'), `${input}${formatComments(comments)}${endLine(n)}`);
  put(path.join(temp, 'cause.json'), JSON.stringify({ ...cause, through: lastOf(comments) }));
  renameSync(temp, path.join(w.dir, '.runner', `turn-${n}`));
}

/** Starts the lead on turn `n` in a detached tmux session named for the ticket. Pi exits at the end of its turn (auto-exit). */
async function launch(ctx: Ctx, w: Work, n: number, restart: boolean) {
  put(tf(w, n, 'launched'), new Date().toISOString());
  let inputFile = tf(w, n, 'input.md');
  let through = readJson<Cause>(tf(w, n, 'cause.json'))?.through;
  if (restart) {
    // Pi stopped with the runner before the turn ended. Send the same turn again, with comments it may have missed.
    const comments = await undelivered(ctx, w);
    inputFile = tf(w, n, 'restart.md');
    put(inputFile, `${RESTART_NOTE}\n\n---\n\n${readFileSync(tf(w, n, 'input.md'), 'utf8')}${formatComments(comments)}`);
    through = lastOf(comments) ?? through;
  }
  for (const file of ['takeover', 'held']) rmSync(rf(w, file), { force: true });
  const pi = (...extra: string[]) => [bin('pi'), '--session-id', sessionId(w), '-e', AUTO_EXIT, '--model', w.models.lead, '--thinking', ctx.config.thinking,
    '--append-system-prompt', path.join(PROMPTS, 'lead.md'), ...extra].map(sh).join(' ');
  const keep = ['PI_AUTH_PROFILE', 'PI_CODING_AGENT_DIR'].filter((name) => process.env[name]).map((name) => `export ${name}=${sh(process.env[name]!)}`);
  put(rf(w, 'lead.sh'), [
    '#!/bin/sh',
    `cd ${sh(w.dir)} || exit 1`,
    `export PATH=${sh(process.env.PATH ?? '')}`,
    '# The tmux server keeps the environment of whoever started it. Drop Pi variables from another session.',
    "for v in $(env | sed -n 's/^\\(PI_[A-Z_]*\\)=.*/\\1/p; s/^\\(PSTACK_[A-Z_]*\\)=.*/\\1/p'); do unset \"$v\"; done",
    ...keep,
    `PI_SUBAGENT_AUTO_EXIT=1 PI_SUBAGENT_ID=${sh(w.key)} PI_SUBAGENT_ACTIVITY_FILE=${sh(rf(w, 'activity.json'))} ${pi(`@${inputFile}`)}`,
    'code=$?',
    '# A person who touched .runner/takeover keeps the session, without auto-exit, until they quit Pi.',
    `if [ -f .runner/takeover ] && [ ! -f .runner/turn-${n}/ending.json ]; then mv .runner/takeover .runner/held; ${pi()}; code=$?; rm -f .runner/held; fi`,
    `echo "$code" > .runner/turn-${n}/exit`,
    '',
  ].join('\n'));
  await status(ctx, w, 'Lead running');
  await run(bin('tmux'), ['kill-session', '-t', session(w.key)], w.dir);
  await must(bin('tmux'), ['new-session', '-d', '-s', w.key, '-x', '200', '-y', '50', '-c', w.dir, `sh ${sh(rf(w, 'lead.sh'))}`], w.dir);
  if (through) put(rf(w, 'delivered.json'), JSON.stringify(through));
}

const live = async (w: Pick<Work, 'key'>) => (await run(bin('tmux'), ['has-session', '-t', session(w.key)], process.cwd())).code === 0;

/** Pastes new comments into the running lead, and records them as delivered only after every tmux step succeeds. */
async function steer(ctx: Ctx, w: Work) {
  if (existsSync(rf(w, 'takeover')) || existsSync(rf(w, 'held'))) return;
  const comments = await undelivered(ctx, w);
  if (!comments.length) return;
  const text = comments.map((c) => `Comment from ${c.user?.name ?? 'unknown'} on ${w.key}:\n${c.body}`).join('\n\n');
  const buffer = `runner-${w.key}`;
  for (const args of [['set-buffer', '-b', buffer, '--', text], ['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane(w.key)], ['send-keys', '-t', pane(w.key), 'Enter']]) {
    if ((await run(bin('tmux'), args, w.dir)).code !== 0) return;
  }
  put(rf(w, 'delivered.json'), JSON.stringify(lastOf(comments)));
}

/** Minutes since the lead last did anything, from its activity file, or since the turn started. */
export function quietMinutes(w: Pick<Work, 'dir'>, turn: number, now = Date.now()) {
  let last = 0;
  try { last = statSync(tf(w, turn, 'launched')).mtimeMs; } catch { /* not launched */ }
  last = Math.max(last, readJson<{ updatedAt?: number }>(rf(w, 'activity.json'))?.updatedAt ?? 0);
  return last ? Math.floor((now - last) / 60000) : 0;
}

/** Flags a lead quiet for `stallMinutes`: a status line and one issue for Alex per turn. It does not stop the lead. */
async function checkStall(ctx: Ctx, w: Work, n: number) {
  if (existsSync(tf(w, n, 'stalled')) || existsSync(rf(w, 'held'))) return;
  const quiet = quietMinutes(w, n);
  if (quiet < ctx.config.stallMinutes) return;
  const c = commands(w, sessionId(w), ctx.config.host);
  await status(ctx, w, `Lead quiet for ${quiet} minutes. It still holds a slot.`);
  await ctx.linear.fileIssue(w.id, `Check ${w.key}: the lead looks stuck`, [
    `Work ticket: [${w.key}](${w.url})`,
    `The lead has shown no activity for ${quiet} minutes and still holds a lead slot.`,
    `Watch it with \`${c.watch}\`. If it is stuck, stop it with \`${c.stop}\`; the runner then starts the same turn again. Mark this issue Done when you have looked.`,
  ].join('\n\n'), marker('stall', w.key, n));
  put(tf(w, n, 'stalled'), String(quiet));
}

/** Waits until turn `n` exits. Meanwhile posts the start note, pastes comments, and watches for a stall. */
async function waitForLead(ctx: Ctx, w: Work, n: number) {
  for (;;) {
    await startNote(ctx, w);
    if (existsSync(tf(w, n, 'exit')) || !(await live(w))) break;
    await steer(ctx, w);
    await checkStall(ctx, w, n);
    await sleep(ctx.config.pollSeconds * 1000);
  }
  await run(bin('tmux'), ['kill-session', '-t', session(w.key)], w.dir);
}

/** Posts the lead's `.runner/start.md` once. */
async function startNote(ctx: Ctx, w: Work) {
  const note = readOr(rf(w, 'start.md'))?.trim();
  if (note) await postOnce(ctx, w, `Start note from the lead:\n\n${note}`);
}

async function step(ctx: Ctx, w: Work, name: string, prompt: 'review' | 'judge', input: string) {
  const args = ['-p', '--model', w.models.review, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, `${prompt}.md`), input];
  const { code, out } = await run(bin('pi'), args, w.dir, STEP_TIMEOUT_MS);
  writeFileSync(rf(w, `${name}.log`), out);
  if (code !== 0) throw new Error(`${name} step exited ${code}:\n${tail(out, 20)}`);
}

async function webhook(ctx: Ctx, w: Work, state: 'ready' | 'done' | 'needs-decision', pr: string | null = null) {
  const name = /^Report to:\s*(.+)$/im.exec(w.description)?.[1].trim();
  const hook = name ? ctx.config.webhooks[name] : undefined;
  if (!hook) return;
  try {
    const res = await ctx.fetchFn(hook.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readFileSync(hook.keyFile, 'utf8').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: w.key, url: w.url, state, pr }),
    });
    if (!res.ok) console.error(`${w.key}: webhook ${name} returned ${res.status}`);
  } catch (error) {
    console.error(`${w.key}: webhook ${name} failed`, error);
  }
}

/** Files turn `n`'s one Decision issue. Its marker finds it again, so a retry never files a second. */
async function decide(ctx: Ctx, w: Work, n: number, ask: Ask) {
  const { title, body } = renderDecision(w, ask);
  const issue = await ctx.linear.fileIssue(w.id, title, body, marker('decision', w.key, n));
  await status(ctx, w, `Waiting on [${issue.identifier}](${issue.url}). The lead has exited and holds no slot.`);
  await webhook(ctx, w, 'needs-decision');
}

/** Every saved review, oldest first, for the PR body and the judge. */
const reviewLog = (w: Work) => turns(w).flatMap((k) => {
  const r = readJson<Review>(tf(w, k, 'review.json'));
  return r ? [`Review round ${r.round}: ${r.findings.length} findings, ${blocking(r.findings).length} caused must-fix.`] : [];
});

async function ship(ctx: Ctx, w: Work, n: number, ending: Change) {
  const repo = ctx.config.repos[w.repo];
  const gh = bin('gh');
  // Find a PR an earlier, interrupted run opened before opening another.
  const prs = JSON.parse(await must(gh, ['pr', 'list', '--head', w.branch, '--state', 'all', '--json', 'url,state'], w.dir)) as { url: string; state: string }[];
  let pr = prs.find((p) => p.state === 'OPEN' || p.state === 'MERGED');
  if (pr?.state !== 'MERGED') {
    const body = [
      `Linear: [${w.key}](${w.url})`,
      `## Goal\n\n${w.title}\n\n${w.description}`,
      `## Proof\n\n${proof(w)}`,
      `## Review\n\n${reviewLog(w).join('\n')}\nVerify: ${hasVerify(w.dir) ? 'passed' : 'no .agents/verify; CI is the gate'}\nFull suite: ${ending.full_suite ? 'needed' : 'not needed'}. ${ending.full_suite_why}`,
    ].join('\n\n');
    writeFileSync(rf(w, 'pr.md'), body);
    await must('git', ['push', '--force', '-u', 'origin', w.branch], w.dir);
    if (pr) await must(gh, ['pr', 'edit', pr.url, '--body-file', '.runner/pr.md'], w.dir);
    else {
      const created = await must(gh, ['pr', 'create', '--base', repo.base, '--head', w.branch, '--title', `${w.key}: ${w.title}`, '--body-file', '.runner/pr.md'], w.dir);
      pr = { url: created.match(/https:\/\/\S+/g)?.at(-1) ?? created, state: 'OPEN' };
    }
    if (ending.full_suite && repo.fullSuiteLabel) await must(gh, ['pr', 'edit', pr.url, '--add-label', repo.fullSuiteLabel], w.dir);
  }
  let outcome = pr.state === 'MERGED' ? 'merged' : 'ready for review';
  if (repo.automerge && pr.state !== 'MERGED') {
    // Auto-merge waits for required checks. The runner never merges around them.
    const auto = await run(gh, ['pr', 'merge', pr.url, '--auto', '--squash'], w.dir);
    if (auto.code === 0) outcome = 'set to merge when its checks pass';
    else if (JSON.parse(await must(gh, ['pr', 'view', pr.url, '--json', 'state'], w.dir)).state === 'MERGED') outcome = 'merged';
    else {
      return decide(ctx, w, n, {
        question: `GitHub would not turn on auto-merge for ${pr.url}, and the runner does not merge around checks. How should it merge?`,
        recommendation: 'Turn on auto-merge for the repo, or merge the PR yourself once its checks pass. Then mark this issue Done.',
        options: [],
        context: tail(auto.out, 10),
      });
    }
  }
  await ctx.linear.update(w.id, 'In Review', true);
  await status(ctx, w, `PR ${outcome}: ${pr.url}`, reviewLog(w).join('\n'));
  await webhook(ctx, w, 'ready', pr.url);
}

/**
 * Commits, verifies and reviews turn `n`'s change. The review and the judge's verdict are saved per turn, so a
 * retry after a crash reuses them. Rounds count from the last turn Alex started (an answer or a new delegation).
 */
async function gate(ctx: Ctx, w: Work, n: number, ending: Change) {
  const repo = ctx.config.repos[w.repo];
  const base = `origin/${repo.base}`;
  const all = turns(w).filter((k) => k <= n);
  const since = all.filter((k) => ['answer', 'again'].includes(readJson<Cause>(tf(w, k, 'cause.json'))?.cause ?? '')).at(-1) ?? all[0];
  const window = all.filter((k) => k >= since);
  const reviews = window.filter((k) => k < n).flatMap((k) => readJson<Review>(tf(w, k, 'review.json')) ?? []);
  await must('git', ['add', '-A'], w.dir);
  if ((await run('git', ['diff', '--cached', '--quiet'], w.dir)).code !== 0) await must('git', ['commit', '-q', '-m', `${w.key}: ${n > 1 ? `turn ${n}` : w.title}`], w.dir);
  if ((await must('git', ['rev-list', '--count', `${base}..HEAD`], w.dir)) === '0') {
    return decide(ctx, w, n, { question: 'The lead ended with a change, but the branch has no commits. What next?', recommendation: 'Read PROOF.md in the worktree and tell the lead what to do.', options: [], context: proof(w) });
  }
  const verified = hasVerify(w.dir);
  if (!verified && !repo.ciGate) {
    return decide(ctx, w, n, {
      question: `${w.repo} has no executable .agents/verify, so the runner will not merge. How should this ship?`,
      recommendation: `Add .agents/verify to ${w.repo}, or set "ciGate": true for it in the runner config. Then mark this issue Done.`,
      options: [],
    });
  }
  const check = verified ? await verify(w.dir) : { ok: true, text: 'no .agents/verify; CI is the gate' };
  if (!check.ok) {
    put(tf(w, n, 'verify.txt'), check.text);
    if (window.filter((k) => existsSync(tf(w, k, 'verify.txt'))).length >= MAX_ROUNDS) {
      return decide(ctx, w, n, { question: `.agents/verify still fails after ${MAX_ROUNDS} tries. What next?`, recommendation: 'Read the output, then tell the lead what to change.', options: [], context: check.text });
    }
    await status(ctx, w, 'Verify failed; the lead is fixing it', check.text);
    return newTurn(ctx, w, { cause: 'verify' }, `.agents/verify failed. Fix the cause, update .runner/PROOF.md, and end again with a change ending.\n\n${check.text}`);
  }
  const round = reviews.length + 1;
  const previous = reviews.at(-1);
  let review = readJson<Review>(tf(w, n, 'review.json'));
  if (!review) {
    const scope = previous
      ? `Review only the latest fix: git diff ${previous.head}..HEAD\nIt was meant to fix these findings:\n${JSON.stringify(blocking(previous.findings), null, 2)}`
      : `Review the whole change: git diff ${base}...HEAD`;
    await status(ctx, w, `Review round ${round} running`);
    rmSync(tf(w, n, 'findings.json'), { force: true });
    await step(ctx, w, `review-${n}`, 'review', `${brief(w)}\n\nReview round ${round}. ${scope}\n\nVerify: ${check.text}\n\nWrite the findings to .runner/turn-${n}/findings.json.`);
    review = { round, head: await must('git', ['rev-parse', 'HEAD'], w.dir), findings: parseFindings(tf(w, n, 'findings.json')) };
    put(tf(w, n, 'review.json'), JSON.stringify(review));
  }
  const open = blocking(review.findings);
  await status(ctx, w, `Review round ${round} done`, [reviewLog(w).at(-1), ...review.findings.map(describe)].join('\n'));
  if (open.length === 0) return ship(ctx, w, n, ending);
  const findingsJson = JSON.stringify(open, null, 2);
  if (round < MAX_ROUNDS) {
    return newTurn(ctx, w, { cause: 'findings', round }, `Review round ${round} found problems your change caused. Fix each one and its whole class, update .runner/PROOF.md, and end again with a change ending.\n${findingsJson}`);
  }
  // The judge may cut scope or ask Alex. It can never ship with a caused must-fix open.
  // Its verdicts live beside the worktrees, out of the lead's worktree.
  const judgeDir = path.join(ctx.config.worktreeRoot, '.judge');
  if (window.some((k) => k < n && existsSync(path.join(judgeDir, `${w.key}-${k}.json`)))) {
    return decide(ctx, w, n, { question: 'Caused must-fix findings are still open after the judge cut the scope. Cut more, or stop?', recommendation: 'Read the findings and the branch, then tell the lead.', options: [], context: open.map(describe).join('\n') });
  }
  const verdictFile = path.join(judgeDir, `${w.key}-${n}.json`);
  let verdict = readJson<{ decision?: unknown; why?: unknown }>(verdictFile);
  if (!verdict) {
    mkdirSync(judgeDir, { recursive: true });
    await status(ctx, w, `Judge running after ${round} review rounds`);
    await step(ctx, w, `judge-${n}`, 'judge', `${brief(w)}\n\nDiff: git diff ${base}...HEAD\n\n${reviewLog(w).join('\n')}\n\nOpen findings this change caused:\n${findingsJson}\n\nWrite your verdict to ${verdictFile}.`);
    verdict = readJson(verdictFile) ?? {};
  }
  if (!['cut', 'ask'].includes(verdict.decision as string) || typeof verdict.why !== 'string') {
    rmSync(verdictFile, { force: true });
    throw new Error(`the judge wrote no valid verdict to ${verdictFile}; it may only pick "cut" or "ask"`);
  }
  if (verdict.decision === 'ask') {
    return decide(ctx, w, n, { question: `After ${round} review rounds, the judge asks for your call on the open findings.`, recommendation: verdict.why, options: [], context: open.map(describe).join('\n') });
  }
  return newTurn(ctx, w, { cause: 'cut', round }, `The judge read the open findings after ${round} review rounds and says cut scope: ${verdict.why}\n\nCut the scope so these findings no longer apply, update .runner/PROOF.md, and end again with a change ending. A fresh review round follows.\n${findingsJson}`);
}

/** Acts on turn `n`'s ending. Each action checks Linear or GitHub first, so running it twice does no harm. */
async function consume(ctx: Ctx, w: Work, n: number) {
  await startNote(ctx, w);
  const ending = readEnding(readOr(tf(w, n, 'exit'))?.trim() ?? null, readOr(tf(w, n, 'ending.json')), proof(w));
  if ('error' in ending) {
    return decide(ctx, w, n, {
      question: `The lead stopped without a valid ending: ${ending.error}. What should it do?`,
      recommendation: 'Watch or quiz the session, then answer with what the lead should do next. Marking this issue Done resumes it with your comments.',
      options: [],
    });
  }
  if (ending.kind === 'report') {
    await postOnce(ctx, w, ending.body);
    await ctx.linear.update(w.id, 'Done', true);
    await status(ctx, w, 'Done: the lead posted a report');
    return webhook(ctx, w, 'done');
  }
  if (ending.kind === 'decision') {
    const { kind: _, ...ask } = ending;
    return decide(ctx, w, n, ask);
  }
  return gate(ctx, w, n, ending);
}

/**
 * Creates or reuses the worktree, claims the ticket, and makes its first turn. A ticket delegated again gets a new
 * turn in the same session. False when it handed the ticket back.
 */
async function start(ctx: Ctx, w: Work, again: boolean) {
  try {
    await worktree(ctx.config.repos[w.repo], w);
  } catch (error) {
    await postOnce(ctx, w, `The runner could not start this ticket, so it handed it back.\n\n${message(error)}`);
    await ctx.linear.update(w.id, 'Todo', true);
    return false;
  }
  if (!sessionId(w)) put(rf(w, 'session-id'), randomUUID());
  await ctx.linear.update(w.id, 'In Progress');
  if (newest(w) === 0) await newTurn(ctx, w, { cause: 'task' }, brief(w));
  else if (again) await newTurn(ctx, w, { cause: 'again' }, `This ticket was delegated to you again.\n\n${brief(w)}\n\nCheck where the work stands in this worktree.`);
  return true;
}

/** Takes a ticket step by step until it waits on Alex, leaves In Progress, or has nothing new to do. */
async function drive(ctx: Ctx, w: Work, fromTodo = false) {
  try {
    if (fromTodo && !(await live(w)) && !(await start(ctx, w, true))) return;
  } catch (error) {
    return console.error(`${w.key}: start failed`, error);
  }
  for (;;) {
    const seen = await observe(w, await live(w), (n) => ctx.linear.findMarked(marker('decision', w.key, n)));
    try {
      switch (seen.kind) {
        case 'start':
          if (!(await start(ctx, w, false))) return;
          break;
        case 'launch':
        case 'relaunch':
          await launch(ctx, w, seen.turn, seen.kind === 'relaunch');
          break;
        case 'running':
          await waitForLead(ctx, w, newest(w));
          break;
        case 'consume':
          await consume(ctx, w, seen.turn);
          // A new turn means more work. Otherwise the ticket finished, shipped, or waits on its Decision issue.
          if (newest(w) === seen.turn) return;
          break;
        case 'answer': {
          const answers = await ctx.linear.comments(seen.decision.id);
          const replies = answers.length ? answers.map((c) => `- ${c.user?.name ?? 'unknown'}: ${c.body}`).join('\n') : 'No comments.';
          await newTurn(ctx, w, { cause: 'answer', decision: seen.decision.id }, `Your Decision issue ${seen.decision.identifier} (${seen.decision.url}) is Done. The comments on it:\n${replies}\n\nCarry on from here.`);
          break;
        }
        case 'stop':
          await postOnce(ctx, w, `${seen.decision.identifier} was canceled, so the runner stopped ${w.key} and handed it back. The worktree \`${w.dir}\` and branch \`${w.branch}\` stay. Delegate the ticket again to start a new lead turn on them.`);
          await ctx.linear.update(w.id, 'Todo', true);
          return;
        case 'waiting':
          return;
      }
    } catch (error) {
      if (seen.kind !== 'consume') return console.error(`${w.key}: ${seen.kind} failed; the next poll tries again`, error);
      try {
        await decide(ctx, w, seen.turn, {
          question: 'The runner hit an error on this ticket. What should happen?',
          recommendation: 'Fix the cause, then mark this issue Done. The runner resumes the lead with your comments.',
          options: [],
          context: message(error),
        });
      } catch (reportError) {
        console.error(`${w.key}: could not report failure`, error, reportError);
      }
      return;
    }
  }
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

export async function main(argv: string[], config: Config, fetchFn: typeof fetch = fetch) {
  const dryRun = argv.includes('--dry-run');
  const once = dryRun || argv.includes('--once');
  let said = new Set<string>();
  let next = new Set<string>();
  /** Logs a line once while it stays true, so a blocked queue does not repeat itself every poll. */
  const say = (line: string) => { if (!said.has(line)) console.log(line); next.add(line); };
  const ctx: Ctx = { config, linear: linearClient(config, fetchFn), fetchFn };
  const running = new Map<string, { work: Work; done: Promise<void> }>();
  const track = (w: Work, fromTodo = false) => running.set(w.id, { work: w, done: drive(ctx, w, fromTodo).finally(() => running.delete(w.id)) });
  if (dryRun) console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  for (;;) {
    try {
      const free = await freeMemory();
      const block = (w: Work) => startBlock({
        running: running.size, maxLeads: config.maxLeads, freeMemory: free, minFreeMemory: config.minFreeMemoryPercent,
        needsScreen: needsScreen(w.description), screenTaken: [...running.values()].some((r) => needsScreen(r.work.description)),
      });
      // Tickets already ours: reconcile each from Linear, tmux and its worktree.
      for (const issue of await ctx.linear.issues('In Progress')) {
        if (running.has(issue.id)) continue;
        const w = workFor(config, issue);
        if (!w) { say(`Skipping ${issue.identifier}: no repo label`); continue; }
        const seen = await observe(w, await live(w), (n) => ctx.linear.findMarked(marker('decision', w.key, n)));
        const needsSlot = ['start', 'launch', 'relaunch', 'answer'].includes(seen.kind);
        const reason = needsSlot ? block(w) : null;
        if (dryRun) console.log(`${w.key}: ${seen.kind}${reason ? ` (waits: ${reason})` : ''}`);
        else if (seen.kind === 'waiting') await ctx.linear.link(seen.decision, w.id);
        else if (reason) say(`Not continuing ${w.key} yet: ${reason}`);
        else track(w);
      }
      for (const issue of await ctx.linear.issues('Todo')) {
        if (running.has(issue.id)) continue;
        const w = workFor(config, issue);
        const reason = w && block(w);
        if (dryRun) {
          console.log(!w ? `Would skip ${issue.identifier}: no repo label` : reason ? `Would wait (${reason}): ${issue.identifier}` : `Would pick up ${issue.identifier} (${w.repo}): ${issue.title}`);
        } else if (!w) {
          await ctx.linear.comment(issue.id, `No repo label, so the runner skipped this. Add one of ${Object.keys(config.repos).join(', ')} and delegate it again.`);
          await ctx.linear.update(issue.id, null, true);
        } else if (reason) {
          say(`Not starting ${issue.identifier} yet: ${reason}`);
          if (!reason.includes('screen')) break;
        } else {
          track(w, true);
        }
      }
    } catch (error) {
      console.error('poll failed', error);
    }
    [said, next] = [next, new Set()];
    if (once) return void (await Promise.all([...running.values()].map((r) => r.done)));
    await sleep(config.pollSeconds * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), loadConfig(process.env.JOB_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'job-runner', 'config.json')));
}
