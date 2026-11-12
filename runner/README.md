# Job runner

The job runner turns Linear issues into pull requests. It polls one Linear team for issues delegated to its app user, runs fresh `pi -p` sessions to implement, verify, and review each one, and opens a PR. It is one TypeScript file with no dependencies. It is not part of the Pi package, and `npm pack` leaves it out.

## Whose move it is

Linear says whose move it is:

- An issue delegated to the runner's app user is the runner's move. The runner acts on it.
- An issue assigned to you is your move. The runner never assigns anyone.
- An issue with neither owes nobody a move.

When the runner finishes, it sets the issue to `In Review` and clears the delegate. A dispatching bot, or you, decides what comes next.

## What one job does

The runner picks the oldest issue in the team that is in `Todo` and delegated to `runnerUser`. The first label that names a repo in the config picks the repo. If no label matches, the runner comments, clears the delegate, and skips the issue.

Two lines in the issue description change a job:

- `Rounds: 3` sets the maximum number of review rounds. The default is 1.
- `Report to: lead` names a webhook in the config. When the job ends, the runner POSTs `{issue, url, state, pr}` to it with `Authorization: Bearer <key from keyFile>`. `state` is `ready` or `needs-decision`.

Then the runner works through these steps:

1. Set the issue to `In Progress` and comment that it picked the job up.
2. Create a worktree from `origin/<base>` on the branch `job/<issue key>-<title slug>`, for example `job/ale-58-suggest-close-matches`. Linear links the PR by the key in the branch name.
3. Run the implement step, commit the result, and run `.agents/verify`.
4. For each round, run the review step and comment its findings. A finding is open when it has `must_fix` and `caused_by_change` both true. With no open findings, stop. Otherwise run a fix step, commit, and verify again.
5. Push the branch and run `gh pr create`. The PR body holds the issue, `PROOF.md`, the review rounds, and the verify result.

With `Rounds: 1`, the one fix ships without a second review if verify passes. With more rounds, every fix gets reviewed again. If the last allowed review still finds open findings, the job ends there.

A job ends in one of two ways:

| Result | When | What the runner does |
| --- | --- | --- |
| Ready | No open findings and verify passed | Opens a ready PR. If the repo has `automerge`, runs `gh pr merge --auto --squash`, or merges directly when auto-merge is not available. Sets `In Review` and clears the delegate. |
| Needs decision | Open findings at the round cap, a failed verify, or a failed step | Opens a draft PR (none for a failed step), sets `In Review`, clears the delegate, and comments `Needs decision:` with the reasons. |

A failed step includes a `pi` exit other than 0, an implement step that changed nothing, and a review that wrote no valid findings JSON. The comment names the worktree so you can look at it.

Comments on the issue steer the job. Before each step, the runner passes comments it has not shown a step yet.

When the runner starts, it moves every `In Progress` issue delegated to it back to `Todo` with a comment, because no job survives a restart. The next poll picks the issue up again from a fresh worktree.

## Steps and their files

Each step is one fresh `pi` process in the worktree:

```sh
pi -p --model <model> --thinking <thinking> --append-system-prompt runner/prompts/<step>.md "<input>"
```

Implement and fix use [prompts/implement.md](prompts/implement.md) and `models.implement`. Review uses [prompts/review.md](prompts/review.md) and `models.review`. Pick a review model from a different family than the implement model.

Steps hand off through files in `<worktree>/.runner/`, which git ignores:

| File | Written by | Read by |
| --- | --- | --- |
| `PROOF.md` | implement and fix | review and the PR body |
| `findings-<round>.json` | review | the runner |
| `<step>.log` | the runner, with the step's output | you, when a job fails |

The runner never reads model prose. It reads only the findings file, an array of `{must_fix, caused_by_change, where, what, done_when}`.

## The `.agents/verify` contract

A repo opts in by adding an executable `.agents/verify` at its root. The runner runs it from the worktree root after each implement and fix step. Exit 0 means pass. Any other exit means fail, and the runner passes the last 30 lines of output to the next step. A person runs the same file the same way before pushing, so the runner and the person agree on what "green" means. Without the file, the runner notes `no .agents/verify` and treats the check as passed.

This repo's [.agents/verify](../.agents/verify) runs the `TESTING.md` gate for skill text and non-packed tests, plus the runner tests. It takes about 20 seconds.

## Config

The runner reads `~/.config/job-runner/config.json`, or the file named by `JOB_RUNNER_CONFIG`. Start from [config.example.json](config.example.json). Use absolute paths.

| Field | Meaning |
| --- | --- |
| `linearTokenCommand` | A shell command that prints a Linear bearer token for the runner's app user |
| `team` | The Linear team key, such as `ENG` |
| `runnerUser` | The app user's name as Linear shows it on the delegate field |
| `repos` | Linear label name to `{path, base, automerge}`. `path` is a local clone with an `origin` remote |
| `webhooks` | Bot name to `{url, keyFile}`, for `Report to:` |
| `models` | `implement` and `review`, each a `pi --model` value |
| `thinking` | The `pi --thinking` level. Default `high` |
| `pollSeconds` | Seconds between polls. Default 30 |
| `slots` | Jobs that run at once. Default 1 |
| `worktreeRoot` | The directory for job worktrees |

`JOB_RUNNER_PI` and `JOB_RUNNER_GH` replace the `pi` and `gh` binaries. The tests use them for stubs.

## Run it

Check the config and the queue first. `--dry-run` reads Linear, prints the resolved config and what it would do, and exits. It writes nothing to Linear, git, or `pi`:

```sh
node runner/runner.ts --dry-run
```

To run one poll, finish what it picked up, and exit:

```sh
node runner/runner.ts --once
```

To run it as a daemon on macOS, copy [launchd.example.plist](launchd.example.plist) to `~/Library/LaunchAgents/local.job-runner.plist`, fill in the placeholders, and load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.job-runner.plist
```

The `PATH` in the plist must reach `node` 24 or later, `pi`, `gh`, and `git`. `gh` must be logged in to the account that pushes.

## Test it

```sh
node --test runner/*.test.ts
```

The tests use a fake Linear behind an injected `fetch`, stub `pi` and `gh` scripts, and real git repos in a temp directory. They make no network calls.
