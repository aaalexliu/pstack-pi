import { execFileSync } from 'node:child_process';

export type Routine = { name: string; schedule: string; repo: string; title: string; prompt: string };
type Setup = { linearTokenCommand: string; team: string; runnerUser: string; routines?: Routine[] };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The latest time at or before `now` that the schedule was due, in the host's local time. */
export function lastDue(schedule: string, now: Date): Date {
  const every = /^every (\d+)h$/.exec(schedule);
  const at = /^(?:daily|weekly (Sun|Mon|Tue|Wed|Thu|Fri|Sat)) (\d\d):(\d\d)$/.exec(schedule);
  if (!every && !at) throw new Error(`Bad routine schedule: ${schedule}`);
  for (let back = 0; back < 8; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (at?.[1] && DAYS[day.getDay()] !== at[1]) continue;
    const hours = every ? Array.from({ length: Math.ceil(24 / Number(every[1])) }, (_, i) => i * Number(every[1])).reverse() : [Number(at![2])];
    for (const h of hours) {
      const due = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, every ? 0 : Number(at![3]));
      if (due <= now) return due;
    }
  }
  throw new Error(`No due time for ${schedule}`);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Creates one Todo issue, delegated to the runner, for each routine's latest due run that has no issue yet. */
export async function createDueRoutines(config: Setup, fetchFn: typeof fetch, now = new Date()) {
  if (!config.routines?.length) return;
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const token = execFileSync('/bin/sh', ['-c', config.linearTokenCommand], { encoding: 'utf8' }).trim();
    const res = await fetchFn('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: unknown };
    if (!res.ok || body.errors || !body.data) throw new Error(`Linear ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
    return body.data;
  };
  for (const r of config.routines) {
    const due = lastDue(r.schedule, now);
    const mark = `runner-routine ${r.name} ${due.toISOString()}`;
    const found = await gql<{ issues: { nodes: unknown[] } }>(
      'query Marked($team: String!, $mark: String!) { issues(first: 1, includeArchived: true, filter: { team: { key: { eq: $team } }, description: { contains: $mark } }) { nodes { id } } }',
      { team: config.team, mark },
    );
    if (found.issues.nodes.length) continue;
    const ids = await gql<{ teams: { nodes: { id: string; states: { nodes: { id: string; name: string }[] } }[] }; users: { nodes: { id: string }[] }; issueLabels: { nodes: { id: string }[] } }>(
      'query Ids($team: String!, $user: String!, $label: String!) { teams(filter: { key: { eq: $team } }) { nodes { id states { nodes { id name } } } } users(filter: { name: { eq: $user } }) { nodes { id } } issueLabels(filter: { name: { eq: $label } }) { nodes { id } } }',
      { team: config.team, user: config.runnerUser, label: r.repo },
    );
    const team = ids.teams.nodes[0];
    const state = team?.states.nodes.find((s) => s.name === 'Todo');
    if (!team || !state || !ids.users.nodes[0] || !ids.issueLabels.nodes[0]) throw new Error(`Routine ${r.name}: Linear lacks team ${config.team}, its Todo state, user ${config.runnerUser}, or label ${r.repo}`);
    const date = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}${r.schedule.startsWith('every') ? ` ${pad(due.getHours())}:00` : ''}`;
    await gql('mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success } }', {
      input: { teamId: team.id, stateId: state.id, delegateId: ids.users.nodes[0].id, labelIds: [ids.issueLabels.nodes[0].id], title: `${r.title} (${date})`, description: `${r.prompt}\n\n${mark}` },
    });
    console.log(`Routine ${r.name}: created the ${date} run`);
  }
}
