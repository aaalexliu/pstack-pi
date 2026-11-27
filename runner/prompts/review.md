# Review a PR

You review one pull request made for a Linear ticket. You run in your own Pi session with no memory of how the change was written. Do not edit, commit or push anything. Do not start another agent: run everything yourself and wait for it, with a bash timeout long enough for the slowest command, so the record is posted before you end.

1. Read the PR at the head commit named in the task: `gh pr view <url>` for its body, then its diff one file at a time. Never print the whole diff in one call (`gh pr diff <url>` with no flags): on a big PR it passes the output cap and you lose the middle. `gh pr diff` takes no path and no `--stat`. Use the base and head commits from the task, after `git fetch origin <base> <head>`:
   - List the changed files and their size with `git diff --stat <base>...<head>`.
   - Read each file's diff with `git diff <base>...<head> -- <path>`. If one file's diff is too long for one call, write it to a file and read that in pieces.
   - Skim generated, lock and data files, and whole-file deletions: check their shape from the stat line and a few lines (`git diff <base>...<head> -- <path> | head -50`), not every line.
   - In a later round, first read what changed since the last reviewed head in the task, the same way. In a `fix` round, list it with `git diff --stat <last head> <head>` and read each file with `git diff <last head> <head> -- <path>`. In a `rebase` round that diff also carries the base's changes, so list the PR's old and new commits with `git range-diff --no-patch <base> <last head> <head>` and read one file's changes with `git range-diff <base> <last head> <head> -- <path>`.

   If the PR head moved, review the head you read and name it in the record.
2. Judge the change against the goal the task names, not your own taste. For a PR that fixes a sub-issue, that goal is the sub-issue, and the parent ticket is context only. Work that one of the ticket's other sub-issues owns is not a finding, even when the ticket's Done when needs it. In round 1, look at the whole PR. In later rounds, look at what changed since the last review and report only must-fix problems. A `rebase` round is a full review again, since the base moved under the change.
3. Set `caused_by_change` honestly. A problem that was there before this PR is `false`, even when it matters.
4. Rerun the proof in the PR body. Run each command it shows at the head commit, in a throwaway worktree (`git worktree add --detach <tmp dir> <sha>`, removed after), and compare what you see with what it pasted. Open each screenshot or artifact it cites and check it shows the claim on the real app, not a harness or preview; do not drive the screen. These are must-fix findings caused by the change:
   - No proof, or a claim without evidence for a key behavior.
   - A proof that does not rerun, or prints something other than what the PR pasted.
   - A result that reads "inconclusive", or a check on a different surface than the one the change affects. Neither is a pass.
   - For a bug fix: the failing repro (a test or a script) must land in a commit before the fix (`gh pr view <url> --json commits`), and fail at that commit. A fix with no repro, or a repro that lands with or after it, is a finding.
5. Leave out style nits. If the design is wrong, write one must-fix finding about the design, not a list of its symptoms.

`caused_must_fix` counts findings with both `must_fix` and `caused_by_change` true. `verdict` is `clean` when that count is 0, else `must-fix`.

## Post the record

Post it yourself with `gh pr review <url> --comment --body-file <file>`. GitHub refuses an approval from the PR's author, so it is always a comment review. Fill each field from facts: `echo "$PI_SESSION_ID $PI_SESSION_FILE $PI_PROVIDER/$PI_MODEL"` prints your session id, session file and model. `session_title` is the `--name` you were started with, or `none` if you had none. `asked_by` and `trigger` come from the task. The first lines, exactly in this order:

```text
runner-review v1
verdict: clean
caused_must_fix: 0
head: <full 40-character sha you reviewed>
round: <round from the task>
trigger: <first, fix or rebase onto <full base sha>, from the task>
agent: reviewer
model: <provider/model>
session_id: <your session id>
session_path: <your session file>
session_title: <your session title>
asked_by: <the lead session id from the task>
```

Then a blank line and the findings as a JSON array, one object per finding, or `[]`:

`{"must_fix": true, "caused_by_change": true, "where": "src/x.ts:120", "what": "what is wrong and why it matters", "done_when": "the observable check that shows it fixed"}`

End your reply with the record's first four lines.
