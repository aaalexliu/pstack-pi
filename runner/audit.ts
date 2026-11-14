// Flags merged PRs for runner tickets that skipped the merge gate in prompts/lead.md. It reports; it enforces nothing.
// Usage: node runner/audit.ts <owner/repo>... [--limit 100]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './runner.ts';

export type Pr = {
  number: number; url: string; body: string; headRefOid: string; mergedAt: string;
  reviews: { body: string; submittedAt: string }[];
  statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string }[];
};
export type Record = { [field: string]: string };

/** The fields of a `runner-review v1` record, or null when the body is not one. */
export function parseRecord(body: string): Record | null {
  const lines = body.trim().split('\n');
  if (lines[0]?.trim() !== 'runner-review v1') return null;
  const fields: Record = {};
  for (const line of lines.slice(1)) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) break;
    fields[m[1]] = m[2].trim();
  }
  return fields;
}

/** The ticket keys a PR body names with `Fixes KEY` or `Part of KEY`. */
export const ticketsOf = (body: string, team: string) =>
  [...body.matchAll(new RegExp(`\\b(?:Fixes|Part of)\\s+(${team}-\\d+)\\b`, 'gi'))].map((m) => m[1].toUpperCase());

const RED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** Every way a merged PR broke the gate. `hasDecision` says whether its ticket has a Decision sub-issue. */
export function flags(pr: Pr, hasDecision: boolean, fileExists: (file: string) => boolean = existsSync): string[] {
  const records = pr.reviews.flatMap((r) => { const f = parseRecord(r.body); return f ? [{ ...r, f }] : []; })
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const before = records.filter((r) => r.submittedAt <= pr.mergedAt);
  const out: string[] = [];
  if (!records.length) out.push('no runner-review record');
  else if (before.length < records.length) out.push('newest runner-review record came after the merge');
  const last = before.at(-1)?.f;
  if (last) {
    if (last.head !== pr.headRefOid) out.push(`record head ${last.head?.slice(0, 12)} is not the merged head ${pr.headRefOid.slice(0, 12)}`);
    if (Number(last.caused_must_fix) > 0 || last.verdict !== 'clean') out.push(`merged over ${last.caused_must_fix} caused must-fix (verdict ${last.verdict})`);
    if (!last.session_id || last.session_id === last.asked_by) out.push('reviewer session is the lead session');
    if (!last.session_path || !fileExists(last.session_path)) out.push(`no session file at ${last.session_path || '(none)'}`);
    if (Number(last.round) > 3 && !hasDecision) out.push(`round ${last.round} with no Decision sub-issue`);
  }
  const red = pr.statusCheckRollup.filter((c) => RED.has(c.conclusion ?? c.state ?? ''));
  if (red.length) out.push(`red at merge: ${red.map((c) => c.name ?? c.context).join(', ')}`);
  return out;
}

async function decisionKeys(config: Config, keys: string[]): Promise<Set<string>> {
  const token = execFileSync('/bin/sh', ['-c', config.linearTokenCommand], { encoding: 'utf8' }).trim();
  const has = new Set<string>();
  for (const key of keys) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query($id:String!){issue(id:$id){children{nodes{assignee{name}}}}}', variables: { id: key } }),
    });
    const body = (await res.json()) as { data?: { issue: { children: { nodes: { assignee: { name: string } | null }[] } } | null } };
    if (body.data?.issue?.children.nodes.some((c) => c.assignee?.name === config.decisionAssignee)) has.add(key);
  }
  return has;
}

async function main(argv: string[]) {
  const config = loadConfig(process.env.JOB_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'job-runner', 'config.json'));
  const limit = argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : '100';
  const repos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--limit');
  let flagged = 0;
  for (const repo of repos) {
    const prs = (JSON.parse(execFileSync('gh', ['pr', 'list', '-R', repo, '--state', 'merged', '--limit', limit,
      '--json', 'number,url,body,headRefOid,mergedAt,reviews,statusCheckRollup'], { encoding: 'utf8' })) as Pr[])
      .filter((pr) => ticketsOf(pr.body, config.team).length);
    const withDecision = await decisionKeys(config, [...new Set(prs.flatMap((pr) => ticketsOf(pr.body, config.team)))]);
    for (const pr of prs) {
      const found = flags(pr, ticketsOf(pr.body, config.team).some((k) => withDecision.has(k)));
      console.log(`${found.length ? 'FLAG' : 'ok  '} ${pr.url} (${ticketsOf(pr.body, config.team).join(', ')})${found.map((f) => `\n     - ${f}`).join('')}`);
      if (found.length) flagged++;
    }
  }
  process.exitCode = flagged ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
