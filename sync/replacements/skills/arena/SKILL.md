---
name: arena
description: Run parallel candidates for one task, pick a base, graft the strongest parts of the others, and verify the result. Use for arena or when one attempt at a non-trivial artifact would lock in the wrong shape.
disable-model-invocation: true
---

# Arena

Run independent attempts at the same task. Read every candidate end to end. Pick the strongest base, adapt the best ideas from the others, and verify the synthesized result.

## Start

Open `pstack_todo` with Frame, Fan out, Cross-judge, Pick, Graft, and Verify before launching anything. The parent owns the task contract, private rubric, candidate isolation, synthesis note, and final artifact. Children are local leaf workers, not coordinators.

## Phase A: Frame

1. State the artifact each candidate must produce. The common task prompt is the contract.
2. State what success means for this task and derive three to six concrete, gradeable rubric criteria. **Keep the rubric for the parent and cross-judge. Candidates see only the task, not the grading rubric.** Keep rubric files separate from candidate grounding.
3. Read `pstack_config` with action `get`. Use the full configured `arena-runner` pool, or `architect-runner` pool when Architect supplies the task, one candidate per entry unless the user explicitly sets another count. Pass each exact entry as `model` so prior role rotation cannot change panel membership. With a single assignment or no pool, run at least two attempts using that choice or `inherit-parent` and disclose the lack of model diversity. Add attempts when the design space warrants it. Process more than eight candidates in successive bounded requests without dropping configured entries. Prefer distinct model perspectives for judgment-sensitive work; repeated samples are useful for generation but are not different models.
4. Assign isolated output locations, preferably separate worktrees for runnable candidates or per-candidate scratch directories for design artifacts. Follow the **separate-before-serializing-shared-state** principle skill. The parent creates these locations. Give each writer exclusive ownership of its own location and set its `cwd` there. Keep the private rubric outside candidate grounding. Do not let candidates overwrite one another or the final artifact.

## Phase B: Fan out

Send a `subagent` request with a `tasks` array of at most eight entries. Each artifact task uses agent `poteto-agent`, the selected runner role and explicit model, the same task requirements, shared grounding paths, its isolated `cwd`, and an output contract for both the artifact and a short rationale. Each rationale names alternatives considered and what the candidate rejected and why. Include the absolute installed path resolved from `../poteto-mode/SKILL.md` for the writer's shared rules. Do not pass the private rubric or other candidates' outputs.

Writers may use local shell tools, edit their assigned files, and run scoped checks. They cannot delegate or use external tools. The parent gathers external evidence first and supplies it as shared grounding. Each child writes its complete artifact, rationale, and verification logs to its own location and returns a compact receipt with exact paths, commands, results, and gaps, not full file bodies. Keep receipts below 8 KiB. The parent reads persisted files in full, paging as needed, before judging; never persist or judge a truncated tool response as the complete artifact. A missing or incomplete file is a dropout until recovered. Label unexecuted candidate claims as unverified.

For a read-only task that forbids scratch writes, use `general-purpose` instead. It has only `read`, `grep`, `find`, and `ls`. Bound each proposal below 8 KiB or split the requested sections into separate bounded tasks. The parent must collect every section before synthesis and disclose that no runnable candidate was executed.

Pi accepts at most eight tasks and runs at most four children at once. Finish the request before starting another; do not emulate background or nested agents. If delegation is unavailable, produce at least two independent local sketches before choosing and state that the parent supplied them, not independent models.

If a candidate returns no usable output, proceed with N-1 and record the dropout. If none remain, retry or report the block rather than fabricate a winner. If the invoking skill requires two distinct viable designs, replace dropouts or make distinct local candidates before synthesis.

## Phase C: Cross-judge

Only after all candidates finish and the parent has read their persisted outputs, run one `general-purpose` task with role `arena-cross-judge`. Inspect that role's configured choices and explicitly select a model from a different family than the parent's when available; do not rely on pool rotation to enforce that preference. If no such choice exists, use the configured choice or inherit and disclose the limitation. It sees the rubric and candidates by neutral path labels, not labels suggesting a preferred answer. It scores **every candidate on every criterion** and recommends a base with rationale.

Read the candidates yourself while the judge runs when the host permits. Do not judge while candidate files are still changing. The judge is read-only and leaf-only. If unavailable, disclose the missing independent verdict and perform the criterion-level review locally.

## Phase D: Pick a base

Read every candidate end to end before choosing. Score each candidate against every rubric criterion, not on holistic feel. Compare your scoring with the cross-judge's. Agreement supports the pick. Disagreement may reveal bias or an ambiguous rubric: read both rationales, revisit the evidence, and state the reason for the final choice rather than averaging scores.

Pick the candidate a future maintainer can extend most easily without breaking invariants. Break ties in favor of cleaner boundaries or a smaller API, per the **laziness-protocol** principle skill.

Persist a short synthesis note alongside the base artifact, naming the pick, its reason, the criterion scores, and the cross-judge verdict.

## Phase E: Graft

Read each losing candidate once more for ideas worth adapting, usually one or two per candidate rather than most of it. Fold each accepted idea in by hand, per the **redesign-from-first-principles** principle skill. Do not paste mechanically. Keep one coherent mental model.

Record each graft and its source candidate, plus rejected ideas and why they were rejected.

If candidates converge on the same shape, record that strong agreement signal and use the consensus shape. No graft is needed. If they diverge wildly, the task was under-specified: reframe and re-run rather than average incompatible designs.

## Phase F: Verify

The parent verifies the synthesized artifact, not merely the candidates, per the **prove-it-works** principle skill. Run the checks appropriate to the task, including focused behavior tests and real-surface checks for runnable changes. Do not treat candidate or judge claims as proof.

If verification exposes a missed problem, decide whether Phase A was wrong or a candidate already solved it and you missed the graft. In the first case reframe and re-run. In the second return to Phase E. Verify again after the repair. Do not patch over a wrong frame or claim success before the final result passes.

## Outputs

One synthesized artifact and one persisted short synthesis note alongside it. The note names the base and reason, all candidate scores, cross-judge verdict, grafts with source candidates, rejections with reasons, dropouts, convergence or reframing when present, and the final verification commands and results. State any unverified limits.
