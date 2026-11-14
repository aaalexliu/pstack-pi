# Audit merged PRs against the merge gate

You audit the PRs that runner leads merged, to see whether they kept the merge gate in `lead.md`. You report; you change no code, merge nothing, and reopen nothing. The ticket names the repos (`Repos: owner/name, ...`) and may name a window (`Since: YYYY-MM-DD`); without one, look at the last 14 days.

## 1. List merged PRs that name a ticket

For each repo:

```sh
gh pr list -R <owner/name> --state merged --limit 200 --search "merged:>=<since>" \
  --json number,url,body,headRefOid,mergedAt,reviews,statusCheckRollup > /tmp/audit-<name>.json
```

Keep the PRs whose body has `Fixes <TEAM>-<n>` or `Part of <TEAM>-<n>`, where `<TEAM>` is the team in the start message.

## 2. Find the review record

In `reviews`, a record is a review whose `body` starts with the line `runner-review v1`. The lines after it are `field: value` until the first blank line: `verdict`, `caused_must_fix`, `head`, `round`, `agent`, `model`, `session_id`, `session_path`, `session_title`, `asked_by`. "The record" below means the newest one with `submittedAt` at or before `mergedAt`.

## 3. Flag a PR for each check it fails

1. No record at all, or the newest record's `submittedAt` is after `mergedAt`.
2. The record's `head` is not the PR's `headRefOid` (a commit merged unreviewed).
3. The record's `caused_must_fix` is above 0, or `verdict` is not `clean`.
4. The record's `session_id` equals `asked_by`, or no file exists at `session_path` (`test -f <session_path>`).
5. The record's `round` is above 3 and the ticket has no Decision sub-issue. Check with:

   ```sh
   curl -sf https://api.linear.app/graphql -H "Authorization: Bearer $LINEAR_TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"query($id:String!){issue(id:$id){children{nodes{identifier assignee{name}}}}}","variables":{"id":"<TEAM-n>"}}'
   ```

   A Decision sub-issue is a child assigned to the Decision assignee named in the start message.
6. A check in `statusCheckRollup` has `conclusion` (or, for a status, `state`) of `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE` or `ERROR`.

Read the JSON with `jq` or `node -e`; do not judge from memory. Every flag needs the PR url and the field values that broke it.

## 4. Report

Comment on this ticket: one line per PR checked (`ok` or `FLAG`, the url, the ticket key), each flag under its PR with its evidence, and a count at the top. Then move this ticket to Done.

If anything is flagged, also file one Decision issue as a sub-issue of this ticket, assigned to the Decision assignee: which PRs broke which check, and your recommendation (for repeated flags, enforcement in GitHub, such as required checks or a required review from a bot identity, not in the runner). With no flags, file nothing.
