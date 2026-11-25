#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile, linearClient, loadConfig, type Config, type Work } from './runner.ts';

const USAGE = `usage: ticket show [SUB-ISSUE KEY]
       ticket comment <file> [COMMENT ID]
       ticket sub-issue <title> <file>
       ticket done [SUB-ISSUE KEY]
       ticket cancel <SUB-ISSUE KEY> <file>
       ticket ask <file>
       ticket label <repo label>
A <file> of - reads standard input.`;

class Usage extends Error {}

type Shown = {
  identifier: string; title: string; url: string; description: string | null; state: { name: string }; assignee: { name: string } | null;
  comments: { nodes: { id: string; createdAt: string; body: string; user: { name: string } | null; botActor: { name: string } | null }[]; pageInfo: { hasNextPage: boolean } };
  children: { nodes: { id: string; identifier: string; title: string; state: { name: string }; assignee: { name: string } | null }[] };
};

/**
 * The ticket the runner started this lead for: `.runner/work.json` in `cwd` or the nearest folder above it. A sub-lead's
 * worktree is the lead's path plus `-<sub-issue key>`, so each folder also tries the folders its name extends, longest first.
 */
export function findWork(cwd: string): Work {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const name = path.basename(dir);
    const leads = [...name.matchAll(/-/g)].reverse().map((dash) => path.join(path.dirname(dir), name.slice(0, dash.index)));
    const file = [dir, ...leads].map((folder) => path.join(folder, '.runner', 'work.json')).find((f) => existsSync(f));
    if (file) return JSON.parse(readFileSync(file, 'utf8'));
    if (dir === path.dirname(dir)) throw new Error(`no .runner/work.json in ${cwd} or above it; run this in the worktree the runner, or your lead, started you in`);
  }
}

/** A Linear time in this Mac's time zone, with its name: `Nov 17, 6:18 PM EST`. */
const local = (at: string) => new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/**
 * The lead's Linear commands for its own ticket. They go through the runner's Linear client, so a lead asks Alex
 * exactly as the runner does: assign him, then comment. Returns what to print.
 */
export async function ticket(argv: string[], o: { cwd: string; config?: Config; fetchFn?: typeof fetch; stdin?: () => string }): Promise<string> {
  const [command, ...args] = argv;
  const arity: Record<string, number[]> = { show: [0, 1], comment: [1, 2], 'sub-issue': [2], done: [0, 1], cancel: [2], ask: [1], label: [1] };
  if (!command || !arity[command]?.includes(args.length)) throw new Usage(USAGE);
  const body = (file: string) => {
    const text = file === '-' ? (o.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(file, 'utf8');
    if (!text.trim()) throw new Error(`${file === '-' ? 'standard input' : file} is empty`);
    return text;
  };
  const work = findWork(o.cwd);
  const config = o.config ?? loadConfig(configFile());
  const linear = linearClient(config, o.fetchFn ?? fetch);
  const read = async (id = work.id) => (await linear.gql<{ issue: Shown }>(
    'query Ticket($id: String!) { issue(id: $id) { identifier title url description state { name } assignee { name } comments(first: 50, orderBy: createdAt) { nodes { id createdAt body user { name } botActor { name } } pageInfo { hasNextPage } } children(first: 100) { nodes { id identifier title state { name } assignee { name } } } } }',
    { id },
  )).issue;
  const child = async (key: string) => {
    const found = (await read()).children.nodes.find((c) => c.identifier === key);
    if (!found) throw new Error(`${key} is not ${command === 'done' ? `${work.key} or one of its` : `one of ${work.key}'s`} sub-issues`);
    return found.id;
  };
  if (command === 'show') {
    const i = await read(args[0] === undefined ? work.id : await child(args[0]));
    const comments = [...i.comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [
      `${i.identifier}: ${i.title} (${i.state.name}, ${i.assignee ? `assigned to ${i.assignee.name}` : 'unassigned'})`, i.url, '', i.description ?? '', '',
      'Sub-issues:', ...(i.children.nodes.length ? i.children.nodes.map((c) => `- ${c.identifier} (${c.state.name}${c.assignee ? `, ${c.assignee.name}` : ''}): ${c.title}`) : ['- none']), '',
      `Comments, oldest first${i.comments.pageInfo.hasNextPage ? ` (the newest ${comments.length}; older ones not shown)` : ''}:`,
      ...(comments.length ? comments.map((c) => `\n${c.user?.name ?? c.botActor?.name ?? 'someone'}, ${local(c.createdAt)} (comment ${c.id}):\n${c.body}`) : ['- none']),
    ].join('\n');
  }
  if (command === 'comment') {
    await linear.comment(work.id, body(args[0]), args[1]);
    return `Commented on ${work.key}${args[1] ? ` in the thread of ${args[1]}` : ''}.`;
  }
  if (command === 'sub-issue') {
    // Idempotent on title: a rerun after a crash prints the sub-issue the first run filed.
    const [title, description] = [args[0].trim(), body(args[1])];
    if (!title) throw new Usage(USAGE);
    const { issue: i } = await linear.gql<{ issue: { team: { id: string }; project: { id: string } | null; children: { nodes: { identifier: string }[] } } }>(
      'query Parent($id: String!, $title: String!) { issue(id: $id) { team { id } project { id } children(first: 1, filter: { title: { eq: $title } }) { nodes { identifier } } } }',
      { id: work.id, title },
    );
    if (i.children.nodes[0]) return i.children.nodes[0].identifier;
    const { issueCreate } = await linear.gql<{ issueCreate: { success: boolean; issue: { identifier: string } | null } }>(
      'mutation SubIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }',
      { input: { teamId: i.team.id, ...(i.project ? { projectId: i.project.id } : {}), parentId: work.id, title, description } },
    );
    if (!issueCreate.success || !issueCreate.issue) throw new Error(`Linear did not file the sub-issue "${title}"`);
    return issueCreate.issue.identifier;
  }
  if (command === 'done') {
    const key = args[0] ?? work.key;
    // Linear's GitHub link assigns the PR author, Alex, when a PR names an issue; a closed issue is nobody's move.
    await linear.setState(key === work.key ? work.id : await child(key), 'Done', true);
    return `Moved ${key} to Done.`;
  }
  if (command === 'cancel') {
    const reason = body(args[1]);
    const id = await child(args[0]);
    await linear.comment(id, reason);
    await linear.setState(id, 'Canceled', true);
    return `Commented on ${args[0]} and moved it to Canceled.`;
  }
  if (command === 'label') {
    // Only a label the runner maps to a repo: the lead picks it, and the runner then starts a lead in that repo's worktree.
    const name = args[0];
    if (!Object.hasOwn(config.repos, name)) throw new Error(`"${name}" names no repo in the runner config; the repo labels are ${Object.keys(config.repos).join(', ')}`);
    const { issueLabels } = await linear.gql<{ issueLabels: { nodes: { id: string; team: { key: string } | null }[] } }>(
      'query Label($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id team { key } } } }', { name },
    );
    const label = issueLabels.nodes.find((l) => !l.team || l.team.key === config.team);
    if (!label) throw new Error(`Linear team ${config.team} has no label "${name}"`);
    await linear.gql('mutation AddLabel($id: String!, $label: String!) { issueAddLabel(id: $id, labelId: $label) { success } }', { id: work.id, label: label.id });
    return `Labeled ${work.key} ${name}.`;
  }
  const text = body(args[0]);
  await linear.assign(work.id, true);
  await linear.comment(work.id, text);
  return `Assigned ${work.key} to ${config.askAssignee} and posted the ask.`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await ticket(process.argv.slice(2), { cwd: process.cwd() }));
  } catch (error) {
    console.error(error instanceof Usage ? error.message : `ticket: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof Usage ? 64 : 1;
  }
}
