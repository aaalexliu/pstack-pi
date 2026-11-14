# Job runner

The job runner turns Linear issues into pull requests, reports, or questions. It polls one Linear team for issues delegated to its app user and runs each one as a single interactive Pi lead in a detached tmux session. The runner, not the lead, owns verify, review, merge, and everything it posts to Linear. It is one TypeScript file with no dependencies. It is not part of the Pi package, and `npm pack` leaves it out.

## Whose move it is

Linear says whose move it is:

- An issue delegated to the runner's app user is the runner's move. The runner acts on it.
- An issue assigned to you is your move. The runner assigns you only Decision issues, never work tickets.
- An issue with neither owes nobody a move.

## The runner keeps no state

The runner has no state file and no memory between polls. Each poll it works out every ticket's next step from four sources of truth, and each step checks the truth again before it acts, so a crash at any point only means the next poll repeats a check:

| Source | What it says |
| --- | --- |
| Linear | Which tickets are ours (`Todo` or `In Progress`, delegated to `runnerUser`), and each turn's Decision issue and its comments |
| GitHub | Whether the branch already has an open or merged PR |
| tmux | Whether the lead's session, `=KEY`, is live |
| The worktree's `.runner/` | The session id, the turn folders, and the last comment the lead got |

Every file the runner writes there is written to a temp file, flushed, and renamed into place.

### Turns

Each lead turn is a folder, `.runner/turn-N/`. The runner builds the folder aside, with `input.md` (the message, ending with the path to write the ending to) and `cause.json` (what made the turn: the task, review findings and their round, a cut, a failed verify, or the Decision issue Alex answered), then renames it into place. So a new turn appears whole or not at all.

The newest turn is the live one, and every older one counts as consumed. Making a new turn is therefore the only way the runner moves past an ending, and one cause can never make two turns: once the answer turn exists, the answered turn is no longer the newest.

For the newest turn, the runner:

1. Waits on it while its tmux session is live.
2. Starts Pi on it only when it has no `exit` record, no `ending.json`, and no live session. If it has a `launched` record, Pi stopped with the runner (a reboot), so the runner sends the same turn again with a note saying so.
3. Otherwise acts on its ending, after looking for the turn's Decision issue.

### Decision issues are found by a marker

Each Decision issue's description ends with a marker such as `runner-decision ALE-93 turn 3 end`, and the runner finds a turn's Decision issue by searching for that text. It still adds a `blocks` link to the work ticket for you to see, but it never reads the link to decide whether a Decision issue exists: creating the issue and linking it are two writes, and a crash between them would make it file a second issue for the same ask.

[model/Runner.tla](model/Runner.tla) is a TLC model of one ticket under these rules. With [model/Runner.cfg](model/Runner.cfg), five rules hold: no merge over a caused must-fix, one PR, one Decision issue per ask, no replayed turn, and every answer reaches the lead. [model/RunnerTwoStep.cfg](model/RunnerTwoStep.cfg) finds a Decision issue through its link instead, and TLC finds a second Decision issue for one ask in 6 steps. The model opens the PR before the first review; the runner reviews first, which keeps the same rules.

## What one ticket does

The runner picks the oldest issue in the team that is in `Todo` and delegated to `runnerUser`. The first label that names a repo in the config picks the repo. If no label matches, the runner comments, clears the delegate, and skips the issue.

Lines in the issue description change a ticket:

- `Lead model: anthropic/claude-opus-5-5` and `Review model: openai/gpt-5.5` override `models` for this ticket. `Implement model:` still works as another name for `Lead model:`.
- `Needs: screen` marks work that drives the screen, a browser, or a simulator. Only one such ticket runs at a time.
- `Report to: desk` names a webhook in the config. When the ticket ends or waits, the runner POSTs `{issue, url, state, pr}` to it with `Authorization: Bearer <key from keyFile>`. `state` is `ready`, `done`, or `needs-decision`.

The [intake skill](../additions/skills/intake/SKILL.md) tells any session that files a ticket to write three headings, Goal, Reference, and Not doing, then delegate it. The runner does not check them. A lead that finds them missing writes its own reading in its start note.

Then the runner:

1. Reuses the ticket's worktree, or creates one from `origin/<base>` on the branch `job/<issue key>-<title slug>`, for example `job/ale-58-suggest-close-matches`. It finds the worktree by the issue key, so a title change does not move it. It never removes a worktree or resets a branch. It writes `.runner/session-id`, sets the issue to `In Progress`, and makes turn 1 from the ticket and its comments.
2. Starts the lead: `tmux new-session -d -s <KEY>` running `pi --session-id <uuid> @.runner/turn-N/input.md` in the worktree, with the [lead prompt](prompts/lead.md). The environment sets `PI_SUBAGENT_AUTO_EXIT=1` and loads pstack-pi's `subagent-done.ts`, so Pi exits when the lead's turn ends. It also writes an activity file to `.runner/activity.json`. When Pi exits, the launch script writes its exit code to `turn-N/exit`.
3. While the lead runs, posts its `.runner/start.md` as a comment and pastes new human comments on the ticket into the session.
4. When Pi has exited, acts on `turn-N/ending.json`.

A ticket that is delegated again from `Todo` gets a new turn in the same session and worktree.

## Endings

The lead ends a turn by writing `.runner/turn-N/ending.json` with one of three kinds:

| Kind | Fields | What the runner does |
| --- | --- | --- |
| `report` | `body` | Posts the body as a comment, sets `Done`, and clears the delegate. |
| `change` | `full_suite`, `full_suite_why`, plus a non-empty `.runner/PROOF.md` | Runs the gate below. |
| `decision` | `question`, `recommendation`, up to 3 `options` of `{option, pick_this_if}`, optional `context` | Files a Decision issue. |

The runner accepts an ending only when Pi exited with code 0. A missing or invalid ending, or a nonzero exit, is itself a Decision issue that names the problem.

### Decision issues and answers

A Decision issue is a new issue assigned to `decisionAssignee`, linked as blocking the work ticket. It holds one question, the recommendation first, the options, and the marker. The work ticket stays `In Progress` and delegated to the runner. The lead has exited, so the ticket holds no lead slot while it waits.

What Alex does on the Decision issue:

| Action | What the runner does |
| --- | --- |
| Comments while it is open | Nothing yet. The runner reads comments only when the issue closes. |
| Marks it Done | Makes an answer turn with every comment on the issue, and starts the same Pi session on it. Review rounds count from this turn again. |
| Cancels it | Comments that it stopped, sets the work ticket to `Todo`, and clears the delegate. The worktree and branch stay. Delegating the ticket again starts a new turn on them. |
| Reopens it after the answer turn exists | Nothing. That turn is consumed. |

The runner also files a Decision issue when it cannot go on: a change with no commits, a repo with no `.agents/verify`, a verify that still fails after 3 tries, auto-merge that GitHub will not turn on, a judge that asks, or any error while it handles an ending.

### The gate for a change

1. Commit the tree. A change with no commits on the branch becomes a Decision issue.
2. Run `.agents/verify`. If it fails, make a new turn with the output, without a review. After 3 failures, file a Decision issue.
3. Run a review step: a fresh `pi -p` with [prompts/review.md](prompts/review.md) on `models.review`, which writes `turn-N/findings.json`. The runner saves the result as `turn-N/review.json`, so a repeat after a crash reuses it. Round 1 reviews the whole change. Later rounds review only the latest fix. A finding blocks only when `must_fix` and `caused_by_change` are both true.
4. With no blocking findings, ship. Otherwise make a new turn with the findings, in the same Pi session.
5. At round 3 with blocking findings still open, run a judge: a fresh `pi -p` with [prompts/judge.md](prompts/judge.md). It writes its verdict, `{decision, why}`, to `<worktreeRoot>/.judge/<KEY>-<turn>.json`, outside the lead's worktree.
   - `cut` makes a new turn telling the lead what to cut. A fresh review round follows. If that round still has blocking findings, the runner files a Decision issue.
   - `ask` files a Decision issue.

   The judge cannot ship. Any other verdict is an error and becomes a Decision issue. Nothing merges with a caused must-fix open.

To ship, the runner looks for an open or merged PR on the branch, and opens one only if there is none. The PR body holds the issue, `PROOF.md`, the review log, and the verify result. If the lead set `full_suite` and the repo has a `fullSuiteLabel`, it adds that label. With `automerge`, it runs `gh pr merge --auto --squash`, which waits for the required checks. If GitHub will not turn on auto-merge, the runner never merges directly: unless the PR is already merged, it files a Decision issue. Then it sets `In Review` and clears the delegate.

The runner never reads model prose. It reads only `ending.json`, the findings files, and the judge's verdict.

## The `.agents/verify` contract

A repo opts in by adding an executable `.agents/verify` at its root. The runner runs it from the worktree root before each review. Exit 0 means pass. A person runs the same file the same way before pushing, so the runner and the person agree on what "green" means.

Verify fails closed. A repo with no executable `.agents/verify` does not merge, and the ticket waits on a Decision issue. Set `"ciGate": true` on the repo to say its required CI checks are the gate instead. The runner then only turns on auto-merge.

This repo's [.agents/verify](../.agents/verify) runs the `TESTING.md` gate for skill text and non-packed tests, plus the runner tests.

## The status comment

Each ticket gets one runner comment, edited in place at each step, so Linear does not notify you for every step. It shows the state, the host, the tmux session, the Pi session id, the worktree, and three commands. Every word in them is quoted for both the local and the remote shell, so paths with spaces or quotes work:

| Command | What it does |
| --- | --- |
| `ssh -t <host> 'tmux attach -t =<KEY>'` | Watch or steer the lead. What you type reaches it as a steering message. |
| `ssh -t <host> 'touch <worktree>/.runner/takeover && tmux attach -t =<KEY>'` | Take over. Auto-exit stays off until you quit Pi. |
| `ssh -t <host> 'cd <worktree> && git worktree add -B <branch>-quiz <worktree>-quiz HEAD && cd <worktree>-quiz && tmux new -s <KEY>-quiz pi --fork <session id>'` | Quiz a fork of the lead in its own worktree, without touching the lead. |

### Comments on a running ticket

The runner pastes new human comments into the live session with tmux bracketed paste, then presses Enter. It records the last comment it handed over in `.runner/delivered.json`, and only after every tmux step succeeds. A comment it could not paste stays undelivered and goes into the next turn's input.

### Typing into a lead

Auto-exit closes Pi whenever an agent turn ends normally, whoever started the turn. So if you type into a running lead, Pi exits as soon as the turn that answers you ends. Pressing Escape aborts the turn and keeps Pi open, but the next prompt you send ends the same way. If the lead wrote no ending by then, the runner files a Decision issue saying so.

To keep the session, touch `.runner/takeover` first, as the take-over command does. When Pi exits with that file present and no ending, the launch script starts Pi again on the same session without auto-exit. When you quit Pi, the runner reads the ending. Tell the lead to write one before you quit, or the runner files a Decision issue.

### A quiet lead

While a lead runs, the runner reads `.runner/activity.json`. When nothing has changed for `stallMinutes`, it says so in the status comment and files one issue per turn, marked `runner-stall <KEY> turn N end`, with the commands to watch the lead or stop its session. It does not stop the lead. If you stop the session, the runner starts the same turn again.

## Shared resources

Before it starts or resumes a lead, the runner checks three limits, and logs once why it waits:

- At most `maxLeads` leads run at once.
- On macOS, no lead starts while `memory_pressure -Q` reports less than `minFreeMemoryPercent` free. The kernel's pressure level is too blunt for this: a 48 GB Mac reported level 2 (warn) with 42% free.
- At most one running ticket has `Needs: screen`.

Run one runner per Linear team. launchd starts one instance; the runner takes no lock of its own.

## Config

The runner reads `~/.config/job-runner/config.json`, or the file named by `JOB_RUNNER_CONFIG`. Start from [config.example.json](config.example.json). Use absolute paths.

| Field | Meaning |
| --- | --- |
| `linearTokenCommand` | A shell command that prints a Linear bearer token for the runner's app user |
| `team` | The Linear team key, such as `ENG` |
| `runnerUser` | The app user's name as Linear shows it on the delegate field |
| `decisionAssignee` | The name of the person Decision issues go to |
| `repos` | Linear label name to `{path, base, automerge, ciGate, fullSuiteLabel}`. `path` is a local clone with an `origin` remote. `ciGate` and `fullSuiteLabel` are optional |
| `webhooks` | Bot name to `{url, keyFile}`, for `Report to:` |
| `models` | `lead` and `review`, each a `pi --model` value. The judge uses `review` |
| `thinking` | The `pi --thinking` level. Default `high` |
| `pollSeconds` | Seconds between polls, and between checks on a running lead. Default 30 |
| `maxLeads` | Leads that run at once. Default 2 |
| `minFreeMemoryPercent` | No lead starts while less memory than this is free. Default 20 |
| `stallMinutes` | Minutes without lead activity before the runner flags it. Default 30 |
| `host` | The host name the status comment uses for `ssh`. Default: this Mac's name |
| `worktreeRoot` | The directory for ticket worktrees, and for the judge's verdicts in `.judge/` |

`JOB_RUNNER_PI`, `JOB_RUNNER_GH`, `JOB_RUNNER_TMUX`, and `JOB_RUNNER_MEMORY_PRESSURE` replace those binaries. The tests use them for stubs.

## Run it

Check the config and the queue first. `--dry-run` reads Linear, git worktrees, and tmux, prints the resolved config and each ticket's next step, and exits. It writes nothing:

```sh
node runner/runner.ts --dry-run
```

To run one poll, finish what it started, and exit:

```sh
node runner/runner.ts --once
```

To run it as a daemon on macOS, copy [launchd.example.plist](launchd.example.plist) to `~/Library/LaunchAgents/local.job-runner.plist`, fill in the placeholders, and load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.job-runner.plist
```

The `PATH` in the plist must reach `node` 24 or later, `pi`, `gh`, `git`, and `tmux`. `gh` must be logged in to the account that pushes. The runner must run from a pstack-pi checkout, because it loads `extensions/interactive-subagents/pi-extension/subagents/subagent-done.ts` from there. Pi warns inside tmux unless `~/.tmux.conf` has `set -g extended-keys on`; see Pi's `docs/tmux.md`.

## Test it

```sh
node --test runner/*.test.ts
```

The tests use a fake Linear behind an injected `fetch`, stub `pi`, `gh`, `tmux` and `memory_pressure` scripts, and real git repos in a temp directory. They make no network calls. To check the model, run TLC on `model/Runner.tla` with each `.cfg` file.
