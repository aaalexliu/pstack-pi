#!/usr/bin/env node
// review.ts <pr> --round <n> --trigger first|fix|rebase
// Runs one review round of the lead prompt's merge gate. It reads the PR head and base (and, for a rebase, the merge base
// it sits on; for a later round, the head the last record reviewed), takes asked_by from $PI_SESSION_ID, gives the reviewer a new session id, runs it with `pi -p` and prompts/review.md,
// and waits. Then it finds that session's record on the PR, checks the record names the same head, session, round and
// asker, and prints it. Exit 0 on `verdict: clean`, 2 on `must-fix`, 1 when the record is missing or wrong, 64 on bad use.
// The ticket's key, title, description and review model come from the .runner/work.json the runner writes, found as
// `ticket.ts` finds it, so it works in a sub-lead's worktree too. When a `Fixes` line in the PR body names a sub-issue
// of the ticket, that sub-issue is the reviewer's goal, and the ticket and its other sub-issues are context only.
// JOB_RUNNER_PI replaces the pi binary, for tests.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { configFile, linearClient, loadConfig } from './runner.ts';
import { findWork } from './ticket.ts';

const REVIEW_PROMPT = path.join(import.meta.dirname, 'prompts', 'review.md');
const USAGE = 'usage: review.ts <pr url or number> --round <n> --trigger first|fix|rebase';

function fail(message: string, code = 1): never {
  console.error(`review: ${message}`);
  process.exit(code);
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || String(r.error)).trim()}`);
  return r.stdout;
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--round' || argv[i] === '--trigger') opts[argv[i].slice(2)] = argv[++i] ?? '';
    else rest.push(argv[i]);
  }
  const round = Number(opts.round);
  if (rest.length !== 1 || !Number.isInteger(round) || round < 1 || !['first', 'fix', 'rebase'].includes(opts.trigger)) fail(USAGE, 64);
  return { pr: rest[0], round, trigger: opts.trigger };
}

/** The record's header lines, up to the first blank line, as fields. */
function fields(body: string) {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    if (!line.trim()) break;
    const at = line.indexOf(': ');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 2).trim();
  }
  return out;
}

const { pr, round, trigger } = parseArgs(process.argv.slice(2));
const askedBy = process.env.PI_SESSION_ID;
if (!askedBy) fail('PI_SESSION_ID is not set; run this from the lead or sub-lead Pi session that asks for the review', 64);

let work: ReturnType<typeof findWork>;
try {
  work = findWork(process.cwd());
} catch (error) {
  fail((error as Error).message);
}

/** The runner-review records on the PR, oldest first. */
function records() {
  const { reviews } = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'reviews'])) as { reviews: { body: string }[] };
  return reviews.map((r) => r.body).filter((body) => body.startsWith('runner-review v1'));
}

const head = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'url,number,headRefOid,baseRefOid,body'])) as { url: string; number: number; headRefOid: string; baseRefOid: string; body: string };
const repo = head.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? fail(`not a GitHub PR url: ${head.url}`);
const fullTrigger = trigger === 'rebase'
  ? `rebase onto ${run('gh', ['api', `repos/${repo}/compare/${head.baseRefOid}...${head.headRefOid}`, '--jq', '.merge_base_commit.sha']).trim()}`
  : trigger;

// A lead's PR says `Fixes <sub-issue key>`, plain or as a Markdown link, and the last one also `Fixes <ticket key>`.
const fixed = [...head.body.matchAll(/^Fixes:? +\[?([A-Z][A-Z0-9]*-\d+)\b/gim)].map((m) => m[1].toUpperCase()).filter((key) => key !== work.key);
type SubIssue = { identifier: string; title: string; url: string; description: string | null; state: { name: string; type: string } };
let subIssues: SubIssue[] = [];
if (fixed.length) {
  try {
    const { issue } = await linearClient(loadConfig(configFile()), fetch).gql<{ issue: { children: { nodes: SubIssue[] } } }>(
      'query SubIssues($id: String!) { issue(id: $id) { children(first: 100) { nodes { identifier title url description state { name type } } } } }', { id: work.id });
    subIssues = issue.children.nodes;
  } catch (error) {
    fail(`could not read ${work.key}'s sub-issues from Linear: ${(error as Error).message}`);
  }
}
const goals = subIssues.filter((s) => fixed.includes(s.identifier));
const strays = fixed.filter((key) => !goals.some((s) => s.identifier === key));
if (strays.length) console.error(`review: ${strays.join(', ')} ${strays.length > 1 ? 'are not sub-issues' : 'is not a sub-issue'} of ${work.key}; ${goals.length ? 'leaving it out of the goal' : 'the goal is the ticket'}`);
// A canceled sub-issue owns no work, so it is not a sibling the reviewer must leave alone.
const siblings = subIssues.filter((s) => !goals.includes(s) && s.state.type !== 'canceled');
const section = (s: SubIssue) => [`${s.identifier} (${s.state.name}): ${s.title} (${s.url})`, '', s.description ?? ''];

const sessionId = randomUUID();
const name = `review ${work.key} PR ${head.number} round ${round}`;
// The reviewer reads the diff file by file against the base, and a later round starts from the last head reviewed.
const lastHead = round > 1 ? records().map((body) => fields(body).head).filter(Boolean).at(-1) : undefined;
const facts = `round ${round}, trigger ${fullTrigger}. Head commit: ${head.headRefOid}. asked_by: ${askedBy}. Base commit: ${head.baseRefOid}.${lastHead ? ` Last reviewed head: ${lastHead}.` : ''}`;
const task = (goals.length ? [
  `Review PR ${head.url} for ${goals.map((s) => s.identifier).join(' and ')}, part of ${work.key}, ${facts} Goal: ${goals.map((s) => `${s.title} (${s.url})`).join('; ')}. Follow ${REVIEW_PROMPT}.`,
  '',
  `The goal, the sub-issue${goals.length > 1 ? 's' : ''} this PR fixes:`,
  ...goals.flatMap((s) => ['', ...section(s)]),
  '',
  `The parent ticket, context only: ${work.key}: ${work.title} (${work.url})`,
  '',
  work.description,
  '',
  `${work.key}'s other sub-issues, whose work belongs to other PRs:`,
  ...(siblings.length ? siblings.flatMap((s) => ['', ...section(s)]) : ['', 'none']),
] : [
  `Review PR ${head.url} for ${work.key}, ${facts} Goal: ${work.title} (${work.url}). Follow ${REVIEW_PROMPT}.`,
  '',
  'The ticket:',
  '',
  work.description,
]).join('\n');
console.error(`review: ${name}, head ${head.headRefOid}, session ${sessionId}, model ${work.models.review}`);
const reviewer = spawnSync(process.env.JOB_RUNNER_PI || 'pi',
  ['-p', '--session-id', sessionId, '--name', name, '--model', work.models.review, '--append-system-prompt', REVIEW_PROMPT, task],
  { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
const said = () => `The reviewer exited ${reviewer.status ?? reviewer.signal} and said:\n${reviewer.stdout ?? String(reviewer.error)}`;

const record = records().filter((body) => fields(body).session_id === sessionId).at(-1);
if (!record) fail(`no runner-review record with session_id ${sessionId} on ${head.url}. ${said()}`);
const got = fields(record);
const want = { head: head.headRefOid, round: String(round), trigger: fullTrigger, asked_by: askedBy };
const wrong = Object.entries(want).filter(([field, value]) => got[field] !== value);
if (wrong.length) fail(`the record does not match this round: ${wrong.map(([field, value]) => `${field} is ${got[field] ?? 'missing'}, not ${value}`).join('; ')}. Ask for a new round.\n\n${record}`);
console.log(record);
process.exit(got.verdict === 'clean' ? 0 : 2);
