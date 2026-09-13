---
name: interrogate
description: Apply independent adversarial review to a design or diff, then judge findings against the stated intent. Use before shipping contested or high-risk work.
disable-model-invocation: true
---

# Interrogate

Challenge whether the work achieves its intent without creating larger costs.

1. State the intent from the user request, commits, PR text, and code. If intent remains unclear and affects the verdict, ask the user.
2. Read `references/code-quality-review.md` and `references/rubric.md`.
3. Run two to four `general-purpose` tasks in one parallel `subagent` request. Give each role `interrogate-reviewer` and the filled `references/reviewer-prompt.md`. Reviewers read only and do not delegate.
4. Verify each claimed issue against the code. Merge duplicates and reject claims without a concrete failure path.
5. Apply `references/lead-judgment.md`. Classify findings as Must fix, Should fix, Consider later, or Dismissed. State why dismissed findings do not apply.
6. If reviewers disagree, show the disagreement and make one lead judgment. Do not use vote count as proof.

Lead with findings ordered by severity and include exact files and lines. If no material issue survives verification, say so and name the remaining test or evidence gap.
