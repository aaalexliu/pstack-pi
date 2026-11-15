# Audit merged PRs against the merge gate

You audit the PRs that runner leads merged, to see whether they kept the merge gate in `lead.md`. You report; you change no code, merge nothing, and reopen nothing. The ticket names the repos (`Repos: owner/name, ...`) and may name a window (`Since: YYYY-MM-DD`); without one, look at the last 14 days.

Read every value from the JSON these commands print, with `jq` or `node -e`. Do not judge from memory. Every flag needs the PR url and the values that broke it.

## 1. List every merged PR in the window

Page through GitHub search until it is exhausted:

```sh
gh api --paginate -X GET search/issues -f q="repo:<owner/name> is:pr is:merged merged:>=<since>" -f per_page=100 \
  --jq '"total_count=\(.total_count)", (.items[].number)'
```

The `total_count=` line repeats on each page; the bare numbers are PRs. Search returns at most 1000 results. If `total_count` is above 1000, audit what you got and say at the top of the report that coverage is incomplete, with both numbers.

For each number:

```sh
gh pr view <n> -R <owner/name> --json number,url,body,headRefName,headRefOid,mergedAt,reviews
```

Audit every PR whose head branch starts with `job/` (the runner made it) or whose body has `Fixes <TEAM>-<n>` or `Part of <TEAM>-<n>`, where `<TEAM>` is the team in the start message. Flag a `job/` PR whose body names no ticket that way; its ticket key is in the branch name, `job/<team>-<n>-...`.

## 2. Find the review record

In `reviews`, a record is a review whose `body` starts with the line `runner-review v1`. The lines after it are `field: value` until the first blank line: `verdict`, `caused_must_fix`, `head`, `round`, `agent`, `model`, `session_id`, `session_path`, `session_title`, `asked_by`. Other lines, such as `trigger`, are for people reading the PR; ignore them. "The record" below means the newest one with `submittedAt` at or before `mergedAt`.

## 3. Flag a PR for each check it fails

1. No record at all, or the newest record's `submittedAt` is after `mergedAt`.
2. The record's `head` is not the PR's `headRefOid` (a commit merged unreviewed).
3. The record's `caused_must_fix` is above 0, or `verdict` is not `clean`.
4. The record does not trace to a separate review session. Flag it when any of these fail:
   - `session_id` differs from `asked_by`;
   - a file exists at `session_path`;
   - its first line is a `session` entry whose `id` equals `session_id`;
   - its first user message (the first entry with `type` `message` and `message.role` `user`) contains `Review PR <this PR's url>` and names the record's `head` sha and `asked_by`. Print it with:

     ```sh
     jq -rs 'first(.[] | select(.type=="message" and .message.role=="user")) | .message.content | if type=="string" then . else map(.text // empty) | join("\n") end' <session_path>
     ```

   Run the audit on the runner host: `session_path` is a path there. If no record's `session_path` exists on this host, report this check once as "cannot check", not as a flag per PR.

   This shows a review session was started for this head. It does not prove who posted the record: lead and reviewer post with the same `gh` login.
5. The record's `round` is above 3 and the ticket has no Decision sub-issue. Check with:

   ```sh
   curl -sf https://api.linear.app/graphql -H "Authorization: Bearer $LINEAR_TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"query($id:String!){issue(id:$id){children{nodes{identifier assignee{name}}}}}","variables":{"id":"<TEAM-n>"}}'
   ```

   A Decision sub-issue is a child assigned to the Decision assignee named in the start message.
6. The checks on the merged head, as they stood at `mergedAt`, were not all green. Today's `statusCheckRollup` is not enough: a check rerun green after the merge would hide a red one. Fetch every run and status with its time:

   ```sh
   gh api --paginate "repos/<owner/name>/commits/<headRefOid>/check-runs?filter=all&per_page=100" \
     --jq '.check_runs[] | {name, status, conclusion, completed_at}'
   gh api --paginate "repos/<owner/name>/commits/<headRefOid>/statuses?per_page=100" \
     --jq '.[] | {context, state, created_at}'
   ```

   For each check name (or status context), take its newest run completed (or status created) at or before `mergedAt`. Flag the PR when:
   - that run's `conclusion` is not `success`, `neutral` or `skipped`, or that status's `state` is not `success`;
   - a name has runs, but none completed at or before `mergedAt` (it was pending or rerun after the merge);
   - the commit has no check runs and no statuses at all, so green at merge cannot be proven.

## 4. Report

Comment on this ticket: the count checked and flagged at the top, any coverage note, then one line per PR (`ok` or `FLAG`, the url, the ticket key), each flag under its PR with its evidence. Then move this ticket to Done.

If anything is flagged, also file one Decision issue as a sub-issue of this ticket, assigned to the Decision assignee: which PRs broke which check, and your recommendation (for repeated flags, enforcement in GitHub, such as required checks or a required review from a bot identity, not in the runner). With no flags, file nothing.
