---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /skill:arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open `pstack_todo` with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything. The parent alone orchestrates and owns external tools and integration; children cannot delegate.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Read `pstack_config` with action `get`. Use the full configured `arena-runner` panel, or `architect-runner` panel for Architect, one candidate per entry unless the user sets another count. Pass each exact entry as `model`, including duplicates and `inherit-parent`, rather than relying on role rotation. With one choice or no panel, run at least two attempts on that choice or `inherit-parent` and disclose the lack of model diversity. Never invent model identities or label repeated samples as different models. If a configured entry is unavailable, use `pstack_config` `list-models`, report the failed seat, and ask before changing the panel. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive. Pick each subagent's role and configured model for the job, per the Subagents section of the **poteto-mode** skill.
4. The parent creates each isolated location and sets its writer's `cwd` there. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Send all N candidates through successive `subagent` requests of at most eight tasks, with four active children. Finish each request before the next; keep every configured panel entry. Each task uses `poteto-agent`, the selected role and explicit model, the same task, shared grounding paths, isolated `cwd`, and instructions to write the artifact and a short rationale naming the alternatives it considered and what it rejected. Keep the private rubric outside candidate inputs. Writers may use local bash and edit only assigned files, not external tools or nested delegation.

Each writer persists its complete artifact, rationale, and check logs, then returns a receipt below 8 KiB with paths, commands, results, and gaps. The parent reads persisted files in full, paging as needed; truncated output is not a complete candidate. If scratch writes are forbidden, use `general-purpose` with `read`, `grep`, `find`, `ls`, and child-local `pstack_todo` only. Bound each proposal below 8 KiB or split it into bounded sections and collect every section before synthesis. Disclose that no runnable candidate was executed. If delegation is unavailable, produce distinct local attempts and disclose the lost independence. Replace dropouts when the invoking skill requires two viable designs; if none survive, report the block rather than invent a winner.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, read the configured `arena-cross-judge` choices with `pstack_config`. Spawn one read-only `general-purpose` judge through `subagent` with role `arena-cross-judge` and an explicit `model`. The judge is never from the parent's family; a model's family is its provider's model line, such as Claude, GPT, or Grok. Try only the entries from another family, in configured order. An `inherit-parent` entry is the parent model, so it never judges. If a configured entry is unavailable, move to the next one. If no configured entry from another family runs, try another-family models from `pstack_config` `list-models` the same way. If none of those runs, skip the judge, pick the base alone in Phase D, and say so. If you do not know the parent's model, try the configured entries in configured order and say that the family check did not run. The judge sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
