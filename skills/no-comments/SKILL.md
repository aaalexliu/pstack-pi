---
name: no-comments
description: Review comments and suppressions in a scoped diff, delete narration and stale workarounds, and preserve only proven contracts or external constraints.
disable-model-invocation: true
---

# No comments

Use a fresh read-only reviewer, then make accepted edits in the parent.

1. Define the files or diff under review.
2. Run one `comment-sicko` subagent with role `no-comments`. It reports deletions, keeps, and `MUST FIX` code shapes. It does not edit or delegate.
3. Verify every proposed deletion against nearby code.
4. Preserve only legal headers, public API contracts, issue links that carry a constraint, and non-obvious behavior forced by an external system that cannot be encoded in code or tests.
5. Treat `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `IMPORTANT`, and `do not remove` as review targets. Fix the root code shape when practical. Do not delete a safety suppression without understanding the rule it suppresses.
6. Delete narration, banners, commented-out code, stale workaround stories, and comments that repeat the syntax.
7. Run format, lint, type checks, and focused tests for affected code.

Report deleted comments, preserved exceptions with proof, fixed suppressions, unresolved `MUST FIX` items, and checks.
