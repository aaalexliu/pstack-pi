---
name: architect
description: Sketch types, signatures, and module structure before code, then stay in the loop during implementation. Use for architecting, designing, or non-trivial work where jumping to code would lock in the wrong shape.
disable-model-invocation: true
---

# Architect

Design before implementing. Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Compare model perspectives, then fill in code against the chosen sketch. If implementation proves it wrong, discard it and redesign.

## Start

Open `pstack_todo` with Ground, Sketch, Agree, Implement, and Scrap before starting. The parent owns these phases, all skill composition, candidate files, synthesis, and integration. Children are leaf workers and never run this orchestration themselves.

## Phase A: Ground the problem

Run `/skill:how` over every affected subsystem. Naming files is not grounding: produce the traced model that skill requires. If the design changes ownership or layering, run `/skill:why` on the existing shape so historical rationale becomes a constraint rather than a guess.

Skip grounding only for genuinely greenfield work with no surrounding system to integrate.

## Phase B: Sketch

Run `/skill:arena` with the design-sketch task and Phase A artifacts. Use role `architect-runner` for candidate tasks, routed through Pi's configured model choices rather than hard-coded provider slugs. Require at least two structurally distinct candidates even when the first looks sufficient, per the **exhaust-the-design-space** principle skill. Seek whole-shape alternatives, not small fixes inside one shape.

Pass `references/runner-prompt.md` and `references/rationale-template.md` to each bounded `poteto-agent` with its own scratch directory or worktree as `cwd`. Each writes the complete design package and rationale only there and returns a compact receipt of paths and checks below 8 KiB. The parent reads those files in full, paging as needed; never use a truncated tool response as a complete package. Design candidates may create scaffolds but must not fill in production implementation before Phase D. Children cannot use external tools or delegate. Reading this skill is context, not permission to invoke Arena or other children. Follow Arena's explicit model-panel selection and batches of at most eight tasks without dropping configured entries. If the scope forbids even scratch writes, use Arena's bounded read-only proposal path instead. If delegation is unavailable, the parent produces at least two distinct local candidates and notes the loss of independent model perspectives.

Each candidate is a **design package**: caller usage, core data shape and owner, type sketch, signatures, module map when needed, and a one-page rationale. Follow the runner's full discipline: dominant access patterns, private transport types, per-actor state where writers might collide, typed invariants, boundary validation, pure business logic, one source of truth, idempotent transitions, and short call chains. Make boundaries visible with `not implemented` bodies, TODO pseudocode for hard logic, and intent/invariant comments.

Write the caller's README-style usage and two or three real call sites first. Derive types from usage and reconcile types to the caller, not the reverse. The rationale must include Problem, Usage (caller's view), Shape, Synthesis decision, Tradeoffs accepted, Alternatives considered, Open questions and risks, and Next implementation step. Candidate-internal alternatives are required separately from comparisons between runners.

Screen **every** candidate with `references/design-red-flags.md` before synthesis. Revise or reject shallow modules, information leakage, temporal decomposition, and pass-through methods. Compare viable designs on interface depth: favor more hidden complexity behind a smaller, simpler public surface. A deep module concentrates capability; a deep call chain scatters it.

Arena returns one synthesized design package and fills the rationale's Synthesis decision with the base, grafts, and rejected ideas with reasons.

## Phase C: Agree (opt-in)

By default, proceed directly to implementation with the synthesized design. There is no human checkpoint.

If the invoker explicitly asks for a checkpoint, such as "with checkpoint" or "stop and show me before implementing", present the synthesized design and pause for sign-off. Do not fill in implementation before that sign-off.

The scaffold and rationale may ship as a separate commit when repository policy and the user's scope permit, per the **foundational-thinking** principle skill. Planned, scoped breakage during fill-in is acceptable, per the **outcome-oriented-execution** principle skill. For adversarial pressure before implementation, run `/skill:interrogate` on the synthesized sketch.

If the user pushes back on the shape, at a checkpoint or afterward, treat the feedback as new Phase A evidence. Re-ground and re-run Phase B before writing more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code and pseudocode with logic. The synthesized sketch is the contract. The parent implements or gives one bounded `poteto-agent` exclusive ownership of named files, then reviews and integrates its result. No nested delegation or overlapping writers.

Surface deviations rather than absorbing them silently. If a function needs an unplanned parameter, ask whether the sketch is wrong, a requirement was missed, or implementation is overreaching. Verify behavior against the sketch with focused checks and the real user path.

## Phase E: Scrap when the architecture is wrong

If implementation repeatedly needs workarounds the sketch cannot absorb, discard the wrong design rather than bolt on fixes, per the **redesign-from-first-principles** and **fix-root-causes** principle skills.

Look for a pattern, not an isolated edge case:

- The same workaround across unrelated code.
- Unrelated edge cases all needing special branches.
- Types needing `any`, casts, or optional fields that are always set in practice.
- A reflex to add a lock when the sketch said state was not shared.
- Callers needing the abstraction's internal rules to use it.
- Two or more independent Phase D deviations with the same shape.

Use judgment. A few edge cases do not condemn an architecture. Some problems are complex. Complexity in data is not the same as complexity in design.

When scrapping:

1. Re-run `/skill:how` over what has been built.
2. Redesign as if the newly learned constraints were day-one assumptions.
3. Subtract before adding, per the **subtract-before-you-add** principle skill. Make the new sketch smaller than the old before it grows.
4. Return to Phase B and re-run Arena, then follow the same checkpoint and implementation rules.

## Outputs

For a small change, one file of new types and signatures. For larger work, a module map plus type definitions. Always ship the rationale alongside, shaped by `references/rationale-template.md`, including caller-first usage and the synthesis decision. Keep it aligned with the final implementation and report deviations and verification results.
