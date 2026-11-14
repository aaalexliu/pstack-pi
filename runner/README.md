# Job runner

The job runner turns Linear issues into pull requests, reports, or questions. It polls one Linear team for issues delegated to its app user and runs each one as a single interactive Pi lead in a detached tmux session. The runner, not the lead, owns verify, review, merge, and everything it posts to Linear. It is one TypeScript file with no dependencies. It is not part of the Pi package, and `npm pack` leaves it out.

## Whose move it is

Linear says whose move it is:

- An issue delegated to the runner's app user is the runner's move. The runner acts on it.
- An issue assigned to you is your move. The runner assigns you only Decision issues, never work tickets.
- An issue with neither owes nobody a move.

## What one ticket does

The runner picks the oldest issue in the team that is in `Todo` and delegated to `runnerUser`. The first label that names a repo in the config picks the repo. If no label matches, the runner comments, clears the delegate, and skips the issue.

Lines in the issue description change a ticket:

- `Lead model: anthropic/claude-opus-5-5` and `Review model: openai/gpt-5.5` override `models` for this ticket. `Implement model:` still works as another name for `Lead model:`.
- `Needs: screen` marks work that drives the screen, a browser, or a simulator. Only one such ticket runs at a time.
- `Report to: desk` names a webhook in the config. When the ticket ends or waits, the runner POSTs `{issue, url, state, pr}` to it with `Authorization: Bearer <key from keyFile>`. `state` is `ready`, `done`, or `needs-decision`.

The [intake skill](../additions/skills/intake/SKILL.md) tells any session that files a ticket to write three headings, Goal, Reference, and Not doing, then delegate it. The runner does not check them. A lead that finds them missing writes its own reading in its start note.

Then the runner:

1. Creates a worktree from `origin/<base>` on the branch `job/<issue key>-<title slug>`, for example `job/ale-58-suggest-close-matches`, and sets the issue to `In Progress`.
2. Starts the lead: `tmux new-session -d -s <KEY>` running `pi --session-id <uuid> "<ticket and comments>"` in the worktree, with the [lead prompt](prompts/lead.md). The environment sets `PI_SUBAGENT_AUTO_EXIT=1` and loads pstack-pi's `subagent-done.ts`, so Pi exits when the lead's turn ends. It also writes an activity file to `.runner/activity.json`.
3. While the lead runs, posts its `.runner/start.md` as a comment and pastes new human comments on the ticket into the session.
4. When Pi exits, reads `.runner/ending.json` and acts on it.

## Endings

The lead ends by writing `.runner/ending.json` with one of three kinds:

| Kind | Fields | What the runner does |
| --- | --- | --- |
| `report` | `body` | Posts the body as a comment, sets `Done`, and clears the delegate. |
| `change` | `full_suite`, `full_suite_why`, plus a non-empty `.runner/PROOF.md` | Runs the gate below. |
| `decision` | `question`, `recommendation`, up to 3 `options` of `{option, pick_this_if}`, optional `context` | Files a Decision issue. |

A missing or invalid ending is itself a Decision issue that names what was wrong.

### Decision issues and answers

A Decision issue is a new issue assigned to `decisionAssignee`, marked as blocking the work ticket. It holds one question, the recommendation first, and the options. The work ticket stays `In Progress` and delegated to the runner. The lead has exited, so the ticket holds no lead slot while it waits.

The runner saves each waiting ticket (key, session id, worktree, Decision issue) in `stateFile`. Each poll, it checks the Decision issues. When one is `Done` or `Canceled`, the runner resumes the lead in a new tmux session with the same name, running `pi --session-id <same uuid> "<the comments on the Decision issue>"`. So answer in a comment, then close the issue.

The runner also files a Decision issue when it cannot go on: a change with no commits, a repo with no `.agents/verify`, a verify that still fails after 3 tries, a judge that asks, or any error.

### The gate for a change

1. Commit the tree. A change with no commits on the branch becomes a Decision issue.
2. Run `.agents/verify`. If it fails, resume the lead with the output, without a review. After 3 failures, file a Decision issue.
3. Run a review step: a fresh `pi -p` with [prompts/review.md](prompts/review.md) on `models.review`, which writes `.runner/findings-<round>.json`. Round 1 reviews the whole change. Later rounds review only the latest fix. A finding blocks only when `must_fix` and `caused_by_change` are both true.
4. With no blocking findings, ship. Otherwise resume the same lead session with the findings, and go back to step 1 when it ends again.
5. At round 3 with blocking findings still open, run a judge: a fresh `pi -p` with [prompts/judge.md](prompts/judge.md) that writes `.runner/judge.json` as `{decision, why}`.
   - `ship` ships with the open findings listed as known gaps in the PR.
   - `cut` resumes the lead once to cut scope. If that fix still has blocking findings, the runner files a Decision issue.
   - `ask` files a Decision issue.

To ship, the runner pushes the branch and opens a PR whose body holds the issue, `PROOF.md`, the review log, and the verify result. If the lead set `full_suite` and the repo has a `fullSuiteLabel`, it adds that label. With `automerge`, it runs `gh pr merge --auto --squash`, or merges directly when auto-merge is not available. Then it sets `In Review` and clears the delegate.

The runner never reads model prose. It reads only `ending.json`, the findings files, and `judge.json`.

## The `.agents/verify` contract

A repo opts in by adding an executable `.agents/verify` at its root. The runner runs it from the worktree root before each review. Exit 0 means pass. A person runs the same file the same way before pushing, so the runner and the person agree on what "green" means.

Verify fails closed. A repo with no executable `.agents/verify` does not merge, and the ticket waits on a Decision issue. Set `"ciGate": true` on the repo to say its required CI checks are the gate instead. The runner then only turns on auto-merge, and files a Decision issue if GitHub refuses.

This repo's [.agents/verify](../.agents/verify) runs the `TESTING.md` gate for skill text and non-packed tests, plus the runner tests.

## The status comment

Each ticket gets one runner comment, edited in place at each step, so Linear does not notify you for every step. It shows the state, the host, the tmux session, the Pi session id, the worktree, and three commands:

| Command | What it does |
| --- | --- |
| `ssh -t <host> tmux attach -t <KEY>` | Watch or steer the lead. What you type reaches it as a steering message. |
| `ssh -t <host> 'touch <worktree>/.runner/takeover && tmux attach -t <KEY>'` | Take over. Auto-exit stays off until you quit Pi. |
| `ssh -t <host> 'cd <worktree> && git worktree add -B <branch>-quiz <worktree>-quiz HEAD && cd <worktree>-quiz && tmux new -s <KEY>-quiz pi --fork <session id>'` | Quiz a fork of the lead in its own worktree, without touching the lead. |

### Typing into a lead

Auto-exit closes Pi whenever an agent turn ends normally, whoever started the turn. So if you type into a running lead, Pi exits as soon as the turn that answers you ends. Pressing Escape aborts the turn and keeps Pi open, but the next prompt you send ends the same way. If the lead wrote no ending by then, the runner files a Decision issue saying so.

To keep the session, touch `.runner/takeover` first, as the take-over command does. When Pi exits with that file present and no ending, the launch script starts Pi again on the same session without auto-exit. When you quit Pi, the runner reads the ending. Tell the lead to write one before you quit, or the runner files a Decision issue.

## Shared resources

Before it starts or resumes a lead, the runner checks three limits, and logs once why it waits:

- At most `maxLeads` leads run at once.
- On macOS, no lead starts while `memory_pressure -Q` reports less than `minFreeMemoryPercent` free. The kernel's pressure level is too blunt for this: a 48 GB Mac reported level 2 (warn) with 42% free.
- At most one running ticket has `Needs: screen`.

## Restart

On start, the runner looks at each `In Progress` issue delegated to it:

- A ticket waiting on a Decision issue keeps waiting.
- A ticket with a live tmux session keeps running, and the runner waits for it again.
- A ticket with a saved session id resumes, with a message that the runner restarted.
- Any other ticket goes back to `Todo` with a comment.

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
| `host` | The host name the status comment uses for `ssh`. Default: this Mac's name |
| `worktreeRoot` | The directory for ticket worktrees |
| `stateFile` | Where the runner saves its tickets. Default `~/.config/job-runner/state.json` |

`JOB_RUNNER_PI`, `JOB_RUNNER_GH`, `JOB_RUNNER_TMUX`, and `JOB_RUNNER_MEMORY_PRESSURE` replace those binaries. The tests use them for stubs.

## Run it

Check the config and the queue first. `--dry-run` reads Linear, prints the resolved config and what it would do, and exits. It writes nothing to Linear, git, tmux, the state file, or `pi`:

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

The tests use a fake Linear behind an injected `fetch`, stub `pi`, `gh`, `tmux` and `memory_pressure` scripts, and real git repos in a temp directory. They make no network calls.
