# Job runner

The job runner starts a Pi lead for each Linear issue delegated to its app user that is in `Todo` or a started state and carries a repo label from the config, and wakes it on any event that is not its own. The lead does the rest: it builds, opens small PRs, gets each one reviewed by a separate Pi session, merges after CI, asks you through Decision issues, and closes the ticket. The runner is one TypeScript file with no dependencies, plus two commands for leads: `screen-lock` and `ticket.ts`. It is not part of the Pi package, and `npm pack` leaves it out.

## What the runner does

The runner keeps process only where a stopped or absent model cannot act for itself. Two moves decide a ticket:

1. **Start or resume the lead** on any event since its last start.
2. **File a Decision issue** when the lead stopped and nothing is open to wait for.

Around those two moves the runner makes 25 kinds of write and process start, across Linear, tmux and the disk. The [mechanism ledger](#mechanism-ledger) lists each one, the PR that added it, and how often it has fired.

Linear is an event log. An event is anything in Linear on the ticket or its sub-issues: a comment, a state, delegate, assignee, label, title or description change, or a Decision issue closed. Only events by someone other than `runnerUser` count, and not those of integrations such as GitHub or Slack. Leads post with the runner's token, so the runner's own moves and its leads' never wake anyone.

### Event flow

Linear tells the runner about a change through a webhook, so the runner acts within seconds without polling. A backup poll catches anything the webhook missed.

```text
Linear webhook (Issue, Comment) -> POST 127.0.0.1:8787/linear
  bad Linear-Signature, or webhookTimestamp over 60 s off -> 401
  else 200 at once, then the work:
    the issue id (an Issue's own id, a Comment's issueId) -> the open ticket it is, or whose sub-issue it is
    not a ticket delegated to runnerUser                  -> nothing
    else the per-ticket read and event rule below, for that ticket only
    lead running -> pass the event to it
backup poll every 10 minutes: the same rule for every ticket, plus
  "missed: KEY <time> <event>" for each event no webhook had delivered
heartbeat every 30 s: the stall check on live leads and running.json; no Linear calls unless it nudges or investigates
```

All passes run one at a time. Linear retries a failed delivery after 1 minute, 1 hour and 6 hours. A retry runs the pass again and changes nothing, since every pass is idempotent: it starts a lead only on events since the last start. Linear sends a label added to or removed from an issue as an Issue update; its IssueLabel events are about the label itself and carry no issue, so the runner ignores them. An event from before the runner started is never called missed.

With no `webhookSecretCommand`, the runner runs no server and polls every `pollSeconds`, stall check included, as before.

### The ack

When an event by a person lands, by webhook or poll, the runner acks it within seconds, once per event:

- a comment gets a 👀 reaction (`reactionCreate`, emoji `eyes`). The runner skips a comment that already has its 👀, so webhook retries, the backup poll and restarts never add a second.
- an event that is not a comment, such as a delegation or a closed Decision, gets the status comment update when the lead starts.
- when a limit blocks the start, the runner also replies "Seen. Waiting to start: <reason>" once.

### Events for a running lead

When a person acts on a ticket whose lead is live, the runner types the event into the lead's pane, as the stall nudge does, but with no Escape. Pi queues a message typed during a step as a steering message and hands it over once that step's tools finish, so the current tool keeps running. Each message is one line:

```text
Linear event on ALE-1 while you run, on Decision ALE-50 "Plan A or B?": Alex commented: Go with plan B. (<comment link>). Read it and act on it; if it answers an open Decision, close that Decision.
```

It names where the event happened (the ticket, a Decision or another sub-issue), who did what, and a comment's text, cut at 1500 characters, with its link. An event counts as seen only when its message shows up as a user message in the lead's session log, which Pi writes when it hands the message to the model. Then the runner moves the ticket's `seen` time past it: webhook retries and the backup poll do not type it again, and it does not start the lead again after the lead exits. Until then the runner retypes it at most once a minute, so a message a dialog swallowed is not lost, and a lead that exits before it gets the message is started with it, as for any event. The status comment says "Passed to the running lead"; the 👀 stays the ack. While `.runner/takeover` or `.runner/held` exists, the runner types nothing, and the event starts the lead after it exits.

```text
each pass, per open ticket delegated to runnerUser (Todo, or a started state such as In Progress or In Review):
  lead live in tmux            -> leave it; nudge it, then start an investigator, if it went quiet
  any event since its start    -> start the lead; its start message lists the events, and it judges what they mean
                                  if a limit blocks the start: reply "Seen. Waiting to start: <reason>" once
  no event, open Decision      -> wait
  no event, no open Decision   -> file a Decision issue: "the lead stopped with nothing open to wait for"
order: the ticket whose oldest unseen event is oldest goes first
```

The start rule reads one fact per ticket: `seen`, the time up to which the lead has seen every event. It lives in one state file per ticket, `<worktreeRoot>/.state/KEY.json`, never inside a folder the runner may have refused, and the runner writes it whole or not at all (temp file, flush, rename). A start sets `seen` to now, and the heartbeat counts from it. A failed start and an event a live lead's log shows also move it, so only a new event retries a failed start. The stall check adds `stall` to the same file. In all the runner keeps 26 facts: 12 files, 1 tmux option, 5 marks in Linear and 8 in memory; the [mechanism ledger](#mechanism-ledger) lists them.

A corrupt state file, or a missing one where a lead has run (the worktree has `.runner/session-id`), means the runner cannot tell which events the lead saw. It writes a fresh state whose `seen` is now, so it never starts a lead on its own. With nothing new, the next move files a Decision issue, "the runner lost its state (<file> is corrupt), so it counts only events from now", and closing it is a new event that starts the lead: the ticket is not stranded. A crash between the reset and the Decision still ends in a Decision, the usual "the lead stopped with nothing open to wait for". A live lead keeps running; if it exits with nothing new, that usual Decision follows. A runner from before the state file kept the start in `<worktree>/.runner/started`; with no state file, the runner reads `seen` from it, and the next lead start deletes it along with the older `.runner/passed` and `.runner/stall.json`. It does not read `passed`, `stall.json` or `<worktreeRoot>/.attempts/KEY`: at the switch, an event an older runner passed to a live lead may start that lead once more after it exits, a quiet lead may get one more nudge, and a refused start is tried once more. On 2026-11-17 alex-m1 had no `passed` or `.attempts` file and one `stall.json`.

The runner moves a `Todo` ticket to `In Progress` before it records the start. That move is the runner's own, so it is no event: a crash before the start is recorded starts the lead once more on the same events, never in a loop. On a ticket's first start, the session id is written a moment before the state, so a crash in between files the missing-state Decision instead.

### Reading Linear

What Linear showed on 2026-11-16, and what the runner does with it:

- Each history entry names its actor (`actor`, a user; leads and the runner share one app user). An integration's own entry has `botActor` set instead, such as the GitHub link a PR adds.
- When a PR opens, the GitHub integration moves the ticket to In Review and assigns it, but Linear credits those entries to the PR author, a person, with no bot mark. Their only tell is that they land within a second after the integration's link entry. The runner drops a state or assignee change within 2 s after an integration's link entry on the same issue; any other change by a person still counts.
- Comments are not in history; the runner reads both. A comment with `botActor`, or with no user, is an integration's.
- History, comments and children all come newest first. The runner pages back through comments and history until it passes the lead's last start, so a busy ticket cannot hide an event past the first page of 25.
- A comment does not move an issue's `updatedAt`, and a change on a sub-issue does not move its parent's. So the list query fetches, for the ticket and each sub-issue, `updatedAt` and the newest comment. When none of them is newer than the lead's last start, or than the last read that found no events, the runner skips the per-ticket read. A live lead costs no per-ticket read either.

The runner and every lead share the app user's Linear budgets: 5,000 requests and 2,000,000 complexity points an hour. One poll is one list query of about 17 points, plus, for each ticket that changed, one read of about 310 points per changed issue in it. Complexity grows with each page size asked for, so the read asks only for the ticket and sub-issues that changed, 25 entries a page; asking for all 100 sub-issues at 50 a page cost 1,236 points. On a 429 the runner waits as long as `Retry-After` says, logs it, and tries again.

A live lead belongs to the lead: the runner never starts, restarts or kills it. Events reach it when you attach and type, or after it exits, since the next start lists them.

The lead's heartbeat is the newest write to any Pi session log in the session folder of its worktree or of a sibling worktree named `<worktree>-<unit>` (`~/.pi/agent/sessions/<encoded path>/`). Pi files each session under its cwd, so the lead and its subagents log to the worktree's folder, and sub-leads, which the lead prompt puts in `<worktree>-<unit>`, log to theirs. The investigator's folder (`.runner`) does not count. The runner reads the last message of that newest log: a tool call with no result yet, or a user message or tool result with no reply yet, is busy; anything else is idle. tmux redraws do not count; the subagent panel's "waiting" timer redraws forever.

```text
lead start .. quiet stretch 1 .. (lead may write) .. quiet stretch 2 .. quiet stretch 3
                  Escape + nudge                         investigator     nothing
```

A quiet stretch is `stallMinutes` with no write while the lead is idle, or `toolQuietMinutes` while busy. The runner counts stretches per lead run in the ticket's state file, and a new lead start resets the count. The first stretch gets Escape in the lead's pane (closing any selector, or stopping a hung tool or wait) and one nudge: check each subagent, take any finished result, close the ones that are done, then continue or end. The second, whether or not the lead wrote in between, starts one investigator: `pi -p` with [prompts/stall.md](prompts/stall.md) in the tmux session `KEY-stall`, on the lead model, run from `.runner` so its own log never counts as the lead's heartbeat. After that the runner does nothing more for that run. The investigator reads the lead's session, its subagents' panes and sessions, the ticket and the PRs, changes nothing, and posts its findings as one comment, filing a Decision issue only if you must act. It takes no lead slot. Neither step happens while `.runner/takeover` or `.runner/held` exists.

The runner kills a ticket's tmux session only when it started that session (it tags each session it creates with the tmux option `@job-runner`), nobody holds it through `.runner/takeover` or `.runner/held`, and Linear, asked about that one ticket, says it is Done, Canceled, or no longer delegated to `runnerUser`. On any Linear error it leaves the session alone. Sessions started by a runner older than this tag are never reaped; stop them by hand with `tmux kill-session -t '=KEY'`.

A ticket marked Done or Canceled, or with its delegate cleared, is no longer the runner's. `In Review` still is: Linear's GitHub link moves a ticket there when the lead opens its first PR, long before the work is done.

### Decision issues

A Decision issue is a sub-issue of the ticket assigned to `decisionAssignee`. The runner files its own with `parentId` in the one `issueCreate` call, so no crash can leave it unfindable, and finds them as open children. The lead files them with `ticket.ts decision`, which calls the same `fileDecision`. A sub-issue assigned to anyone else does not block the ticket.

Closing a Decision issue, Done or Canceled, wakes the lead in the same Pi session. So does any other event while a Decision is still open, such as a comment on the Decision or the ticket: the lead judges whether it answers the Decision and closes the Decision if so. To stop the work instead, mark the ticket Done or Canceled, or clear its delegate.

### The lead

The runner starts `pi --session-id <uuid> @.runner/input.md` with [prompts/lead.md](prompts/lead.md) in a detached tmux session named for the ticket, in the ticket's worktree. `input.md` holds the ticket, the Linear ids the lead needs, the review model, the prompts folder, and the events since its last start. Pi loads pstack-pi's `subagent-done.ts` without `PI_SUBAGENT_AUTO_EXIT`, so ending a turn does not end the session: the lead can wait for its own subagents, such as a reviewer started with the `subagent` tool. It exits when it calls `subagent_done`, once its ending is in place: the last PR merged and the ticket Done, the report posted and the ticket Done, or a Decision issue filed with nothing left running.

The lead splits the work into units it can verify alone. It builds a unit itself or hands it to a sub-lead: it makes a worktree and branch, then calls `subagent` with the bundled [`sub-lead`](../additions/agents/sub-lead.md) agent, that path as `cwd`, and its own model. The sub-lead follows this prompt's Build, PRs and merge gate sections for its unit and opens its own PR. It exits when its turn ends, so it blocks on every wait, and the lead checks the unit's PR merged, resuming the sub-lead with `subagent_resume` if not. That is two levels at most, enforced by Pi, not only the prompt. A `sub-lead` child gets `PI_DENY_TOOLS` with every spawning tool; a `pi -p` it runs from bash inherits it. [tests/pi/depth.test.mjs](../tests/pi/depth.test.mjs) proves this in a real Pi. A child that clears those variables on purpose could still start a full Pi; only the prompt stops that. The lead stays in the ticket's repo, except that an agent-tooling ticket may touch pstack-pi, agent-memory, agent-orchestration and dotfiles.

The launch script drops every `PI_*` and `PSTACK_*` variable the tmux server holds from another session, digits in names included, keeping only `PI_AUTH_PROFILE`, `PI_CODING_AGENT_DIR` and, when set, `JOB_RUNNER_CONFIG`. It runs `linearTokenCommand` itself and exports the token as `LINEAR_TOKEN`, so the token never lands on disk and the lead posts to Linear as the runner's app user. With `ghTokenCommand` set, it exports `GH_TOKEN` the same way; otherwise `gh` uses the host's login. It mirrors the unsets and exports into the tmux session with `tmux set-environment`, so windows the lead's subagents open get the same environment. The lead reaches Linear through `runner/ticket.ts`, and GitHub with `gh`; the prompt forbids `gh auth switch`, `gh auth login` and `gh auth setup-git`.

### The ticket command

The lead reaches Linear only through [ticket.ts](ticket.ts), run in its worktree:

```text
ticket.ts show                        the ticket, its sub-issues, and its comments oldest first, in local time
ticket.ts comment <file>              post a comment on the ticket
ticket.ts done [KEY]                  move the ticket, or one of its sub-issues, to Done
ticket.ts decision "<title>" <file>   file a Decision issue: a sub-issue assigned to decisionAssignee
```

It finds its ticket in `.runner/work.json`, which the launch writes, in the folder it runs in or the nearest one above. A sub-lead's worktree is the lead's path plus `-<unit>`, so each folder also tries the folders its name extends. It reads the runner's config and calls Linear through the runner's own client, so it shares the token command, the 429 wait and `fileDecision`. A `<file>` of `-` reads standard input. It checks its arguments and file before it calls Linear, and a usage error exits 64. The fake-Linear tests in `runner.test.ts` cover each command.

### The merge gate lives in the lead prompt

[prompts/lead.md](prompts/lead.md) tells the lead to open small PRs, its own one at a time, each naming the ticket (`Fixes KEY` on the last, `Part of KEY` on the others); run `.agents/verify`; get a review from a separate Pi session with fresh context through `runner/review.ts`; fix caused must-fixes; after 3 rounds on one PR cut scope or file a Decision issue; and merge only after CI passes and the latest review names the head commit with `verdict: clean`. After its last PR merges, the lead moves the ticket to Done itself, so it does not depend on Linear's GitHub link.

The reviewer follows [prompts/review.md](prompts/review.md). It reruns the proof in the PR body; no proof, a proof that does not rerun, an inconclusive or wrong-surface check, or a bug fix whose failing repro does not land in an earlier commit is a caused must-fix. It posts its own record on the PR with `gh pr review --comment` (GitHub refuses an approval from the PR's author). Its first lines are `runner-review v1`, `verdict`, `caused_must_fix`, `head`, `round`, `trigger` (`first`, `fix` or `rebase onto <full base sha>`, for people reading the PR; a rebase still gets a full round), `agent`, `model`, `session_id`, `session_path`, `session_title` and `asked_by`, one per line; the findings follow as JSON.

`review.ts <pr> --round <n> --trigger first|fix|rebase` fills the facts the lead used to type into the reviewer's task. It reads the PR head from GitHub, and for `rebase` the merge base with the base branch. It takes `asked_by` from `$PI_SESSION_ID`, and the ticket's key, title, description and review model from `.runner/work.json`, found as `ticket.ts` finds it. It starts `pi -p` with a new session id, `--name "review KEY PR <n> round <r>"`, the review model and `review.md`, and waits. Then it finds the record with that `session_id` on the PR, checks that its `head`, `round`, `trigger` and `asked_by` match what it asked for, and prints it. It exits 0 on `verdict: clean`, 2 on `must-fix`, and 1 when the record is missing or does not match, with what the reviewer said. `runner/review.test.ts` proves the record's `head` is the PR head, against a fake `gh` and `pi`.

The runner enforces none of this. The audit prompt checks it after the fact.

## The audit

To audit, delegate a ticket whose description says `Follow <prompts>/audit.md` (the lead gets the prompts folder in its start message) and names the repos, for example `Repos: owner/web-app`.

[prompts/audit.md](prompts/audit.md) has the lead list merged PRs on `job/` branches or naming a ticket (flagging a `job/` PR that names none), with the exact `gh` and Linear queries, and flag each one where:

- no `runner-review` record exists, or the newest one came after `mergedAt`;
- the record's `head` is not the merged head commit;
- `caused_must_fix` is above 0;
- the record does not trace to a separate review session: `session_id` equals `asked_by`, or the file at `session_path` is missing, has another id, or is not a review of this PR's head (lead and reviewer share a `gh` login, so this is not proof of who posted);
- `round` is above 3 with no Decision sub-issue on the ticket;
- a check on the merged head was not green as of `mergedAt`, from timestamped check runs and statuses, or green cannot be proven.

It pages through the window and says when coverage is incomplete.

It posts a report comment on its ticket, moves it to Done, and files a Decision issue only if something is flagged. If flags repeat, add enforcement in GitHub (required checks, a required review from a bot identity), not in the runner.

A routine can file this audit as a ticket on a schedule; see `routines` below.

## The model

[model/Ticket.tla](model/Ticket.tla) is a TLC model of one ticket under the runner. `nextMove()` in `runner.ts` is its `StartsLead` and `FilesDecision` guards: start on an event, else wait on an open Decision issue, else file one.

| Config | Result |
| --- | --- |
| [model/Ticket.cfg](model/Ticket.cfg) | `NoSpin`, `OneDecisionPerAsk` and no deadlock hold. 12 states. |
| [model/TicketSpin.cfg](model/TicketSpin.cfg) | Without the event check, `NoSpin` breaks in 3 steps: the runner restarts a lead with nothing new. |
| [model/TicketTwoStep.cfg](model/TicketTwoStep.cfg) | Filing then linking, instead of one write with a parent, breaks `OneDecisionPerAsk` in 4 steps. |

Draw the charts with the statechart skill:

```sh
statechart runner/model/Ticket.tla --config runner/model/Ticket.cfg --view runner/model/view-ticket.ts --out /tmp/ticket
```

The model leaves out:

- the stall check, lead slots, memory and `running.json`;
- the kinds of event, which it folds into one `event` flag;
- PRs, review, CI and merge, which the runner no longer touches; the audit prompt covers them;
- a ticket you close or take back while the lead runs;
- the launch failing, which files a Decision issue like a stopped lead.

## Shared resources

Before it starts a lead, the runner checks two limits, and logs once why it waits:

- At most `maxLeads` leads run at once. A live tmux session holds its slot, including while the lead waits on CI.
- On macOS, no lead starts while `memory_pressure -Q` reports less than `minFreeMemoryPercent` free.
The runner does not decide who uses the screen; leads take turns themselves. Each poll, and after each start, it writes the running leads to `<worktreeRoot>/running.json` (key, title, tmux session, worktree, Pi session id, and whether the ticket says `Needs: screen`), and each start message lists the same leads and names that file. A lead runs each step that drives the screen, records it, or needs focus as `runner/screen-lock run KEY -- <command>`. The command waits for the screen, wakes the display, keeps it awake with `caffeinate`, and frees the screen when the command ends. It takes a kernel file lock on `/tmp/screen.lock` with `lockf`, on an open file the command and its children inherit. The lock lasts while any of them runs and ends with the last one, however it ends, so no lock goes stale and no two steps overlap. A background job the command leaves running keeps the screen until it ends. The file names its last holder, and a waiting run prints it. `runner/screen-lock.test.ts` proves two runs take turns, a killed command does not block the next, and killing `screen-lock` alone does not let the next run start while the command still runs.

When a limit holds back a ticket with an event, the runner replies once to the latest event, in its thread when it was a comment, with what it waits on, such as "Seen. Waiting to start: all 2 lead slots are busy." It finds its earlier replies among its comments on the ticket and its sub-issues, so it keeps no state for this.

The queue: the ticket whose oldest unseen event is oldest goes first. Tickets with no event keep Linear's order after them: Todo first, then the oldest.

Run one runner per Linear team.

## The status comment

Each ticket gets one runner comment, edited in place: the state, the host, the tmux session, the Pi session id, the worktree, and commands to watch the lead (`tmux attach`) or take it over (touch `.runner/takeover` first, so the runner does not nudge or investigate until you quit Pi; if the lead exits first, a second Pi starts under `.runner/held`).

## Ticket lines

- `Lead model: ...` and `Review model: ...` override `models` for this ticket.
- `Needs: screen` marks work that drives the screen. It only informs other leads through `running.json`; it does not hold a ticket back.

The first label that names a repo in the config picks the repo. With no such label, the runner comments, clears the delegate, and skips the issue. The worktree is `<worktreeRoot>/job-<key>-<slug>` on branch `job/<key>-<slug>`, found by key and reused; the runner never removes a worktree or resets a branch.

## Mechanism ledger

Every mechanism in `runner.ts` and `routines.ts`: 25 writes and processes, 26 facts, 18 config fields, 9 other inputs and 15 timers. [ledger.test.ts](ledger.test.ts) fails when the ledger misses a config field, a state file, a Linear mutation or a tmux command the code has, or names a config field or function the code no longer has. It cannot check the timers, the "Paid for by" column or the "Fired" column; a person fills those in.

The last column counts fires on the one live host from 2026-11-14 to 2026-11-17 10:00 EST. It has three sources:

- the launchd log: 58 lines with no timestamps. Output from before launchd, when the runner ran by hand in tmux, was not kept.
- the `.runner/` folders of the 12 ticket worktrees and the files under `worktreeRoot`, as they stood at the end.
- the Pi session logs of those 12 tickets.

The runner does not log a Linear write, a webhook delivery or a pass, so those rows say "log does not show it". Webhook mode went live on 2026-11-17 09:56 EST, 10 minutes before the count, so its rows have almost no history. "None found" means no PR or review names an incident. "New, no history" marks a row that merged after the count.

### Writes and processes

| Mechanism | Where | Paid for by | Fired |
| --- | --- | --- | --- |
| Linear: file a Decision issue (`issueCreate` with `parentId`) | `decide`, `fileDecision` | [#71](https://github.com/aaalexliu/pstack-pi/pull/71): one write, so a crash cannot leave it unfindable. [#109](https://github.com/aaalexliu/pstack-pi/pull/109): at most one open, after 62 Decisions on one ticket in 26 minutes | Log does not show it. At least 62, from [#109](https://github.com/aaalexliu/pstack-pi/pull/109) |
| Linear: move a Todo ticket to In Progress (`issueUpdate`) | `poll`, `setState` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61). None found | Log does not show it. At most once per ticket; 12 tickets started |
| Linear: clear the delegate of a ticket with no repo label (`issueUpdate`) | `poll`, `clearDelegate` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61). None found | Log does not show it |
| Linear: "No repo label" comment (`commentCreate`) | `poll` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61). None found | Log does not show it |
| Linear: the status comment, posted once (`commentCreate`) then edited (`commentUpdate`) | `status`, `renderStatus`, `commands` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68): the lead moved into tmux, so a person needs the commands to reach it. None found | Log does not show it. At least one write per lead start (15), nudge (1) and Decision. Passed events: new, no history |
| Linear: "Seen. Waiting to start" reply (`commentCreate`) | `ack` | [#100](https://github.com/aaalexliu/pstack-pi/pull/100): a comment on a blocked ticket got no answer for hours | Log does not show it. The log has 57 "Not starting" lines, all on the screen limit that [#108](https://github.com/aaalexliu/pstack-pi/pull/108) removed, and 0 on slots or memory |
| Linear: 👀 on a person's comment (`reactionCreate`) | `react` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110): an ack within seconds. None found | Log does not show it; 0 failed reactions |
| Linear: file a routine's ticket (`issueCreate`) | `createDueRoutines` | [#70](https://github.com/aaalexliu/pstack-pi/pull/70): Linear's recurring issues are UI only and whole days only. None found | 0. The live config has no `routines` |
| tmux: `new-session` for the lead | `launch` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | 15 starts on 12 tickets (session logs) |
| tmux: `kill-session` on a leftover session of the same name, before a start | `launch` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68). None found | Log does not show it |
| tmux: `set-option @job-runner`, and `kill-session` if the tag fails | `launch` | [#78](https://github.com/aaalexliu/pstack-pi/pull/78): the review of [#74](https://github.com/aaalexliu/pstack-pi/pull/74) found the reaper could kill a session a person made | Tag: each start since [#78](https://github.com/aaalexliu/pstack-pi/pull/78). Failed tag: log does not show it |
| tmux: `kill-session` on a closed ticket's session | `reapClosed` | [#74](https://github.com/aaalexliu/pstack-pi/pull/74), [#78](https://github.com/aaalexliu/pstack-pi/pull/78) | Log does not show it; 0 failed checks |
| tmux: `set-environment`, so subagent windows match the lead | `envScript` | [#74](https://github.com/aaalexliu/pstack-pi/pull/74). [#81](https://github.com/aaalexliu/pstack-pi/pull/81): `CMUX_*` from another session broke the `subagent` tool | Each start (15) |
| tmux: `send-keys` Escape, the nudge, Enter | `checkStall` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105): a lead sat idle for 21 hours | 1, on 2026-11-16 (session logs) |
| tmux: `send-keys` a person's event, then Enter, into a live lead | `pass`, `eventText` | [#112](https://github.com/aaalexliu/pstack-pi/pull/112): a running lead did not hear a comment or a closed Decision until it exited | New, no history |
| tmux: `kill-session` then `new-session` for `KEY-stall` | `investigate` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | 0. No `stall.sh`, `stall-input.md` or investigator session exists |
| Process: the lead, `pi --session-id` | `launch` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68). [#74](https://github.com/aaalexliu/pstack-pi/pull/74): the lead decides when to exit | 15 |
| Process: a second `pi` under `.runner/held` after a take over | `launch` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68). None found | Log does not show it. No `takeover` or `held` file exists |
| Process: the investigator, `pi -p` with `stall.md` | `investigate` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | 0 |
| Process: `/bin/sh -c` for `linearTokenCommand` (each Linear call), `ghTokenCommand` (each start) and `webhookSecretCommand` (once) | `gql`, `envScript`, `main` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61), [#74](https://github.com/aaalexliu/pstack-pi/pull/74), [#110](https://github.com/aaalexliu/pstack-pi/pull/110): tokens never land on disk | Log does not show it |
| Process: `git fetch`, `git worktree prune`, `git worktree add` | `makeWorktree`, `worktree` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61), [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | 12 worktrees |
| Process: `memory_pressure -Q` | `freeMemory` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68). None found | Each pass. It blocked 0 starts in the log |
| Process: an HTTP server on `127.0.0.1:<webhookPort>` | `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Started once, 2026-11-17 09:56 EST. Deliveries: log does not show it |
| File: the ticket's worktree folder and branch `job/<key>-<slug>` | `makeWorktree`, `workFor` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | 12 |
| File: a `.runner/` line in the repo's `.git/info/exclude` | `makeWorktree` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Log does not show it. Once per repo |

### State and remembered facts

A file path with no folder is in `<worktree>/.runner/`.

| Mechanism | Where | Paid for by | Fired |
| --- | --- | --- | --- |
| `session-id`: the lead's Pi session, kept across starts | `launch`, `sessionId` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | In 12 of 12 worktrees |
| `input.md`: the start message | `launch`, `startMessage` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | Written 15 times |
| `work.json`: the ticket, so the heartbeat needs no Linear call | `launch`, `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | In 7 worktrees, every live lead, on 2026-11-17 |
| `lead.sh`: the launch script | `launch`, `envScript` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | In 12 worktrees |
| `pane`: the lead's tmux pane, for the nudge and for passed events | `launch`, `checkStall`, `pass` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | In 3 worktrees |
| `stall-input.md`: the investigator's task | `investigate` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | 0 |
| `stall.sh`: the investigator's launch script | `investigate` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | 0 |
| `takeover`: a person touches it; the runner stops nudging and reaping | `launch`, `checkStall`, `reapClosed`, `commands` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68), [#78](https://github.com/aaalexliu/pstack-pi/pull/78). None found | In 0 worktrees. Log does not show past use |
| `held`: `lead.sh` renames `takeover` to it while the second `pi` runs | `launch`, `checkStall`, `reapClosed` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68), [#78](https://github.com/aaalexliu/pstack-pi/pull/78). None found | In 0 worktrees. Log does not show past use |
| `<worktreeRoot>/.state/KEY.json`: the ticket's `seen` time and this lead run's `stall` | `readState`, `writeState`, `poll` | [#71](https://github.com/aaalexliu/pstack-pi/pull/71) (start), [#105](https://github.com/aaalexliu/pstack-pi/pull/105) (stall), [#109](https://github.com/aaalexliu/pstack-pi/pull/109): 62 Decisions in 26 minutes (failed start), [#112](https://github.com/aaalexliu/pstack-pi/pull/112) (passed events). [ALE-202](https://linear.app/aaalexliu/issue/ALE-202) folded their four files into this one | New, no history |
| `started`: a runner from before the state file kept the start here; read when a ticket has no state file, deleted by its next lead start | `readState`, `launch` | [ALE-202](https://linear.app/aaalexliu/issue/ALE-202): leads running at the switch keep their start | In 17 worktrees on 2026-11-17. Delete once none is left |
| `<worktreeRoot>/running.json`: the live leads, for other leads | `writeRunning`, `runningEntry` | [#108](https://github.com/aaalexliu/pstack-pi/pull/108): two screen tickets could not run at once | Rewritten each pass and heartbeat. It lists 0 leads now |
| tmux option `@job-runner`: marks a session the runner made | `launch`, `reapClosed`, `serve` | [#78](https://github.com/aaalexliu/pstack-pi/pull/78) | Each start since [#78](https://github.com/aaalexliu/pstack-pi/pull/78) |
| Linear: the status comment, found by its `**Runner:**` start | `status`, `statusComment` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | Log does not show it |
| Linear: a `Seen.` reply newer than the event means "acked" | `ack` | [#100](https://github.com/aaalexliu/pstack-pi/pull/100) | Log does not show it |
| Linear: the runner's own 👀 means "reacted" | `react`, `eventsOf` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Log does not show it |
| Linear: an open `Decision for KEY:` issue blocks a second | `decide`, `decisionTitle` | [#109](https://github.com/aaalexliu/pstack-pi/pull/109): 62 Decisions in 26 minutes | Log does not show it |
| Linear: the `runner-routine <name> <time>` line marks a filed run | `createDueRoutines`, `newEvents` | [#70](https://github.com/aaalexliu/pstack-pi/pull/70) | 0 |
| Memory: `quiet`, tickets read with no events, so they are not read again | `poll` | [#107](https://github.com/aaalexliu/pstack-pi/pull/107): the per-ticket read costs about 310 points of a shared budget | Log does not show it |
| Memory: `reacted`, comments given a 👀 this run | `react` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Log does not show it |
| Memory: `typed`, when each event was last typed into a live lead | `pass` | [#112](https://github.com/aaalexliu/pstack-pi/pull/112) | New, no history |
| Memory: `handled`, `delivered` and `since`, behind the "missed:" lines | `poll`, `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | 0 "missed:" lines |
| Memory: `queue`, one pass at a time | `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Log does not show it |
| Memory: `said`, lines already logged | `main`, `serve` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | 57 lines got through |
| Memory: `repoLocks`, one git setup per repo at a time | `worktree` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68): two starts fought over `.git/config.lock` | Log does not show it |
| Memory: `decisionIds`, the team and assignee ids | `fileDecision` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | Log does not show it |

### Config fields

"Fired" says what the live config sets.

| Mechanism | Where | Paid for by | Fired |
| --- | --- | --- | --- |
| `linearTokenCommand` | `gql`, `envScript`, `createDueRoutines` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Set |
| `ghTokenCommand` | `envScript` | [#74](https://github.com/aaalexliu/pstack-pi/pull/74) | Set |
| `team` | `linearClient`, `startMessage`, `createDueRoutines` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Set |
| `runnerUser` | `linearClient`, `createDueRoutines` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Set |
| `decisionAssignee` | `isDecision`, `fileDecision`, `startMessage` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | Set |
| `repos` | `workFor`, `launch`, `poll` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | 6 labels for 4 clones |
| `models` | `workFor` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Set |
| `thinking` | `launch`, `investigate` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | `high`, the default |
| `pollSeconds` | `main` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | 30, the default |
| `webhookSecretCommand` | `main` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Set. Webhook mode since 2026-11-17 |
| `webhookPort` | `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Not set; default 8787 |
| `maxLeads` | `startBlock`, `poll` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | 20. It blocked 0 starts in the log |
| `minFreeMemoryPercent` | `startBlock`, `poll` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | 20, the default. It blocked 0 starts in the log |
| `stallMinutes` | `checkStall` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68). [#105](https://github.com/aaalexliu/pstack-pi/pull/105) cut the default to 5 | 5, the default. 1 nudge |
| `toolQuietMinutes` | `checkStall` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105): a busy lead must not be nudged at 5 minutes | Not set; default 60. 0 fires |
| `host` | `status`, `decide` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Set |
| `worktreeRoot` | `workFor`, `writeRunning`, `stateFile` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Set |
| `routines` | `loadConfig`, `createDueRoutines` | [#70](https://github.com/aaalexliu/pstack-pi/pull/70) | Not set. 0 routine tickets |

### Other inputs

| Mechanism | Where | Paid for by | Fired |
| --- | --- | --- | --- |
| `JOB_RUNNER_CONFIG`: the config file | `configFile`, `loadConfig`, `ticket` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Log does not show it |
| `JOB_RUNNER_PI`, `JOB_RUNNER_TMUX`, `JOB_RUNNER_MEMORY_PRESSURE`: stand-in binaries | `bin` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61): the tests | Tests only |
| `PI_AUTH_PROFILE`, `PI_CODING_AGENT_DIR`, `JOB_RUNNER_CONFIG`: the variables a lead keeps | `KEEP_ENV`, `envScript`, `agentDir` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68); `JOB_RUNNER_CONFIG` so `ticket.ts` reads the runner's config | Log does not show it |
| `--dry-run` | `main`, `poll` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Log does not show it |
| `--once` | `main` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Log does not show it |
| Ticket line `Lead model:` or `Implement model:` | `workFor` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61), [#68](https://github.com/aaalexliu/pstack-pi/pull/68) | Log does not show it |
| Ticket line `Review model:` | `workFor` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Log does not show it |
| Ticket line `Needs: screen` | `needsScreen`, `runningEntry`, `startMessage` | [#68](https://github.com/aaalexliu/pstack-pi/pull/68). [#108](https://github.com/aaalexliu/pstack-pi/pull/108) made it a note for other leads | On 7 of 12 tickets. 57 "Not starting" log lines before [#108](https://github.com/aaalexliu/pstack-pi/pull/108), none since |
| The repo label | `workFor`, `poll` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | 12 tickets |

### Timers and schedules

| Mechanism | Where | Paid for by | Fired |
| --- | --- | --- | --- |
| Poll every `pollSeconds`, with no webhook | `main` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | Ran until 2026-11-17 09:56 EST. Passes: log does not show it |
| Routine check every `pollSeconds` | `main`, `createDueRoutines` | [#70](https://github.com/aaalexliu/pstack-pi/pull/70) | Runs; 0 routines to file |
| Heartbeat every 30 s, with a webhook | `main`, `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110) | Since 2026-11-17 09:56 EST. Log does not show it |
| Backup poll every 10 minutes, with a webhook | `main`, `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110). None found | Every 10 minutes for 10 minutes; 0 "missed:" lines |
| Quiet limit while idle: `stallMinutes` | `checkStall`, `heartbeat` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105): a lead sat idle for 21 hours | 1 nudge |
| Quiet limit while busy: `toolQuietMinutes` | `checkStall`, `heartbeat` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | 0 |
| 500 ms between Escape and the nudge | `checkStall` | [#105](https://github.com/aaalexliu/pstack-pi/pull/105) | 1 |
| An event the lead's log does not show is typed again at most once in 60 s | `pass` | [#112](https://github.com/aaalexliu/pstack-pi/pull/112): a dialog can swallow typed text | New, no history |
| Webhook timestamp window: 60 s | `serve` | [#110](https://github.com/aaalexliu/pstack-pi/pull/110): the endpoint is public, so a replay must fail | Log does not show it |
| Linear 429: wait `Retry-After` or 60 s, then try again, with no limit | `gql` | [#107](https://github.com/aaalexliu/pstack-pi/pull/107) | 0 "rate limit hit" lines |
| A state or assignee change within 2 s after an integration's link is the integration's | `eventsOf` | [#107](https://github.com/aaalexliu/pstack-pi/pull/107): an opened PR looked like a person's move | Log does not show it |
| Routine Linear call and token command: 30 s limit | `createDueRoutines` | [#70](https://github.com/aaalexliu/pstack-pi/pull/70) | 0 |
| Routine schedule: `daily HH:MM`, `weekly Mon HH:MM` | `parseSchedule`, `lastDue` | [#70](https://github.com/aaalexliu/pstack-pi/pull/70) | 0 |
| A failed pass waits for the next pass | `poll`, `main` | [#61](https://github.com/aaalexliu/pstack-pi/pull/61) | 0 "failed" lines |
| A failed start waits for a new event | `poll`, `writeState` | [#109](https://github.com/aaalexliu/pstack-pi/pull/109): 62 Decisions in 26 minutes | 0 failed starts on disk |

Size limits are not in the ledger: 100 sub-issues, pages of 25, a 1 MB webhook body, a 1 MB log tail and a passed event cut at 1,500 characters.

## Config

The runner reads `~/.config/job-runner/config.json`, or the file named by `JOB_RUNNER_CONFIG`. Start from [config.example.json](config.example.json).

| Field | Meaning |
| --- | --- |
| `linearTokenCommand` | A shell command that prints a Linear token for the runner's app user. The lead gets the same token |
| `ghTokenCommand` | Optional. A shell command that prints a GitHub token; the lead and its subagents get it as `GH_TOKEN` |
| `team` | The Linear team key, such as `ENG` |
| `runnerUser` | The app user's name as Linear shows it on the delegate field |
| `decisionAssignee` | The person Decision issues go to |
| `repos` | Linear label name to `{path, base}`. `path` is a local clone with an `origin` remote |
| `models` | `lead` and `review`, each a `pi --model` value. The lead passes `review` to its reviewer. Pick `review` from a different model family than `lead`, such as OpenAI against Anthropic, so the reviewer does not share its author's blind spots |
| `thinking` | The lead's `pi --thinking` level. Default `high` |
| `pollSeconds` | Seconds between polls with no webhook, and between routine checks. Default 30 |
| `webhookSecretCommand` | Optional. A shell command that prints the Linear webhook signing secret, such as `security find-generic-password -s linear-runner-webhook -w`. Without it the runner polls every `pollSeconds` |
| `webhookPort` | The port on 127.0.0.1 the webhook listens on, at `/linear`. Default 8787 |
| `maxLeads` | Leads that run at once. Default 2 |
| `minFreeMemoryPercent` | No lead starts while less memory than this is free. Default 20 |
| `stallMinutes` | Minutes with no session log write, while the lead is idle, before the runner nudges it, and again before it starts an investigator. Default 5 |
| `toolQuietMinutes` | The same limit while a tool or model call is in flight; the nudge first presses Escape to stop it. Default 60 |
| `host` | The host name the status comment uses for `ssh`. Default: this Mac's name |
| `worktreeRoot` | The directory for ticket worktrees |
| `routines` | Optional scheduled tickets: `{name, schedule, repo, title, prompt}`. See below |

Every `pollSeconds`, [routines.ts](routines.ts) files the latest due run of each routine as a Todo issue delegated to the runner, labelled `repo`, titled `<title> (<date>)`, with `prompt` as its description. A `schedule` is `daily HH:MM` or `weekly Mon HH:MM`, in this Mac's local time; the runner refuses to start, `--dry-run` included, on any other. A routine that fails, or whose token command or Linear call passes 30 s, is logged and retried next poll, without holding up tickets. The description ends with the marker `runner-routine <name> <due time>`, and the runner skips a run whose marker already exists, so a restart never files twice. After downtime it files only the latest missed run. From then on it is an ordinary ticket.

`JOB_RUNNER_PI`, `JOB_RUNNER_TMUX` and `JOB_RUNNER_MEMORY_PRESSURE` replace those binaries. The tests use them for stubs.

## Run it

```sh
node runner/runner.ts --dry-run
node runner/runner.ts --once
```

`--dry-run` prints each ticket's next move and writes nothing. `--once` runs one full poll, with no webhook server, and exits; leads keep running in tmux. For a daemon, copy [launchd.example.plist](launchd.example.plist) to `~/Library/LaunchAgents/local.job-runner.plist`, fill in the placeholders, and `launchctl bootstrap gui/$(id -u)` it. Its `PATH` must reach `node` 24 or later, `pi`, `gh`, `git`, `curl` and `tmux`, and `gh` must be logged in to the account that pushes. Run the runner from a pstack-pi checkout: it loads `subagent-done.ts` and the prompts from there.

## Set up the webhook

1. Make a signing secret and store it: `security add-generic-password -s linear-runner-webhook -a "$USER" -w "$(openssl rand -hex 32)"`. Set `webhookSecretCommand` to `security find-generic-password -s linear-runner-webhook -w`. Or copy the secret Linear shows in step 3 into the keychain instead.
2. Expose the local port with Tailscale Funnel: `tailscale funnel --bg --https=10000 --set-path=/linear http://127.0.0.1:8787/linear`. `tailscale funnel status` prints the public URL.
3. In Linear, Settings > API > Webhooks > New webhook: the Funnel URL ending in `/linear`, team ALE, and the data change events Issues, Comments and Issue labels. Paste the secret from step 1 as the signing secret, or put Linear's into the keychain.
4. Restart the runner. It logs `Listening for Linear webhooks on 127.0.0.1:8787/linear`. Comment on a delegated ticket: the comment gets 👀 within seconds.

## Test it

```sh
node --test runner/*.test.ts
```

The tests use a fake Linear behind an injected `fetch`, stub `pi`, `tmux` and `memory_pressure` scripts, and real git repos in a temp directory. They make no network calls.

### Size budgets

The runner is meant to stay thin. [budget.test.ts](budget.test.ts) fails when `runner.ts`, `prompts/lead.md` or the number of top-level `Config` fields passes its budget in [budget.json](budget.json). CI runs the runner tests on every push and pull request. Lower a budget any time. To raise one, get Alex to record the new number in the decision log of `~/dev/agent-orchestration/README.md` first, then change `budget.json`.
