---
name: arena
description: Run several independent candidates for one task, pick a base, graft the strongest parts, and verify the result. Use for design or implementation bakeoffs.
disable-model-invocation: true
---

# Arena

Use independent attempts when one early shape would narrow the design too soon.

## Frame

1. Track Frame, Run, Judge, Pick, Graft, and Verify with `pstack_todo`.
2. State one artifact and a rubric with three to six concrete criteria.
3. Choose two to eight candidates. Give each a separate worktree, branch, or scratch path when it writes.

## Run

Send one `subagent` request with a `tasks` array. Use `poteto-agent` and role `arena-runner` for writable candidates. Use `general-purpose` for read-only designs. Every task gets the same requirements, rubric inputs, file pointers, output contract, and its own destination.

The host accepts eight tasks and runs four children at once. Children are local leaf processes. If delegation is unavailable, produce at least two local sketches before choosing.

## Judge

After all candidates finish, run one read-only `general-purpose` task with role `arena-cross-judge`. Give it the rubric and candidate paths, not candidate labels that reveal a preferred answer. Read every candidate yourself while the judge runs.

Score each criterion. Pick the base a maintainer can extend without breaking its invariants. Disagreement with the judge requires a stated reason, not an average.

## Graft and verify

Take only ideas that fit the base's model. Do not paste incompatible layers together. Record the base, grafts, rejected ideas, dropouts, and judge verdict. Run the same focused and real-surface checks against the synthesized result.
