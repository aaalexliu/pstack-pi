---
name: swarm
description: Fan out independent workers for coverage, races, or separate slices, then aggregate one evidence-backed result. Use when parallel work has clear boundaries.
disable-model-invocation: true
---

# Swarm

Parallelize independent work without creating shared-write races.

## Frame

1. Track Frame, Fan out, Drain, and Verify with `pstack_todo`.
2. State the done predicate and output from each worker.
3. Choose partition, race, or mixed mode. For races, state how the winner will be judged before spawning.
4. Give each writer a separate worktree, branch, or scratch path. Keep one owner for every shared file.

## Fan out

Use one `subagent` request with up to eight `tasks`. Use role `swarm-worker`, unless a model race sets exact models per task. Each brief includes goal, scope, forbidden paths, file pointers, checks, and a `PASS`, `ISSUES`, or `BLOCKED` report shape.

The host runs at most four children at once and keeps result order stable. Children are local leaf agents. Do not promise cloud execution, background resume, or nested coordination.

## Drain and verify

Read every result. Check evidence rather than trusting summaries. Retry only failed slices and record dropouts. Integrate outputs under one owner, then run one full check against the combined artifact. If delegation is unavailable, process the same slices locally in order.

Return the mode, worker table, evidence, combined result, dropouts, and verification verdict.
