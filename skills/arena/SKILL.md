---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /skill:arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Fan out N parallel attempts at the same task. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

## Start

Open `pstack_todo` with one entry per phase before launching anything. The parent alone orchestrates and owns external tools and integration; children cannot delegate.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric. State what success looks like for *this* task, then turn it into 3-6 concrete gradeable criteria. The rubric is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Read `pstack_config` with action `get`. Use the full configured `arena-runner` panel, or `architect-runner` panel for Architect, one candidate per entry unless the user sets another count. Pass each exact entry as `model`, including duplicates and `inherit-parent`, rather than relying on role rotation. With one choice or no panel, run at least two attempts on that choice or `inherit-parent` and disclose the lack of model diversity. Never invent model identities or label repeated samples as different models. Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.
4. Assign output paths. The parent creates each isolated location and sets its writer's `cwd` there. Each candidate writes to its own location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Send all N candidates through successive `subagent` requests of at most eight tasks, with four active children. Finish each request before the next; keep every configured panel entry. Each task uses `poteto-agent`, the selected role and explicit model, the same task, shared grounding paths, isolated `cwd`, and instructions to write both the artifact and a short rationale. Pass the absolute installed path resolved from `../poteto-mode/SKILL.md`. Keep the private rubric outside candidate inputs. Writers may use local bash and edit only assigned files, not external tools or nested delegation.

Each writer persists its complete artifact, rationale, and check logs, then returns a receipt below 8 KiB with paths, commands, results, and gaps. The parent reads persisted files in full, paging as needed; truncated output is not a complete candidate. If scratch writes are forbidden, use `general-purpose` with `read`, `grep`, `find`, `ls`, and child-local `pstack_todo` only. Bound each proposal below 8 KiB or split it into bounded sections and collect every section before synthesis. Disclose that no runnable candidate was executed. If delegation is unavailable, produce distinct local attempts and disclose the lost independence. Replace dropouts when the invoking skill requires two viable designs; if none survive, report the block rather than invent a winner.

Each rationale names the alternatives the candidate considered and what it rejected.

If a candidate fails to produce output, proceed with N-1 and note the dropout in the synthesis record.

## Phase C: Cross-judge

After all Phase B candidates complete, inspect the configured `arena-cross-judge` choices with `pstack_config` and explicitly select a model from a different family than the parent's when available. Otherwise use the configured choice or `inherit-parent` and disclose the limitation. Spawn one `general-purpose` judge with role `arena-cross-judge`, that exact `model`, and the same read-only leaf tool limits. If unavailable, perform the rubric review locally and disclose the missing independent verdict. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with the parent's reading in Phase D, not with the candidates themselves. Don't spawn the judge while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare against the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base on which candidate a future maintainer can extend most easily without breaking invariants. Prefer the cleaner boundary or smaller API when two feel tied, per the Laziness Protocol.

Record the pick and the reason in a short synthesis note alongside the base artifact, including the cross-judge's verdict.

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Fold each graft in by hand, per the **redesign-from-first-principles** principle skill. Don't paste mechanically. The result has to remain coherent under one mental model.

Record what was grafted, from which candidate, and what was rejected and why.

When N candidates converge on the same shape, that is a strong agreement signal. Note the convergence in the record and ship the consensus shape. No graft is needed. When N candidates wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The synthesized artifact has to hold up under the same scrutiny as any other output, per the **prove-it-works** principle skill.

If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (go back to Phase E). Don't paper over.

## Outputs

One synthesized artifact. One short synthesis note alongside, naming the base, the grafts (with source candidate), the rejections, the dropouts if any, and the verification result.
