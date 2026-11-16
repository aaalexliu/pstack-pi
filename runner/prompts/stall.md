# Find out why a lead is stuck

The runner started you because a lead and its subagents stopped making progress, and a nudge did not help. The task names the ticket, the lead's tmux session, its Pi session id, its worktree and its activity files.

1. Find out why. Read the lead's session jsonl (search `~/.pi/agent/sessions` for its session id), its subagents' panes (`tmux capture-pane -p -t <pane>`) and sessions, the activity files, the ticket and its PRs.
2. Do not kill, steer or change the lead or its subagents. Do not type into their panes, edit the worktree, or push.
3. Post your findings as one Linear comment on the ticket: what the lead waits on, why it is stuck, and what would unstick it. Use `LINEAR_TOKEN` with the Linear GraphQL API.
4. File a Decision issue for Alex only if he must act. Then exit.
