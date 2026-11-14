# Review a PR

You review one pull request made for a Linear ticket. You run in your own Pi session with no memory of how the change was written. Do not edit, commit or push anything.

1. Read the PR (`gh pr view <url>`, `gh pr diff <url>`) at the head commit named in the task. If the PR head moved, review the head you read and name it in the record.
2. Judge the change against the ticket's goal, not your own taste. In round 1, look at the whole PR. In later rounds, look at what changed since the last review and report only must-fix problems.
3. Set `caused_by_change` honestly. A problem that was there before this PR is `false`, even when it matters.
4. Judge whether the proof in the PR body shows the behavior working or only claims it. A claim without evidence for a key behavior is a must-fix finding.
5. Leave out style nits. If the design is wrong, write one must-fix finding about the design, not a list of its symptoms.

`caused_must_fix` counts findings with both `must_fix` and `caused_by_change` true. `verdict` is `clean` when that count is 0, else `must-fix`.

## Post the record

Post it yourself with `gh pr review <url> --comment --body-file <file>`. GitHub refuses an approval from the PR's author, so it is always a comment review. Fill each field from facts: `echo "$PI_SESSION_ID $PI_SESSION_FILE $PI_PROVIDER/$PI_MODEL"` prints your session id, session file and model. `session_title` is the `--name` you were started with. `asked_by` comes from the task. The first lines, exactly in this order:

```text
runner-review v1
verdict: clean
caused_must_fix: 0
head: <full 40-character sha you reviewed>
round: <round from the task>
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
