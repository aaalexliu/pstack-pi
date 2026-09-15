---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /skill:swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N local leaf workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

The parent owns orchestration, runtime probes for read-only judges, forge actions, and integration. Children never delegate or resume. Use one live `subagent` request at a time, at most eight tasks per request and four active children without dropping coverage. Use `general-purpose` for read-only exploration and judgment and `poteto-agent` for scoped implementation. Pass the absolute installed poteto-mode skill path to writers. Read-only children cannot run shell commands, edit, or access external tools. Children may use their own `pstack_todo` and return text progress. Missing delegation requires local work with a separate review and disclosure of lost independence.

## Start

The parent opens `pstack_todo` with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the request size or active-child limit.
4. Use configured role `swarm-worker`. For a model race, name each arm's available model up front. Do not invent model identifiers.
5. Give each worker its own writable output when it writes.

## Phase B: Fan out

Use one live `subagent` request at a time with at most eight `tasks` and at most four active children. For N greater than eight, use successive bounded requests without shrinking the declared coverage. Use `general-purpose` for read-only work and `poteto-agent` for scoped writes. Set role `swarm-worker` unless a model race sets exact models. The parent owns all orchestration and integration. Children never delegate. Use separate worktrees or scratch outputs for writes, not just separate branch names in one checkout. Verify the requested base and head locally before each task. No cloud or background resume is promised.

The parent verifies the requested branch and head locally before dispatch. Children never resume. Use live cancellation only if exposed; confirm exit before writable scope reuse.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it. Required coverage still needs a result; retry, absorb it locally, or mark the report incomplete.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
