# Job runner

The job runner starts a Pi lead for each Linear issue delegated to its app user that is in `Todo` or a started state and carries a repo label from the config, and wakes it on any event that is not its own. The lead does the rest: it builds, opens small PRs, gets each one reviewed by a separate Pi session, merges after CI, asks you through Decision issues, and closes the ticket. The runner is one TypeScript file with no dependencies. It is not part of the Pi package, and `npm pack` leaves it out.

## What the runner does

The runner keeps process only where a stopped or absent model cannot act for itself. It makes two writes:

1. **Start or resume the lead** on any event since its last start.
2. **File a Decision issue** when the lead stopped and nothing is open to wait for.

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
backup poll on auditPoll (default every 10m): the same rule for every ticket, plus
  "missed: KEY <time> <event>" for each event no webhook had delivered
heartbeat every 30 s: the stall check on live leads, running.json and the stale screen lock; no Linear calls unless it nudges or investigates
```

All passes run one at a time. Linear retries a failed delivery after 1 minute, 1 hour and 6 hours, and the runner skips a delivery id it already handled. Every pass is idempotent anyway: it starts a lead only on events since the last start. Linear sends a label added to or removed from an issue as an Issue update; its IssueLabel events are about the label itself and carry no issue, so the runner ignores them. If "missed:" lines stay rare, set `auditPoll` slower, such as `every 1h` or `daily 06:00`. An event from before the runner started is never called missed.

With no `webhookSecretCommand`, the runner runs no server and polls every `pollSeconds`, stall check included, as before.

### The ack

When an event by a person lands, by webhook or poll, the runner acks it within seconds, once per event:

- a comment gets a 👀 reaction (`reactionCreate`, emoji `eyes`). The runner skips a comment that already has its 👀, so webhook retries, the backup poll and restarts never add a second.
- an event that is not a comment, such as a delegation or a closed Decision, gets the status comment update when the lead starts.
- when a limit blocks the start, the runner also replies "Seen. Waiting to start: <reason>" once.

Live leads do not get events yet; they see them at their next start.

```text
each pass, per open ticket delegated to runnerUser (Todo, or a started state such as In Progress or In Review):
  lead live in tmux            -> leave it; nudge it, then start an investigator, if it went quiet
  any event since its start    -> start the lead; its start message lists the events, and it judges what they mean
                                  if a limit blocks the start: reply "Seen. Waiting to start: <reason>" once
  no event, open Decision      -> wait
  no event, no open Decision   -> file a Decision issue: "the lead stopped with nothing open to wait for"
order: the ticket whose oldest unseen event is oldest goes first
```

It remembers one fact per ticket: when it last tried to start the lead. A start that works is kept in `<worktree>/.runner/started`, which the heartbeat also counts from. A start that fails is kept in `<worktreeRoot>/.attempts/KEY`, never inside a folder the runner may have refused. Events before the last attempt are seen, so only a new event retries a failed start. The runner never files a second Decision issue while its own (titled `Decision for KEY: ...`) is open. A ticket a routine filed counts its creation as an event, since the runner made it on your schedule.

The runner moves a `Todo` ticket to `In Progress` before it records the start. That move is the runner's own, so it is no event: a crash before the start is recorded starts the lead once more on the same events, never in a loop.

### Reading Linear

What Linear showed on 2026-11-16, and what the runner does with it:

- Each history entry names its actor (`actor`, a user; leads and the runner share one app user). An integration's own entry has `botActor` set instead, such as the GitHub link a PR adds.
- When a PR opens, the GitHub integration moves the ticket to In Review and assigns it, but Linear credits those entries to the PR author, a person, with no bot mark. Their only tell is that they land within a second after the integration's link entry. The runner drops a state or assignee change within 2 s after an integration's link entry on the same issue; any other change by a person still counts.
- Comments are not in history; the runner reads both. A comment with `botActor`, or with no user, is an integration's.
- History, comments and children all come newest first. The runner pages back through comments and history until it passes the lead's last start, so a busy ticket cannot hide an event past the first page of 25.
- A comment does not move an issue's `updatedAt`, and a change on a sub-issue does not move its parent's. So the list query fetches, for the ticket and each sub-issue, `updatedAt` and the newest comment. When none of them is newer than the lead's last start, or than the last read that found no events, the runner skips the per-ticket read. A live lead costs no per-ticket read either.

The runner and every lead share the app user's Linear budgets: 5,000 requests and 2,000,000 complexity points an hour. One poll is one list query of about 17 points, plus, for each ticket that changed, one read of about 310 points per changed issue in it. Complexity grows with each page size asked for, so the read asks only for the ticket and sub-issues that changed, 25 entries a page; asking for all 100 sub-issues at 50 a page cost 1,236 points. On a 429 the runner waits as long as `Retry-After` says, logs it, and tries again. It logs once when `X-RateLimit-Requests-Remaining` or `X-RateLimit-Complexity-Remaining` drops under 20% of its limit.

A live lead belongs to the lead: the runner never starts, restarts or kills it. Events reach it when you attach and type, or after it exits, since the next start lists them.

The lead's heartbeat is the newest write to any Pi session log in the session folder of its worktree or of a sibling worktree named `<worktree>-<unit>` (any unit name but `quiz`, which the quiz fork uses) (`~/.pi/agent/sessions/<encoded path>/`). Pi files each session under its cwd, so the lead and its subagents log to the worktree's folder, and sub-leads, which the lead prompt puts in `<worktree>-<unit>`, log to theirs. The investigator's folder (`.runner`) and the quiz fork's (`<worktree>-quiz`) do not count. The runner reads the last message of that newest log: a tool call with no result yet, or a user message or tool result with no reply yet, is busy; anything else is idle. tmux redraws do not count; the subagent panel's "waiting" timer redraws forever.

```text
lead start .. quiet stretch 1 .. (lead may write) .. quiet stretch 2 .. quiet stretch 3
                  Escape + nudge                         investigator     nothing
```

A quiet stretch is `stallMinutes` with no write while the lead is idle, or `toolQuietMinutes` while busy. The runner counts stretches per lead run in `.runner/stall.json`, and a new lead start resets the count. The first stretch gets Escape in the lead's pane (closing any selector, or stopping a hung tool or wait) and one nudge: check each subagent, take any finished result, close the ones that are done, then continue or end. The second, whether or not the lead wrote in between, starts one investigator: `pi -p` with [prompts/stall.md](prompts/stall.md) in the tmux session `KEY-stall`, on the lead model, run from `.runner` so its own log never counts as the lead's heartbeat. After that the runner does nothing more for that run. The investigator reads the lead's session, its subagents' panes and sessions, the ticket and the PRs, changes nothing, and posts its findings as one comment, filing a Decision issue only if you must act. It takes no lead slot. Neither step happens while `.runner/takeover` or `.runner/held` exists.

The runner kills a ticket's tmux session only when it started that session (it tags each session it creates with the tmux option `@job-runner`), nobody holds it through `.runner/takeover` or `.runner/held`, and Linear, asked about that one ticket, says it is Done, Canceled, or no longer delegated to `runnerUser`. On any Linear error it leaves the session alone. Sessions started by a runner older than this tag are never reaped; stop them by hand with `tmux kill-session -t '=KEY'`.

A ticket marked Done or Canceled, or with its delegate cleared, is no longer the runner's. `In Review` still is: Linear's GitHub link moves a ticket there when the lead opens its first PR, long before the work is done.

### Decision issues

A Decision issue is a sub-issue of the ticket assigned to `decisionAssignee`. The runner files its own with `parentId` in the one `issueCreate` call, so no crash can leave it unfindable, and finds them as open children. The lead files them the same way. A sub-issue assigned to anyone else does not block the ticket.

Closing a Decision issue, Done or Canceled, wakes the lead in the same Pi session. So does any other event while a Decision is still open, such as a comment on the Decision or the ticket: the lead judges whether it answers the Decision and closes the Decision if so. To stop the work instead, mark the ticket Done or Canceled, or clear its delegate.

### The lead

The runner starts `pi --session-id <uuid> @.runner/input.md` with [prompts/lead.md](prompts/lead.md) in a detached tmux session named for the ticket, in the ticket's worktree. `input.md` holds the ticket, the Linear ids the lead needs, the review model, the prompts folder, and the events since its last start. Pi loads pstack-pi's `subagent-done.ts` without `PI_SUBAGENT_AUTO_EXIT`, so ending a turn does not end the session: the lead can wait for its own subagents, such as a reviewer started with the `subagent` tool. It exits when it calls `subagent_done`, once its ending is in place: the last PR merged and the ticket Done, the report posted and the ticket Done, or a Decision issue filed with nothing left running.

The lead splits the work into units it can verify alone. It builds a unit itself or hands it to a sub-lead: it makes a worktree and branch, then calls `subagent` with the bundled [`sub-lead`](../additions/agents/sub-lead.md) agent, that path as `cwd`, and its own model. The sub-lead follows this prompt's Build, PRs and merge gate sections for its unit and opens its own PR. It exits when its turn ends, so it blocks on every wait, and the lead checks the unit's PR merged, resuming the sub-lead with `subagent_resume` if not. That is two levels at most, enforced by Pi, not only the prompt. A `sub-lead` child gets `PI_DENY_TOOLS` with every spawning tool; a `pi -p` it runs from bash inherits it. [tests/pi/depth.test.mjs](../tests/pi/depth.test.mjs) proves this in a real Pi. A child that clears those variables on purpose could still start a full Pi; only the prompt stops that. The lead stays in the ticket's repo, except that an agent-tooling ticket may touch pstack-pi, agent-memory, agent-orchestration and dotfiles.

The launch script drops every `PI_*` and `PSTACK_*` variable the tmux server holds from another session, digits in names included, keeping only `PI_AUTH_PROFILE` and `PI_CODING_AGENT_DIR`. It runs `linearTokenCommand` itself and exports the token as `LINEAR_TOKEN`, so the token never lands on disk and the lead posts to Linear as the runner's app user. With `ghTokenCommand` set, it exports `GH_TOKEN` the same way; otherwise `gh` uses the host's login. It mirrors the unsets and exports into the tmux session with `tmux set-environment`, so windows the lead's subagents open get the same environment. The lead calls Linear's GraphQL API with `curl`, and GitHub with `gh`; the prompt forbids `gh auth switch`, `gh auth login` and `gh auth setup-git`.

### The merge gate lives in the lead prompt

[prompts/lead.md](prompts/lead.md) tells the lead to open small PRs, its own one at a time, each naming the ticket (`Fixes KEY` on the last, `Part of KEY` on the others); run `.agents/verify`; get a review from a separate Pi session with fresh context (`subagent` with `wait: true`, agent `pr-reviewer`, and role `review` by default, or `subagent` without `wait`, or `pi -p`); fix caused must-fixes; after 3 rounds on one PR cut scope or file a Decision issue; and merge only after CI passes and the latest review names the head commit with `verdict: clean`. After its last PR merges, the lead moves the ticket to Done itself, so it does not depend on Linear's GitHub link.

The reviewer follows [prompts/review.md](prompts/review.md) and posts its own record on the PR with `gh pr review --comment` (GitHub refuses an approval from the PR's author). Its first lines are `runner-review v1`, `verdict`, `caused_must_fix`, `head`, `round`, `trigger` (`first`, `fix` or `rebase onto <full base sha>`, for people reading the PR; a rebase still gets a full round), `agent`, `model`, `session_id`, `session_path`, `session_title` and `asked_by`, one per line; the findings follow as JSON.

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

- the stall check, lead slots, memory, `running.json` and the screen lock;
- the kinds of event, which it folds into one `event` flag;
- PRs, review, CI and merge, which the runner no longer touches; the audit prompt covers them;
- a ticket you close or take back while the lead runs;
- the launch failing, which files a Decision issue like a stopped lead.

## Shared resources

Before it starts a lead, the runner checks two limits, and logs once why it waits:

- At most `maxLeads` leads run at once. A live tmux session holds its slot, including while the lead waits on CI.
- On macOS, no lead starts while `memory_pressure -Q` reports less than `minFreeMemoryPercent` free.
The runner does not decide who uses the screen; leads take turns themselves. Each poll, and after each start, it writes the running leads to `<worktreeRoot>/running.json` (key, title, tmux session, worktree, Pi session id, whether the ticket says `Needs: screen`, and start time), and each start message lists the same leads and names that file. Before a lead drives the screen, records it, or needs focus, it takes the shared lock `<worktreeRoot>/screen.lock` with `mkdir`, writes its key and the time to `screen.lock/owner`, and removes the folder when that step ends. `lead.md` says how to wait for a held lock. The runner never enforces the lock, but clears one whose owner has no tmux session, because that lead can no longer release it, and one with no `owner` file after a minute.

When a limit holds back a ticket with an event, the runner replies once to the latest event, in its thread when it was a comment, with what it waits on, such as "Seen. Waiting to start: all 2 lead slots are busy." It finds its earlier replies among its comments on the ticket and its sub-issues, so it keeps no state for this.

The queue: the ticket whose oldest unseen event is oldest goes first. Tickets with no event keep Linear's order after them: Todo first, then the oldest.

Run one runner per Linear team.

## The status comment

Each ticket gets one runner comment, edited in place: the state, the host, the tmux session, the Pi session id, the worktree, and commands to watch the lead (`tmux attach`), take it over (touch `.runner/takeover` first, so the runner does not nudge or investigate until you quit Pi; if the lead exits first, a second Pi starts under `.runner/held`), or quiz a fork of it in its own worktree.

## Ticket lines

- `Lead model: ...` and `Review model: ...` override `models` for this ticket.
- `Needs: screen` marks work that drives the screen. It only informs other leads through `running.json`; it does not hold a ticket back.

The first label that names a repo in the config picks the repo. With no such label, the runner comments, clears the delegate, and skips the issue. The worktree is `<worktreeRoot>/job-<key>-<slug>` on branch `job/<key>-<slug>`, found by key and reused; the runner never removes a worktree or resets a branch.

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
| `models` | `lead` and `review`, each a `pi --model` value. The lead passes `review` to its reviewer |
| `thinking` | The lead's `pi --thinking` level. Default `high` |
| `pollSeconds` | Seconds between polls with no webhook, and between routine checks. Default 30 |
| `webhookSecretCommand` | Optional. A shell command that prints the Linear webhook signing secret, such as `security find-generic-password -s linear-runner-webhook -w`. Without it the runner polls every `pollSeconds` |
| `webhookPort` | The port on 127.0.0.1 the webhook listens on, at `/linear`. Default 8787 |
| `auditPoll` | With a webhook, when the backup poll runs: `every 10m`, `every 1h` (any `every <n>m` or `every <n>h`), `daily HH:MM` or `weekly Mon HH:MM`. Default `every 10m` |
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

The runner is meant to stay thin. [budget.test.ts](budget.test.ts) fails when `runner.ts`, `prompts/lead.md` or the number of top-level `Config` fields passes its budget in [budget.json](budget.json). Lower a budget any time. To raise one, get Alex to record the new number in the decision log of `~/dev/agent-orchestration/README.md` first, then change `budget.json`.
