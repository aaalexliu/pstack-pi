# Job runner

The job runner starts a Pi lead for each Linear issue delegated to its app user that is in `Todo` or a started state and carries a repo label from the config, and wakes it when you act. The lead does the rest: it builds, opens small PRs, gets each one reviewed by a separate Pi session, merges after CI, asks you through Decision issues, and closes the ticket. The runner is one TypeScript file with no dependencies. It is not part of the Pi package, and `npm pack` leaves it out.

## What the runner does

The runner keeps process only where a stopped or absent model cannot act for itself. It makes two writes:

1. **Start or resume the lead**, only when you acted after the lead's last start: you delegated the ticket (it sits in `Todo`), closed a Decision issue (Done or Canceled), or commented on the ticket as a person (comments by apps and bots do not count). The runner moves a `Todo` ticket to `In Progress` before it records the start, so a crash can never count one delegation twice; at worst it files a Decision issue instead of starting.
2. **File a Decision issue** when the lead stopped and nothing is open to wait for.

It remembers one fact per ticket: when it last started the lead, in `<worktree>/.runner/started`. Everything else it reads from Linear and tmux each poll.

Each poll, for each open issue delegated to `runnerUser` (`Todo`, or any started state such as `In Progress` or `In Review`):

```text
lead live in tmux                     -> leave it; nudge it, then start an investigator, if it went quiet
open Decision issue, no news          -> wait (a comment or another closed Decision is news: start)
you acted after the lead's last start -> start the lead (if a slot is free) and save the start time
else                                  -> file a Decision issue: "the lead stopped with nothing open to wait for"
```

A live lead belongs to the lead: the runner never starts, restarts or kills it. Your comments and Decision answers reach it when you attach and type, or after it exits, since the next start carries them.

The lead's heartbeat is the newest agent event in its `.runner/activity.json` or in the activity file of any subagent it runs (`<sessions>/<cwd>/artifacts/<lead session id>/subagent-activity/`, written by panes and headless children alike). A running tool or provider call keeps it alive, except a `subagent` call with `wait: true`: there the child's own heartbeat decides, so a lead waiting on a child idle at its prompt is quiet. Redraws in tmux do not count; the subagent panel's "waiting" timer redraws forever.

```text
last heartbeat      +stallMinutes             +stallMinutes
      |------ quiet ------|------ still quiet ------|
                       nudge                   investigator
```

After `stallMinutes` with no heartbeat, the runner types one nudge into the lead's pane: check each subagent, take any finished result, close the ones that are done, then continue or end. If no heartbeat lands for another `stallMinutes` after the nudge, it starts one investigator: `pi -p` with [prompts/stall.md](prompts/stall.md) in the tmux session `KEY-stall`, in the worktree, on the lead model. It reads the lead's session, its subagents' panes and sessions, the activity files, the ticket and the PRs, changes nothing, and posts its findings as one comment, filing a Decision issue only if you must act. It takes no lead slot. Any heartbeat after the nudge ends the stretch. Each step happens once per quiet stretch, tracked in `.runner/stall.json`, and none happens while `.runner/takeover` or `.runner/held` exists.

The runner kills a ticket's tmux session only when it started that session (it tags each session it creates with the tmux option `@job-runner`), nobody holds it through `.runner/takeover` or `.runner/held`, and Linear, asked about that one ticket, says it is Done, Canceled, or no longer delegated to `runnerUser`. On any Linear error it leaves the session alone. Sessions started by a runner older than this tag are never reaped; stop them by hand with `tmux kill-session -t '=KEY'`.

A ticket marked Done or Canceled, or with its delegate cleared, is no longer the runner's. `In Review` still is: Linear's GitHub link moves a ticket there when the lead opens its first PR, long before the work is done.

### Decision issues

A Decision issue is a sub-issue of the ticket assigned to `decisionAssignee`. The runner files its own with `parentId` in the one `issueCreate` call, so no crash can leave it unfindable, and finds them as open children. The lead files them the same way. A sub-issue assigned to anyone else does not block the ticket.

Closing a Decision issue, Done or Canceled, wakes the lead in the same Pi session with your comments. So does a comment on the ticket while a Decision is still open: the lead judges whether it answers the Decision and closes the Decision if so. To stop the work instead, mark the ticket Done or Canceled, or clear its delegate.

### The lead

The runner starts `pi --session-id <uuid> @.runner/input.md` with [prompts/lead.md](prompts/lead.md) in a detached tmux session named for the ticket, in the ticket's worktree. `input.md` holds the ticket, the Linear ids the lead needs, the review model, the prompts folder, and what you did since its last start. Pi loads pstack-pi's `subagent-done.ts` without `PI_SUBAGENT_AUTO_EXIT`, so ending a turn does not end the session: the lead can wait for its own subagents, such as a reviewer started with the `subagent` tool. It exits when it calls `subagent_done`, once its ending is in place: the last PR merged and the ticket Done, the report posted and the ticket Done, or a Decision issue filed with nothing left running. The extension also writes activity to `.runner/activity.json` for the stall check.

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

[model/Ticket.tla](model/Ticket.tla) is a TLC model of one ticket under the runner. `nextMove()` in `runner.ts` is its `StartsLead` and `FilesDecision` guards: start on news, else wait on an open Decision issue, else file one. Delegation alone does not override an open Decision.

| Config | Result |
| --- | --- |
| [model/Ticket.cfg](model/Ticket.cfg) | `NoSpin`, `OneDecisionPerAsk` and no deadlock hold. 12 states. |
| [model/TicketSpin.cfg](model/TicketSpin.cfg) | Without the news check, `NoSpin` breaks in 3 steps: the runner restarts a lead with nothing new. |
| [model/TicketTwoStep.cfg](model/TicketTwoStep.cfg) | Filing then linking, instead of one write with a parent, breaks `OneDecisionPerAsk` in 4 steps. |

Draw the charts with the statechart skill:

```sh
statechart runner/model/Ticket.tla --config runner/model/Ticket.cfg --view runner/model/view-ticket.ts --out /tmp/ticket
```

The model leaves out:

- the stall check, lead slots, memory and the screen limit;
- delegation versus comments as news (it has one `news` flag for any act of yours, so it lets delegation start a lead past an open Decision, which the runner does not);
- PRs, review, CI and merge, which the runner no longer touches; the audit prompt covers them;
- a ticket you close or take back while the lead runs;
- the launch failing, which files a Decision issue like a stopped lead.

## Shared resources

Before it starts a lead, the runner checks three limits, and logs once why it waits:

- At most `maxLeads` leads run at once. A live tmux session holds its slot, including while the lead waits on CI.
- On macOS, no lead starts while `memory_pressure -Q` reports less than `minFreeMemoryPercent` free.
- At most one running ticket has `Needs: screen` in its description.

When a limit holds back a ticket you acted on, the runner replies once to your latest move, in the thread when it was a comment, with what it waits on, such as "Seen. Waiting to start: ALE-89 has the screen." It finds its earlier replies among the ticket's comments, so it keeps no state for this.

The queue: tickets with news from you since their last start go first. The rest keep Linear's order: Todo first, then the oldest. A Todo ticket that started once and stopped still counts as Todo, so it can go before a newer ticket that never started.

Run one runner per Linear team.

## The status comment

Each ticket gets one runner comment, edited in place: the state, the host, the tmux session, the Pi session id, the worktree, and commands to watch the lead (`tmux attach`), take it over (touch `.runner/takeover` first, so the runner does not nudge or investigate until you quit Pi; if the lead exits first, a second Pi starts under `.runner/held`), or quiz a fork of it in its own worktree.

## Ticket lines

- `Lead model: ...` and `Review model: ...` override `models` for this ticket.
- `Needs: screen` marks work that drives the screen.

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
| `pollSeconds` | Seconds between polls. Default 30 |
| `maxLeads` | Leads that run at once. Default 2 |
| `minFreeMemoryPercent` | No lead starts while less memory than this is free. Default 20 |
| `stallMinutes` | Minutes without a heartbeat from the lead or its subagents before the runner nudges the lead, and again before it starts an investigator. Default 5 |
| `host` | The host name the status comment uses for `ssh`. Default: this Mac's name |
| `worktreeRoot` | The directory for ticket worktrees |
| `routines` | Optional scheduled tickets: `{name, schedule, repo, title, prompt}`. See below |

Each poll, [routines.ts](routines.ts) files the latest due run of each routine as a Todo issue delegated to the runner, labelled `repo`, titled `<title> (<date>)`, with `prompt` as its description. A `schedule` is `daily HH:MM` or `weekly Mon HH:MM`, in this Mac's local time; the runner refuses to start, `--dry-run` included, on any other. A routine that fails, or whose token command or Linear call passes 30 s, is logged and retried next poll, without holding up tickets. The description ends with the marker `runner-routine <name> <due time>`, and the runner skips a run whose marker already exists, so a restart never files twice. After downtime it files only the latest missed run. From then on it is an ordinary ticket.

`JOB_RUNNER_PI`, `JOB_RUNNER_TMUX` and `JOB_RUNNER_MEMORY_PRESSURE` replace those binaries. The tests use them for stubs.

## Run it

```sh
node runner/runner.ts --dry-run
node runner/runner.ts --once
```

`--dry-run` prints each ticket's next move and writes nothing. `--once` runs one poll and exits; leads keep running in tmux. For a daemon, copy [launchd.example.plist](launchd.example.plist) to `~/Library/LaunchAgents/local.job-runner.plist`, fill in the placeholders, and `launchctl bootstrap gui/$(id -u)` it. Its `PATH` must reach `node` 24 or later, `pi`, `gh`, `git`, `curl` and `tmux`, and `gh` must be logged in to the account that pushes. Run the runner from a pstack-pi checkout: it loads `subagent-done.ts` and the prompts from there.

## Test it

```sh
node --test runner/*.test.ts
```

The tests use a fake Linear behind an injected `fetch`, stub `pi`, `tmux` and `memory_pressure` scripts, and real git repos in a temp directory. They make no network calls.
