import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  host: string;
  worktreeRoot: string;
  stateFile: string;
};
export type Finding = { must_fix: boolean; caused_by_change: boolean; where: string; what: string; done_when: string };
export type Ask = { question: string; recommendation: string; options: { option: string; pick_this_if: string }[]; context?: string };
export type Ending =
  | { kind: 'report'; body: string }
  | { kind: 'change'; full_suite: boolean; full_suite_why: string }
  | ({ kind: 'decision' } & Ask);
/** One ticket the runner owns. The runner saves these to `stateFile`, so a restart can resume them. */
export type Ticket = {
  id: string; key: string; title: string; url: string; description: string; repo: string; branch: string; dir: string;
  sessionId: string; models: { lead: string; review: string }; statusId?: string; seen: string[]; launches: number;
  startNote?: string; reviews: number; verifyFails: number; fixFrom?: string; open: Finding[]; judged: boolean; log: string[];
  pr?: string; decision?: { id: string; identifier: string; url: string };
};
type Issue = { id: string; identifier: string; title: string; description: string | null; url: string; createdAt: string; labels: { nodes: { name: string }[] } };
type Comment = { id: string; body: string; createdAt: string; user: { name: string } | null };
type Check = { ok: boolean; missing: boolean; text: string };
type Ctx = { config: Config; linear: ReturnType<typeof linearClient>; fetchFn: typeof fetch; tickets: Map<string, Ticket>; save: () => void };

const STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_ROUNDS = 3;
const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));
const AUTO_EXIT = fileURLToPath(new URL('../extensions/interactive-subagents/pi-extension/subagents/subagent-done.ts', import.meta.url));
const ISSUE_FIELDS = 'id identifier title description url createdAt labels { nodes { name } }';
const bin = (name: 'pi' | 'gh' | 'tmux' | 'memory_pressure') => process.env[`JOB_RUNNER_${name.toUpperCase()}`] ?? name;
const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** tmux matches `-t ALE-1` to `ALE-10` by prefix when `ALE-1` is gone. `=` asks for the exact name. */
const session = (key: string) => `=${key}`;
const pane = (key: string) => `=${key}:`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadConfig(file: string): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['linearTokenCommand', 'team', 'runnerUser', 'decisionAssignee', 'repos', 'models', 'worktreeRoot']) {
    if (!raw[key]) throw new Error(`${file}: missing "${key}"`);
  }
  if (!raw.models.lead || !raw.models.review) throw new Error(`${file}: "models" needs "lead" and "review"`);
  return {
    webhooks: {}, thinking: 'high', pollSeconds: 30, maxLeads: 2, minFreeMemoryPercent: 20, host: os.hostname().replace(/\.local$/, ''),
    stateFile: path.join(os.homedir(), '.config', 'job-runner', 'state.json'), ...raw,
  };
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
  return {
    async issues(state: string): Promise<Issue[]> {
      const data = await gql<{ issues: { nodes: Issue[] } }>(
        `query Issues($team: String!, $state: String!, $user: String!) { issues(first: 50, filter: { team: { key: { eq: $team } }, state: { name: { eq: $state } }, delegate: { name: { eq: $user } } }) { nodes { ${ISSUE_FIELDS} } } }`,
        { team: config.team, state, user: config.runnerUser },
      );
      return data.issues.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async stateType(id: string): Promise<string> {
      return (await gql<{ issue: { state: { type: string } } }>('query IssueState($id: String!) { issue(id: $id) { state { type } } }', { id })).issue.state.type;
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
    /** Files a Decision issue assigned to `decisionAssignee`, marked as blocking the work ticket. */
    async createDecision(workId: string, title: string, description: string) {
      if (!decisionIds) {
        const team = await gql<{ teams: { nodes: { id: string }[] } }>('query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: config.team });
        const user = await gql<{ users: { nodes: { id: string }[] } }>('query User($name: String!) { users(filter: { name: { eq: $name } }) { nodes { id } } }', { name: config.decisionAssignee });
        if (!team.teams.nodes[0] || !user.users.nodes[0]) throw new Error(`Linear has no team ${config.team} or no user ${config.decisionAssignee}`);
        decisionIds = { team: team.teams.nodes[0].id, assignee: user.users.nodes[0].id };
      }
      const data = await gql<{ issueCreate: { issue: { id: string; identifier: string; url: string } } }>(
        'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier url } } }',
        { input: { teamId: decisionIds.team, assigneeId: decisionIds.assignee, title, description } },
      );
      const issue = data.issueCreate.issue;
      await gql('mutation Relate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }', { input: { issueId: issue.id, relatedIssueId: workId, type: 'blocks' } });
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

export function renderDecision(work: { key: string; url: string }, ask: Ask) {
  const title = `Decision for ${work.key}: ${ask.question.length > 80 ? `${ask.question.slice(0, 77)}...` : ask.question}`;
  const body = [
    `Work ticket: [${work.key}](${work.url})`,
    `**Question:** ${ask.question}`,
    `**Recommendation:** ${ask.recommendation}`,
    ...(ask.options.length ? [ask.options.map((o, i) => `${i + 1}. **${o.option}**. Pick this if ${o.pick_this_if}`).join('\n')] : []),
    ...(ask.context ? [`**Context:**\n\n${ask.context}`] : []),
    `Answer in a comment, then close this issue. The runner resumes ${work.key}'s lead with your comments.`,
  ];
  return { title, body: body.join('\n\n') };
}

export function renderStatus(t: Pick<Ticket, 'key' | 'sessionId' | 'dir' | 'branch'>, host: string, state: string, detail = '') {
  const quiz = `${t.dir}-quiz`;
  return [
    `**Runner:** ${state}`,
    '',
    `- Host: ${host}`,
    `- tmux session: \`${t.key}\``,
    `- Session id: \`${t.sessionId}\``,
    `- Worktree: \`${t.dir}\` on \`${t.branch}\``,
    `- Watch or steer: \`ssh -t ${host} tmux attach -t ${t.key}\``,
    `- Take over (auto-exit stays off until you quit Pi): \`ssh -t ${host} 'touch ${t.dir}/.runner/takeover && tmux attach -t ${t.key}'\``,
    `- Quiz a fork: \`ssh -t ${host} 'cd ${t.dir} && git worktree add -B ${t.branch}-quiz ${quiz} HEAD && cd ${quiz} && tmux new -s ${t.key}-quiz pi --fork ${t.sessionId}'\``,
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

/** Waiting tickets whose Decision issue Alex has closed, as Done or Canceled. */
export const answered = (waiting: Ticket[], stateTypes: Map<string, string>) =>
  waiting.filter((t) => ['completed', 'canceled'].includes(stateTypes.get(t.id) ?? ''));

export async function verify(dir: string): Promise<Check> {
  const script = path.join(dir, '.agents', 'verify');
  try { accessSync(script, constants.X_OK); } catch { return { ok: false, missing: true, text: 'no executable .agents/verify' }; }
  const { code, out } = await run(script, [], dir, STEP_TIMEOUT_MS);
  return { ok: code === 0, missing: false, text: `.agents/verify exited ${code}\n${tail(out, 30)}` };
}

function parseFindings(file: string): Finding[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { value = undefined; }
  const valid = Array.isArray(value) && value.every((f) =>
    typeof f?.must_fix === 'boolean' && typeof f.caused_by_change === 'boolean' &&
    ['where', 'what', 'done_when'].every((key) => typeof f[key] === 'string'));
  if (!valid) throw new Error(`review wrote no valid findings JSON to ${path.basename(file)}`);
  return value as Finding[];
}

const describe = (f: Finding) =>
  `- [${f.must_fix ? (f.caused_by_change ? 'must fix' : 'must fix, not caused by this change') : 'note'}] ${f.where}: ${f.what} Done when: ${f.done_when}`;

const repoLocks = new Map<string, Promise<unknown>>();
/** Runs git setup for one repo at a time: two leads starting together would fight over `.git/config.lock`. */
function worktree(repo: Repo, branch: string, dir: string) {
  const next = (repoLocks.get(repo.path) ?? Promise.resolve()).catch(() => {}).then(() => makeWorktree(repo, branch, dir));
  repoLocks.set(repo.path, next);
  return next;
}

async function makeWorktree(repo: Repo, branch: string, dir: string) {
  await must('git', ['fetch', 'origin', repo.base], repo.path);
  if (existsSync(dir)) await must('git', ['worktree', 'remove', '--force', dir], repo.path);
  await must('git', ['worktree', 'prune'], repo.path);
  mkdirSync(path.dirname(dir), { recursive: true });
  await must('git', ['worktree', 'add', '-B', branch, dir, `origin/${repo.base}`], repo.path);
  const exclude = path.join(path.resolve(dir, await must('git', ['rev-parse', '--git-common-dir'], dir)), 'info', 'exclude');
  if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes('.runner/')) {
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, '\n.runner/\n');
  }
  mkdirSync(path.join(dir, '.runner'), { recursive: true });
}

const readOr = (file: string, fallback: string | null = null) => (existsSync(file) ? readFileSync(file, 'utf8') : fallback);
const proof = (dir: string) => (readOr(path.join(dir, '.runner', 'PROOF.md'), '') ?? '').trim();
const brief = (t: Ticket) => `Issue ${t.key}: ${t.title}\n${t.url}\n\n${t.description}`;

async function status(ctx: Ctx, t: Ticket, state: string, detail = '') {
  const body = renderStatus(t, ctx.config.host, state, detail);
  if (t.statusId) await ctx.linear.editComment(t.statusId, body);
  else { t.statusId = await ctx.linear.comment(t.id, body); t.seen.push(t.statusId); }
  ctx.save();
}

/** Human comments on the work ticket that no lead has seen yet. */
async function newComments(ctx: Ctx, t: Ticket): Promise<Comment[]> {
  const fresh = (await ctx.linear.comments(t.id)).filter((c) => !t.seen.includes(c.id));
  t.seen.push(...fresh.map((c) => c.id));
  ctx.save();
  return fresh.filter((c) => c.user?.name !== ctx.config.runnerUser);
}
const formatComments = (comments: Comment[]) =>
  comments.length ? `\n\nNew comments on the issue:\n${comments.map((c) => `- ${c.user?.name ?? 'unknown'}: ${c.body}`).join('\n')}` : '';

/** Starts the lead in a detached tmux session named for the ticket. Pi exits at the end of its turn (auto-exit). */
async function launch(ctx: Ctx, t: Ticket, input: string) {
  const runner = path.join(t.dir, '.runner');
  for (const file of ['ending.json', 'lead-exit', 'takeover']) rmSync(path.join(runner, file), { force: true });
  const inputFile = path.join(runner, `input-${++t.launches}.md`);
  writeFileSync(inputFile, input);
  ctx.save();
  const pi = (...extra: string[]) => [bin('pi'), '--session-id', t.sessionId, '-e', AUTO_EXIT, '--model', t.models.lead, '--thinking', ctx.config.thinking,
    '--append-system-prompt', path.join(PROMPTS, 'lead.md'), ...extra].map(sh).join(' ');
  const keep = ['PI_AUTH_PROFILE', 'PI_CODING_AGENT_DIR'].filter((name) => process.env[name]).map((name) => `export ${name}=${sh(process.env[name]!)}`);
  const script = [
    '#!/bin/sh',
    `cd ${sh(t.dir)} || exit 1`,
    `export PATH=${sh(process.env.PATH ?? '')}`,
    '# The tmux server keeps the environment of whoever started it. Drop Pi variables from another session.',
    "for v in $(env | sed -n 's/^\\(PI_[A-Z_]*\\)=.*/\\1/p; s/^\\(PSTACK_[A-Z_]*\\)=.*/\\1/p'); do unset \"$v\"; done",
    ...keep,
    `PI_SUBAGENT_AUTO_EXIT=1 PI_SUBAGENT_ID=${sh(t.key)} PI_SUBAGENT_ACTIVITY_FILE=${sh(path.join(runner, 'activity.json'))} ${pi(`@${inputFile}`)}`,
    'code=$?',
    '# A person who touched .runner/takeover keeps the session, without auto-exit, until they quit Pi.',
    `if [ -f .runner/takeover ] && [ ! -f .runner/ending.json ]; then rm -f .runner/takeover; ${pi()}; fi`,
    'echo "$code" > .runner/lead-exit',
    '',
  ].join('\n');
  writeFileSync(path.join(runner, 'lead.sh'), script, { mode: 0o755 });
  await run(bin('tmux'), ['kill-session', '-t', session(t.key)], t.dir);
  await must(bin('tmux'), ['new-session', '-d', '-s', t.key, '-x', '200', '-y', '50', '-c', t.dir, `sh ${sh(path.join(runner, 'lead.sh'))}`], t.dir);
}

/** Waits for the lead to exit. Meanwhile posts its start note and types new human comments into the session. */
async function waitForLead(ctx: Ctx, t: Ticket): Promise<string> {
  const exitFile = path.join(t.dir, '.runner', 'lead-exit');
  const postStartNote = async () => {
    const note = readOr(path.join(t.dir, '.runner', 'start.md'))?.trim();
    if (!note || note === t.startNote) return;
    t.startNote = note;
    t.seen.push(await ctx.linear.comment(t.id, `Start note from the lead:\n\n${note}`));
    ctx.save();
  };
  for (;;) {
    await postStartNote();
    if (existsSync(exitFile) || (await run(bin('tmux'), ['has-session', '-t', session(t.key)], t.dir)).code !== 0) break;
    if (!existsSync(path.join(t.dir, '.runner', 'takeover'))) {
      const fresh = await newComments(ctx, t);
      if (fresh.length) {
        const text = fresh.map((c) => `Comment from ${c.user?.name ?? 'unknown'} on ${t.key}:\n${c.body}`).join('\n\n');
        await run(bin('tmux'), ['set-buffer', '-b', `runner-${t.key}`, '--', text], t.dir);
        await run(bin('tmux'), ['paste-buffer', '-p', '-d', '-b', `runner-${t.key}`, '-t', pane(t.key)], t.dir);
        await run(bin('tmux'), ['send-keys', '-t', pane(t.key), 'Enter'], t.dir);
      }
    }
    await sleep(ctx.config.pollSeconds * 1000);
  }
  await run(bin('tmux'), ['kill-session', '-t', session(t.key)], t.dir);
  await postStartNote();
  return readOr(exitFile)?.trim() || 'unknown';
}

async function step(ctx: Ctx, t: Ticket, name: string, prompt: 'review' | 'judge', input: string) {
  const args = ['-p', '--model', t.models.review, '--thinking', ctx.config.thinking, '--append-system-prompt', path.join(PROMPTS, `${prompt}.md`), input];
  const { code, out } = await run(bin('pi'), args, t.dir, STEP_TIMEOUT_MS);
  writeFileSync(path.join(t.dir, '.runner', `${name}.log`), out);
  if (code !== 0) throw new Error(`${name} step exited ${code}:\n${tail(out, 20)}`);
}

async function webhook(ctx: Ctx, t: Ticket, state: 'ready' | 'done' | 'needs-decision') {
  const name = /^Report to:\s*(.+)$/im.exec(t.description)?.[1].trim();
  const hook = name ? ctx.config.webhooks[name] : undefined;
  if (!hook) return;
  try {
    const res = await ctx.fetchFn(hook.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readFileSync(hook.keyFile, 'utf8').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: t.key, url: t.url, state, pr: t.pr ?? null }),
    });
    if (!res.ok) console.error(`${t.key}: webhook ${name} returned ${res.status}`);
  } catch (error) {
    console.error(`${t.key}: webhook ${name} failed`, error);
  }
}

function finish(ctx: Ctx, t: Ticket) {
  ctx.tickets.delete(t.id);
  ctx.save();
}

/** Files a Decision issue and leaves the work ticket In Progress. The lead has exited, so the ticket holds no slot. */
async function decide(ctx: Ctx, t: Ticket, ask: Ask) {
  const { title, body } = renderDecision(t, ask);
  t.decision = await ctx.linear.createDecision(t.id, title, body);
  ctx.save();
  await status(ctx, t, `Waiting on [${t.decision.identifier}](${t.decision.url}). The lead has exited and holds no slot.`);
  await webhook(ctx, t, 'needs-decision');
}

async function ship(ctx: Ctx, t: Ticket, ending: { full_suite: boolean; full_suite_why: string }, check: Check, gaps: Finding[]) {
  const repo = ctx.config.repos[t.repo];
  const gh = bin('gh');
  const body = [
    `Linear: [${t.key}](${t.url})`,
    `## Goal\n\n${t.title}\n\n${t.description}`,
    `## Proof\n\n${proof(t.dir)}`,
    `## Review\n\n${t.log.join('\n')}\nVerify: ${check.missing ? 'no .agents/verify; CI is the gate' : check.text.split('\n')[0]}\nFull suite: ${ending.full_suite ? 'needed' : 'not needed'}. ${ending.full_suite_why}`,
    ...(gaps.length ? [`## Known gaps\n\nThe judge chose to ship with these open:\n${gaps.map(describe).join('\n')}`] : []),
  ].join('\n\n');
  writeFileSync(path.join(t.dir, '.runner', 'pr.md'), body);
  await must('git', ['push', '--force', '-u', 'origin', t.branch], t.dir);
  if (t.pr) await must(gh, ['pr', 'edit', t.pr, '--body-file', '.runner/pr.md'], t.dir);
  else {
    const created = await must(gh, ['pr', 'create', '--base', repo.base, '--head', t.branch, '--title', `${t.key}: ${t.title}`, '--body-file', '.runner/pr.md'], t.dir);
    t.pr = created.match(/https:\/\/\S+/g)?.at(-1) ?? created;
    ctx.save();
  }
  if (ending.full_suite && repo.fullSuiteLabel) await must(gh, ['pr', 'edit', t.pr, '--add-label', repo.fullSuiteLabel], t.dir);
  let outcome = 'ready for review';
  if (repo.automerge) {
    if ((await run(gh, ['pr', 'merge', t.pr, '--auto', '--squash'], t.dir)).code === 0) outcome = 'set to merge when its checks pass';
    else if (check.missing) {
      return decide(ctx, t, {
        question: `CI is the only gate for ${t.repo}, but auto-merge would not turn on for ${t.pr}. How should it merge?`,
        recommendation: 'Turn on auto-merge and required checks for the repo, or add .agents/verify, then close this issue.',
        options: [],
      });
    } else { await must(gh, ['pr', 'merge', t.pr, '--squash'], t.dir); outcome = 'merged'; }
  }
  await ctx.linear.update(t.id, 'In Review', true);
  await status(ctx, t, `PR ${outcome}: ${t.pr}`, t.log.join('\n'));
  finish(ctx, t);
  await webhook(ctx, t, 'ready');
}

/**
 * The gate for a change ending: commit, verify, review. Returns the message that resumes the lead
 * for another round, or null when the ticket shipped or waits on a Decision issue.
 */
async function gate(ctx: Ctx, t: Ticket, ending: { full_suite: boolean; full_suite_why: string }): Promise<string | null> {
  const repo = ctx.config.repos[t.repo];
  const base = `origin/${repo.base}`;
  await must('git', ['add', '-A'], t.dir);
  if ((await run('git', ['diff', '--cached', '--quiet'], t.dir)).code !== 0) await must('git', ['commit', '-q', '-m', `${t.key}: ${t.reviews ? `fix round ${t.reviews}` : t.title}`], t.dir);
  if ((await must('git', ['rev-list', '--count', `${base}..HEAD`], t.dir)) === '0') {
    await decide(ctx, t, { question: 'The lead ended with a change, but the branch has no commits. What next?', recommendation: 'Read PROOF.md in the worktree and tell the lead what to do.', options: [], context: proof(t.dir) });
    return null;
  }
  const check = await verify(t.dir);
  if (check.missing && !repo.ciGate) {
    await decide(ctx, t, {
      question: `${t.repo} has no executable .agents/verify, so the runner will not merge. How should this ship?`,
      recommendation: `Add .agents/verify to ${t.repo}, or set "ciGate": true for it in the runner config. Then close this issue.`,
      options: [],
    });
    return null;
  }
  if (!check.ok && !check.missing) {
    if (++t.verifyFails >= MAX_ROUNDS) {
      await decide(ctx, t, { question: `.agents/verify still fails after ${MAX_ROUNDS} tries. What next?`, recommendation: 'Read the output, then tell the lead what to change.', options: [], context: check.text });
      return null;
    }
    await status(ctx, t, 'Verify failed; the lead is fixing it', check.text);
    return `.agents/verify failed. Fix the cause, update .runner/PROOF.md, and end again with a change ending.\n\n${check.text}${formatComments(await newComments(ctx, t))}`;
  }
  const round = ++t.reviews;
  const scope = round === 1 || !t.fixFrom
    ? `Review the whole change: git diff ${base}...HEAD`
    : `Review only the latest fix: git diff ${t.fixFrom}..HEAD\nIt was meant to fix these findings:\n${JSON.stringify(t.open, null, 2)}`;
  await status(ctx, t, `Review round ${round} running`);
  await step(ctx, t, `review-${round}`, 'review', `${brief(t)}\n\nReview round ${round}. ${scope}\n\nVerify: ${check.missing ? 'no .agents/verify; CI is the gate' : check.text}\n\nWrite the findings to .runner/findings-${round}.json.`);
  const findings = parseFindings(path.join(t.dir, '.runner', `findings-${round}.json`));
  t.open = findings.filter((f) => f.must_fix && f.caused_by_change);
  t.log.push(`Review round ${round}: ${findings.length} findings, ${t.open.length} caused must-fix.`);
  await status(ctx, t, `Review round ${round} done`, [t.log.at(-1), ...findings.map(describe)].join('\n'));
  if (t.open.length === 0) { await ship(ctx, t, ending, check, []); return null; }
  const fixFrom = await must('git', ['rev-parse', 'HEAD'], t.dir);
  const findingsJson = JSON.stringify(t.open, null, 2);
  if (round >= MAX_ROUNDS) {
    if (t.judged) {
      await decide(ctx, t, { question: `Caused must-fix findings are still open after the judge's cut. Ship, cut more, or stop?`, recommendation: 'Read the findings and the draft branch, then tell the lead.', options: [], context: t.open.map(describe).join('\n') });
      return null;
    }
    t.judged = true;
    await status(ctx, t, `Judge running after ${round} review rounds`);
    rmSync(path.join(t.dir, '.runner', 'judge.json'), { force: true });
    await step(ctx, t, 'judge', 'judge', `${brief(t)}\n\nDiff: git diff ${base}...HEAD\n\n${t.log.join('\n')}\n\nOpen findings this change caused:\n${findingsJson}\n\nWrite .runner/judge.json.`);
    let verdict: { decision?: unknown; why?: unknown } = {};
    try { verdict = JSON.parse(readOr(path.join(t.dir, '.runner', 'judge.json'), '') ?? ''); } catch { /* checked below */ }
    if (!['ship', 'cut', 'ask'].includes(verdict.decision as string) || typeof verdict.why !== 'string') throw new Error('judge wrote no valid .runner/judge.json');
    t.log.push(`Judge: ${verdict.decision}. ${verdict.why}`);
    if (verdict.decision === 'ship') { await ship(ctx, t, ending, check, t.open); return null; }
    if (verdict.decision === 'ask') {
      await decide(ctx, t, { question: `After ${round} review rounds, the judge asks for your call on the open findings.`, recommendation: verdict.why, options: [], context: t.open.map(describe).join('\n') });
      return null;
    }
    t.fixFrom = fixFrom;
    ctx.save();
    return `The judge read the open findings after ${round} review rounds and says cut scope: ${verdict.why}\n\nCut the scope so these findings no longer apply, update .runner/PROOF.md, and end again with a change ending.\n${findingsJson}${formatComments(await newComments(ctx, t))}`;
  }
  t.fixFrom = fixFrom;
  ctx.save();
  return `Review round ${round} found problems your change caused. Fix each one and its whole class, update .runner/PROOF.md, and end again with a change ending.\n${findingsJson}${formatComments(await newComments(ctx, t))}`;
}

/** Runs the lead until the ticket ships, reports, or waits on a Decision issue. A null input waits on a lead that is already running. */
async function drive(ctx: Ctx, t: Ticket, input: string | null) {
  try {
    for (;;) {
      if (input !== null) {
        await status(ctx, t, 'Lead running');
        await launch(ctx, t, input);
      }
      const code = await waitForLead(ctx, t);
      const ending = parseEnding(readOr(path.join(t.dir, '.runner', 'ending.json')), proof(t.dir));
      if ('error' in ending) {
        await decide(ctx, t, {
          question: `The lead stopped without a valid ending: ${ending.error} (Pi exit code ${code}). What should it do?`,
          recommendation: 'Watch or quiz the session, then answer with what the lead should do next. Closing this issue resumes it with your comments.',
          options: [],
        });
        return;
      }
      if (ending.kind === 'report') {
        t.seen.push(await ctx.linear.comment(t.id, ending.body));
        await ctx.linear.update(t.id, 'Done', true);
        await status(ctx, t, 'Done: the lead posted a report');
        finish(ctx, t);
        await webhook(ctx, t, 'done');
        return;
      }
      if (ending.kind === 'decision') return void (await decide(ctx, t, ending));
      input = await gate(ctx, t, ending);
      if (input === null) return;
    }
  } catch (error) {
    try {
      await decide(ctx, t, {
        question: 'The runner hit an error on this ticket. What should happen?',
        recommendation: 'Fix the cause, then close this issue. The runner resumes the lead with your comments.',
        options: [],
        context: error instanceof Error ? error.message : String(error),
      });
    } catch (reportError) {
      console.error(`${t.key}: could not report failure`, error, reportError);
    }
  }
}

async function begin(ctx: Ctx, issue: Issue, label: string) {
  const description = issue.description ?? '';
  const line = (key: string) => new RegExp(`^${key}:\\s*(\\S+)`, 'im').exec(description)?.[1];
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  const branch = `job/${issue.identifier.toLowerCase()}-${slug}`;
  const t: Ticket = {
    id: issue.id, key: issue.identifier, title: issue.title, url: issue.url, description, repo: label, branch,
    dir: path.join(ctx.config.worktreeRoot, branch.replaceAll('/', '-')), sessionId: randomUUID(),
    models: { lead: line('(?:Lead|Implement) model') ?? ctx.config.models.lead, review: line('Review model') ?? ctx.config.models.review },
    seen: [], launches: 0, reviews: 0, verifyFails: 0, open: [], judged: false, log: [],
  };
  ctx.tickets.set(t.id, t);
  try {
    await worktree(ctx.config.repos[label], branch, t.dir);
    await ctx.linear.update(t.id, 'In Progress');
  } catch (error) {
    ctx.tickets.delete(t.id);
    ctx.save();
    await ctx.linear.comment(t.id, `The runner could not start this ticket, so it handed it back.\n\n${error instanceof Error ? error.message : String(error)}`);
    await ctx.linear.update(t.id, 'Todo', true);
    return;
  }
  await drive(ctx, t, `${brief(t)}${formatComments(await newComments(ctx, t))}`);
}

function loadState(file: string): Map<string, Ticket> {
  const saved = readOr(file);
  return new Map(saved ? (JSON.parse(saved).tickets as Ticket[]).map((t) => [t.id, t]) : []);
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
  const tickets = loadState(config.stateFile);
  const save = () => {
    if (dryRun) return;
    mkdirSync(path.dirname(config.stateFile), { recursive: true });
    writeFileSync(config.stateFile, `${JSON.stringify({ tickets: [...tickets.values()] }, null, 2)}\n`);
  };
  const ctx: Ctx = { config, linear: linearClient(config, fetchFn), fetchFn, tickets, save };
  const running = new Map<string, Promise<void>>();
  let said = new Set<string>();
  let next = new Set<string>();
  /** Logs a line once while it stays true, so a blocked queue does not repeat itself every poll. */
  const say = (line: string) => { if (!said.has(line)) console.log(line); next.add(line); };
  const track = (id: string, work: Promise<void>) => running.set(id, work.finally(() => running.delete(id)));
  if (dryRun) console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  try {
    for (const issue of await ctx.linear.issues('In Progress')) {
      const t = tickets.get(issue.id);
      if (t?.decision) continue;
      const live = t && (await run(bin('tmux'), ['has-session', '-t', session(t.key)], process.cwd())).code === 0;
      if (dryRun) {
        console.log(`${live ? 'Would wait on its live lead' : t ? 'Would resume its lead' : 'Would reset to Todo'}: ${issue.identifier} ${issue.title}`);
      } else if (live) {
        track(t.id, drive(ctx, t, null));
      } else if (t) {
        track(t.id, drive(ctx, t, `The runner restarted while you worked. Check where the work stands in this worktree, finish it, and end with .runner/ending.json.${formatComments(await newComments(ctx, t))}`));
      } else {
        await ctx.linear.update(issue.id, 'Todo');
        await ctx.linear.comment(issue.id, 'The runner restarted while this ticket ran and had no session to resume, so it went back to Todo.');
      }
    }
  } catch (error) {
    console.error('restart recovery failed', error);
  }
  for (;;) {
    try {
      const free = await freeMemory();
      const screenTaken = () => [...running.keys()].some((id) => needsScreen(tickets.get(id)?.description ?? ''));
      const block = (description: string) => startBlock({ running: running.size, maxLeads: config.maxLeads, freeMemory: free, minFreeMemory: config.minFreeMemoryPercent, needsScreen: needsScreen(description), screenTaken: screenTaken() });
      const waiting = [...tickets.values()].filter((t) => t.decision && !running.has(t.id));
      const stateTypes = new Map(await Promise.all(waiting.map(async (t) => [t.id, await ctx.linear.stateType(t.decision!.id)] as const)));
      for (const t of answered(waiting, stateTypes)) {
        const reason = block(t.description);
        if (dryRun || reason) { say(`${reason ? `Not resuming yet (${reason})` : 'Would resume'}: ${t.key}, answered in ${t.decision!.identifier}`); continue; }
        const decision = t.decision!;
        const answers = await ctx.linear.comments(decision.id);
        delete t.decision;
        save();
        const replies = answers.length ? answers.map((c) => `- ${c.user?.name ?? 'unknown'}: ${c.body}`).join('\n') : 'No comments.';
        track(t.id, drive(ctx, t, `Your Decision issue ${decision.identifier} (${decision.url}) is closed (${stateTypes.get(t.id)}). The comments on it:\n${replies}\n\nCarry on from here and end with .runner/ending.json.${formatComments(await newComments(ctx, t))}`));
      }
      for (const issue of await ctx.linear.issues('Todo')) {
        if (running.has(issue.id)) continue;
        const label = issue.labels.nodes.map((l) => l.name).find((name) => Object.hasOwn(config.repos, name));
        const reason = block(issue.description ?? '');
        if (dryRun) {
          console.log(!label ? `Would skip ${issue.identifier}: no repo label` : reason ? `Would wait (${reason}): ${issue.identifier}` : `Would pick up ${issue.identifier} (${label}): ${issue.title}`);
        } else if (!label) {
          await ctx.linear.comment(issue.id, `No repo label, so the runner skipped this. Add one of ${Object.keys(config.repos).join(', ')} and delegate it again.`);
          await ctx.linear.update(issue.id, null, true);
        } else if (reason) {
          say(`Not starting ${issue.identifier} yet: ${reason}`);
          if (!reason.includes('screen')) break;
        } else {
          track(issue.id, begin(ctx, issue, label));
        }
      }
    } catch (error) {
      console.error('poll failed', error);
    }
    [said, next] = [next, new Set()];
    if (once) return void (await Promise.all(running.values()));
    await sleep(config.pollSeconds * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), loadConfig(process.env.JOB_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'job-runner', 'config.json')));
}
