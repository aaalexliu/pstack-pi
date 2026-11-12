import { spawn } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Repo = { path: string; base: string; automerge: boolean };
export type Config = {
  linearTokenCommand: string;
  team: string;
  runnerUser: string;
  repos: Record<string, Repo>;
  webhooks: Record<string, { url: string; keyFile: string }>;
  models: { implement: string; review: string };
  thinking: string;
  pollSeconds: number;
  slots: number;
  worktreeRoot: string;
};
export type Finding = { must_fix: boolean; caused_by_change: boolean; where: string; what: string; done_when: string };
type Issue = { id: string; identifier: string; title: string; description: string | null; url: string; createdAt: string; labels: { nodes: { name: string }[] } };
type Comment = { id: string; body: string; createdAt: string; user: { name: string } | null };
type Check = { ok: boolean; text: string };
type Linear = ReturnType<typeof linearClient>;

const STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));
const ISSUE_FIELDS = 'id identifier title description url createdAt labels { nodes { name } }';

export function loadConfig(file: string): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['linearTokenCommand', 'team', 'runnerUser', 'repos', 'models', 'worktreeRoot']) {
    if (!raw[key]) throw new Error(`${file}: missing "${key}"`);
  }
  return { webhooks: {}, thinking: 'high', pollSeconds: 30, slots: 1, ...raw };
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
    async comments(id: string): Promise<Comment[]> {
      const data = await gql<{ issue: { comments: { nodes: Comment[] } } }>(
        'query Comments($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body createdAt user { name } } } } }',
        { id },
      );
      return data.issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
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

async function worktree(repo: Repo, branch: string, dir: string) {
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

async function commit(dir: string, message: string) {
  await must('git', ['add', '-A'], dir);
  if ((await run('git', ['diff', '--cached', '--quiet'], dir)).code !== 0) await must('git', ['commit', '-q', '-m', message], dir);
}

async function verify(dir: string): Promise<Check> {
  const script = path.join(dir, '.agents', 'verify');
  try { accessSync(script, constants.X_OK); } catch { return { ok: true, text: 'no .agents/verify' }; }
  const { code, out } = await run(script, [], dir, STEP_TIMEOUT_MS);
  return { ok: code === 0, text: `.agents/verify exited ${code}\n${tail(out, 30)}` };
}

const proof = (dir: string) => {
  const file = path.join(dir, '.runner', 'PROOF.md');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
};

async function runJob(issue: Issue, repo: Repo, config: Config, linear: Linear, fetchFn: typeof fetch) {
  const description = issue.description ?? '';
  const rounds = Math.max(1, Number(/^Rounds:\s*(\d+)/im.exec(description)?.[1] ?? 1));
  const reportTo = /^Report to:\s*(.+)$/im.exec(description)?.[1].trim();
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  const branch = `job/${issue.identifier.toLowerCase()}-${slug}`;
  const dir = path.join(config.worktreeRoot, branch.replaceAll('/', '-'));
  const brief = `Issue ${issue.identifier}: ${issue.title}\n${issue.url}\n\n${description}`;
  const gh = process.env.JOB_RUNNER_GH ?? 'gh';
  const seen = new Set<string>();
  const say = async (body: string) => { seen.add(await linear.comment(issue.id, body)); };
  const newComments = async () => {
    const fresh = (await linear.comments(issue.id)).filter((c) => !seen.has(c.id));
    for (const c of fresh) seen.add(c.id);
    return fresh.length ? `\n\nNew comments on the issue:\n${fresh.map((c) => `- ${c.user?.name ?? 'unknown'}: ${c.body}`).join('\n')}` : '';
  };
  const pi = async (step: string, prompt: 'implement' | 'review', model: string, input: string) => {
    const args = ['-p', '--model', model, '--thinking', config.thinking, '--append-system-prompt', path.join(PROMPTS, `${prompt}.md`), input];
    const { code, out } = await run(process.env.JOB_RUNNER_PI ?? 'pi', args, dir, STEP_TIMEOUT_MS);
    writeFileSync(path.join(dir, '.runner', `${step}.log`), out);
    if (code !== 0) throw new Error(`${step} step exited ${code}:\n${tail(out, 20)}`);
  };
  let state: 'ready' | 'needs-decision' = 'needs-decision';
  let pr: string | null = null;
  try {
    await linear.update(issue.id, 'In Progress');
    await say(`Picked up by ${os.hostname()} on branch \`${branch}\`.`);
    await worktree(repo, branch, dir);
    const base = `origin/${repo.base}`;
    await pi('implement', 'implement', config.models.implement, `${brief}${await newComments()}`);
    await commit(dir, `${issue.identifier}: implement`);
    if ((await must('git', ['rev-list', '--count', `${base}..HEAD`], dir)) === '0') {
      throw new Error(`implement made no change.\n\n${proof(dir) || 'No PROOF.md.'}`);
    }
    let check = await verify(dir);
    let open: Finding[] = [];
    let fixFrom = '';
    const log: string[] = [];
    for (let round = 1; round <= rounds; round++) {
      const scope = round === 1
        ? `Review the whole change: git diff ${base}...HEAD`
        : `Review only the latest fix: git diff ${fixFrom}..HEAD\nIt was meant to fix these findings:\n${JSON.stringify(open, null, 2)}`;
      await pi(`review-${round}`, 'review', config.models.review, `${brief}\n\nReview round ${round} of ${rounds}. ${scope}\n\nVerify: ${check.text}\n\nWrite the findings to .runner/findings-${round}.json.${await newComments()}`);
      const findings = parseFindings(path.join(dir, '.runner', `findings-${round}.json`));
      open = findings.filter((f) => f.must_fix && f.caused_by_change);
      log.push(`Review round ${round}: ${findings.length} findings, ${open.length} caused must-fix.`);
      await say([log.at(-1), ...findings.map(describe)].join('\n'));
      if (open.length === 0 || (round === rounds && rounds > 1)) break;
      fixFrom = await must('git', ['rev-parse', 'HEAD'], dir);
      const failed = check.ok ? '' : `\n\nVerify failed:\n${check.text}`;
      await pi(`fix-${round}`, 'implement', config.models.implement, `${brief}\n\nFix round ${round}. A reviewer found these problems your change caused. Fix each one and its whole class, then update .runner/PROOF.md.\n${JSON.stringify(open, null, 2)}${failed}${await newComments()}`);
      await commit(dir, `${issue.identifier}: fix round ${round}`);
      check = await verify(dir);
      // Rounds: 1 trusts its one fix once verify passes. Longer jobs review every fix and stop at the cap.
      if (rounds === 1) open = [];
    }
    const clean = open.length === 0 && check.ok;
    const body = [`Linear: [${issue.identifier}](${issue.url})`, `## Goal\n\n${issue.title}\n\n${description}`, `## Proof\n\n${proof(dir) || 'No PROOF.md.'}`, `## Review\n\n${log.join('\n')}\nVerify: ${check.text.split('\n')[0]}`].join('\n\n');
    writeFileSync(path.join(dir, '.runner', 'pr.md'), body);
    await must('git', ['push', '--force', '-u', 'origin', branch], dir);
    const created = await must(gh, ['pr', 'create', '--base', repo.base, '--head', branch, '--title', `${issue.identifier}: ${issue.title}`, '--body-file', '.runner/pr.md', ...(clean ? [] : ['--draft'])], dir);
    pr = created.match(/https:\/\/\S+/g)?.at(-1) ?? created;
    if (clean && repo.automerge && (await run(gh, ['pr', 'merge', pr, '--auto', '--squash'], dir)).code !== 0) {
      await must(gh, ['pr', 'merge', pr, '--squash'], dir);
    }
    await linear.update(issue.id, 'In Review', true);
    if (clean) {
      state = 'ready';
      await say(`PR ${repo.automerge ? 'set to merge' : 'ready for review'}: ${pr}\n\n${log.join('\n')}\nVerify: ${check.text.split('\n')[0]}`);
    } else {
      const reasons = [
        ...(open.length ? [`${open.length} caused must-fix findings still open after ${rounds} review rounds:\n${open.map(describe).join('\n')}`] : []),
        ...(check.ok ? [] : [`Verify failed:\n${check.text}`]),
      ];
      await say(`Needs decision: draft PR ${pr}\n\n${reasons.join('\n\n')}`);
    }
  } catch (error) {
    try {
      await say(`Needs decision: the job failed. ${error instanceof Error ? error.message : String(error)}\n\nWorktree: ${dir}`);
      await linear.update(issue.id, 'In Review', true);
    } catch (reportError) {
      console.error(`${issue.identifier}: could not report failure`, reportError);
    }
  }
  const hook = reportTo ? config.webhooks[reportTo] : undefined;
  if (!hook) return;
  try {
    const res = await fetchFn(hook.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readFileSync(hook.keyFile, 'utf8').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: issue.identifier, url: issue.url, state, pr }),
    });
    if (!res.ok) console.error(`${issue.identifier}: webhook ${reportTo} returned ${res.status}`);
  } catch (error) {
    console.error(`${issue.identifier}: webhook ${reportTo} failed`, error);
  }
}

export async function main(argv: string[], config: Config, fetchFn: typeof fetch = fetch) {
  const dryRun = argv.includes('--dry-run');
  const once = dryRun || argv.includes('--once');
  const linear = linearClient(config, fetchFn);
  const running = new Map<string, Promise<void>>();
  if (dryRun) console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  try {
    for (const issue of await linear.issues('In Progress')) {
      if (dryRun) { console.log(`Would reset to Todo: ${issue.identifier} ${issue.title}`); continue; }
      await linear.update(issue.id, 'Todo');
      await linear.comment(issue.id, 'The runner restarted while this job ran, so it went back to Todo.');
    }
  } catch (error) {
    console.error('restart reset failed', error);
  }
  for (;;) {
    try {
      for (const issue of await linear.issues('Todo')) {
        if (running.size >= config.slots) break;
        if (running.has(issue.id)) continue;
        const label = issue.labels.nodes.map((l) => l.name).find((name) => Object.hasOwn(config.repos, name));
        if (dryRun) {
          console.log(label ? `Would pick up ${issue.identifier} (${label}): ${issue.title}` : `Would skip ${issue.identifier}: no repo label`);
        } else if (!label) {
          await linear.comment(issue.id, `No repo label, so the runner skipped this. Add one of ${Object.keys(config.repos).join(', ')} and delegate it again.`);
          await linear.update(issue.id, null, true);
        } else {
          running.set(issue.id, runJob(issue, config.repos[label], config, linear, fetchFn).finally(() => running.delete(issue.id)));
        }
      }
    } catch (error) {
      console.error('poll failed', error);
    }
    if (once) return void (await Promise.all(running.values()));
    await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), loadConfig(process.env.JOB_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'job-runner', 'config.json')));
}
