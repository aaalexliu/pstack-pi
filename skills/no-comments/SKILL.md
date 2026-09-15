---
name: no-comments
description: "Run Comment Sicko on scoped comments and suppressions, fix accepted findings, and offer structural encodings for claimed constraints."
disable-model-invocation: true
---

# No comments

Use Comment Sicko's fresh perspective. The bundled `comment-sicko` is read-only: its report is a proposal, not an applied diff. The parent owns verification, edits, external lookups, and checks.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including staged, unstaged, and relevant untracked working-tree files. State the fence before review; no finding or principle widens it.

## Steps

1. Send the scope to one `subagent` with `agent: "comment-sicko"`, `role: "no-comments"`, and a finite `timeoutMs`. Do not restate the agent's rules. The child uses `read`, `grep`, `find`, and `ls`, returns findings, and neither edits nor delegates. If it is unavailable, report the missing fresh review; a local pass is not a completed independent `/skill:no-comments` run.

2. Inspect the report and any claimed diff before applying it. Reject application-code edits by the reviewer, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Apply the same scrutiny to code-shape findings labeled `MUST FIX` by an older reviewer and to all suppression findings. Reshape flags on surprises in our code stay actionable: do not restore their comments as a substitute for a fix. A keep needs proof of something we cannot change, or an exact protected exception such as a legal header or public API contract. An issue link alone is not proof.

   Audit missed scoped lint and TypeScript suppressions, including `eslint-disable`, `@ts-ignore`, and `@ts-expect-error`. Correctness and safety suppressions remain actionable `MUST KILL` findings; understand the suppressed rule and fix the underlying problem, not just hide it elsewhere. Restore a deletion only with an exact exception and scoped proof.

   Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run `/skill:how` or `/skill:why` on the symbol. The parent gathers external evidence; the child cannot. If a kill remains ambiguous, do not restore it. If a keep is refuted or still ambiguous, delete it. Do not use uncertainty as a reason to keep a workaround story.

   Reject and rerun one invalid report with the failure named. Since the child cannot edit, discard its rejected proposals; revert only parent changes made from that rejected report, preserving unrelated work. If the second report is rejected, report it open and fail this run rather than silently self-approving.

3. Fix trivial accepted flags directly: delete a dead path, drop a parameter, or use the real API. If any accepted fix needs a new code shape, run `/skill:architect` once for the accepted set and nearby code. Stop at the sketch. Architecture shapes; the next step implements.

4. Implement the smallest root-cause fix in scope and remove every named workaround within that fence. If the root cause lies outside scope, land the smallest in-scope fix and report the rest open. `/skill:principle-fix-root-causes` and `/skill:principle-redesign-from-first-principles` guide intent only; neither authorizes widening scope or fixing outside instances. Never bolt on symptom guards.

5. For constraint comments such as `do not remove`, `do not change wording`, or `talk to X before changing`, leave proven keeps about things we cannot change. For actionable constraints, offer the cheapest in-scope type, runtime check, test, or CI lint. Wait for interactive approval before encoding; unattended or eval runs require caller pre-approval. If approved, encode then delete the comment. Otherwise delete the unprotected comment, report the constraint unenforced and open, and sketch any out-of-scope work. Approval to review comments is not approval to expand architecture or enforce new policy.

6. Run format, scoped lint, type checks, and focused behavior tests for changed code. Report deletion count, restored comments and proof, reruns, architect sketch, fixes, encoding offers, approved encodings, unenforced constraints, checks/results, and all other open work.
