#!/usr/bin/env node
// review.ts <pr> --round <n> --trigger first|fix|rebase
// Runs one review round of the lead prompt's merge gate. It reads the PR head (and, for a rebase, the base it sits on),
// takes asked_by from $PI_SESSION_ID, gives the reviewer a new session id, runs it with `pi -p` and prompts/review.md,
// and waits. Then it finds that session's record on the PR, checks the record names the same head, session, round and
// asker, and prints it. Exit 0 on `verdict: clean`, 2 on `must-fix`, 1 when the record is missing or wrong, 64 on bad use.
// The ticket's key, title, description and review model come from the .runner/work.json the runner writes, found as
// `ticket.ts` finds it, so it works in a sub-lead's worktree too. JOB_RUNNER_PI replaces the pi binary, for tests.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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

const head = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'url,number,headRefOid,baseRefOid'])) as { url: string; number: number; headRefOid: string; baseRefOid: string };
const repo = head.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? fail(`not a GitHub PR url: ${head.url}`);
const fullTrigger = trigger === 'rebase'
  ? `rebase onto ${run('gh', ['api', `repos/${repo}/compare/${head.baseRefOid}...${head.headRefOid}`, '--jq', '.merge_base_commit.sha']).trim()}`
  : trigger;

const sessionId = randomUUID();
const name = `review ${work.key} PR ${head.number} round ${round}`;
const task = [
  `Review PR ${head.url} for ${work.key}, round ${round}, trigger ${fullTrigger}. Head commit: ${head.headRefOid}. asked_by: ${askedBy}. Goal: ${work.title} (${work.url}). Follow ${REVIEW_PROMPT}.`,
  '',
  'The ticket:',
  '',
  work.description,
].join('\n');
console.error(`review: ${name}, head ${head.headRefOid}, session ${sessionId}, model ${work.models.review}`);
const reviewer = spawnSync(process.env.JOB_RUNNER_PI || 'pi',
  ['-p', '--session-id', sessionId, '--name', name, '--model', work.models.review, '--append-system-prompt', REVIEW_PROMPT, task],
  { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
const said = () => `The reviewer exited ${reviewer.status ?? reviewer.signal} and said:\n${reviewer.stdout ?? String(reviewer.error)}`;

const reviews = (JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'reviews'])) as { reviews: { body: string }[] }).reviews;
const record = reviews.map((r) => r.body).filter((body) => body.startsWith('runner-review v1') && fields(body).session_id === sessionId).at(-1);
if (!record) fail(`no runner-review record with session_id ${sessionId} on ${head.url}. ${said()}`);
const got = fields(record);
const want = { head: head.headRefOid, round: String(round), trigger: fullTrigger, asked_by: askedBy };
const wrong = Object.entries(want).filter(([field, value]) => got[field] !== value);
if (wrong.length) fail(`the record does not match this round: ${wrong.map(([field, value]) => `${field} is ${got[field] ?? 'missing'}, not ${value}`).join('; ')}. Ask for a new round.\n\n${record}`);
console.log(record);
process.exit(got.verdict === 'clean' ? 0 : 2);
