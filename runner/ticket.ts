#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile, linearClient, loadConfig, type Config, type Work } from './runner.ts';

const USAGE = `usage: ticket show
       ticket comment <file> [COMMENT ID]
       ticket done [SUB-ISSUE KEY]
       ticket ask <file>
A <file> of - reads standard input.`;

class Usage extends Error {}

type Shown = {
  identifier: string; title: string; url: string; description: string | null; state: { name: string }; assignee: { name: string } | null;
  comments: { nodes: { id: string; createdAt: string; body: string; user: { name: string } | null; botActor: { name: string } | null }[]; pageInfo: { hasNextPage: boolean } };
  children: { nodes: { id: string; identifier: string; title: string; state: { name: string }; assignee: { name: string } | null }[] };
};

/**
 * The ticket the runner started this lead for: `.runner/work.json` in `cwd` or the nearest folder above it. A sub-lead's
 * worktree is the lead's path plus `-<unit>`, so each folder also tries the folders its name extends, longest first.
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
  const arity: Record<string, number[]> = { show: [0], comment: [1, 2], done: [0, 1], ask: [1] };
  if (!command || !arity[command]?.includes(args.length)) throw new Usage(USAGE);
  const body = (file: string) => {
    const text = file === '-' ? (o.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(file, 'utf8');
    if (!text.trim()) throw new Error(`${file === '-' ? 'standard input' : file} is empty`);
    return text;
  };
  const work = findWork(o.cwd);
  const config = o.config ?? loadConfig(configFile());
  const linear = linearClient(config, o.fetchFn ?? fetch);
  const read = async () => (await linear.gql<{ issue: Shown }>(
    'query Ticket($id: String!) { issue(id: $id) { identifier title url description state { name } assignee { name } comments(first: 50, orderBy: createdAt) { nodes { id createdAt body user { name } botActor { name } } pageInfo { hasNextPage } } children(first: 100) { nodes { id identifier title state { name } assignee { name } } } } }',
    { id: work.id },
  )).issue;
  if (command === 'show') {
    const i = await read();
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
  if (command === 'done') {
    const key = args[0] ?? work.key;
    let id = work.id;
    if (key !== work.key) {
      const child = (await read()).children.nodes.find((c) => c.identifier === key);
      if (!child) throw new Error(`${key} is not ${work.key} or one of its sub-issues`);
      id = child.id;
    }
    await linear.setState(id, 'Done');
    return `Moved ${key} to Done.`;
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
