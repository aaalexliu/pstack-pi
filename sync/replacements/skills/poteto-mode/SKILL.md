---
name: poteto-mode
description: Pstack's working mode for planned, delegated, concise, and verified engineering work in Pi. Use for poteto mode, multi-step code changes, and autonomous work.
disable-model-invocation: true
---

# Poteto mode

Use this mode for non-trivial work. Keep the lead role: understand the task, choose the plan, delegate bounded work when it helps, review every change, and verify the real result.

## Start

1. Create or refresh the checklist with `pstack_todo`.
2. Read the matching playbook before changing code:
   - New behavior: `playbooks/feature.md`
   - Defect: `playbooks/bug-fix.md`
   - Read-only research: `playbooks/investigation.md`
   - Uncertain design: `playbooks/prototype.md`
   - Work with several phases: `playbooks/multi-phase-plan.md`
   - Independent workstreams: `playbooks/orchestrate.md`
3. Read each principle skill named by that playbook before relying on it.

## Rules

- Reproduce defects through the same surface the user sees before fixing them.
- Name the core data shape before writing logic. Apply **principle-model-the-domain**.
- Keep function and process boundaries explicit. Apply **principle-boundary-discipline**.
- Keep shared mutable state small. Apply **principle-separate-before-serializing-shared-state**.
- Remove needless layers before adding new ones. Apply **principle-laziness-protocol**.
- Split long work into checked units. Apply **principle-sequence-verifiable-units**.
- Encode a discovered rule in code, tests, or structure. Apply **principle-encode-lessons-in-structure**.
- Use types to rule out invalid states. Apply **principle-type-system-discipline**.
- Verify the actual artifact, not a proxy. Apply **principle-prove-it-works**.
- For user-facing choices, prefer the better experience over the cheaper implementation. Apply **principle-experience-first**.
- Do not stop on an answerable implementation question. Probe it, choose, and continue. Apply **principle-never-block-on-the-human**.
- Protect the parent context. Point subagents at files and request bounded results. Apply **principle-guard-the-context-window**.
- Fix root causes rather than masking symptoms. Apply **principle-fix-root-causes**.

## Delegation

Use the `subagent` tool when a separate context or independent review helps.

- Use `poteto-agent` for implementation. Give it exact file scope, the chosen data shape, constraints, and success checks.
- Use `general-purpose` for read-only exploration and review.
- Use `tasks` only for independent work. The host accepts up to eight tasks and runs up to four at once.
- Children are leaf agents. They cannot delegate.
- Review the resulting files and diff yourself. Do not forward a child's summary as your own.
- If delegation is unavailable, continue locally and record that fact. Do not wait.

## Finish

1. Run focused checks, then the repository's full check.
2. Exercise the real user-facing path when one exists.
3. Inspect the final diff for accidental scope, stale comments, and generated files.
4. Update `pstack_todo`.
5. Report what changed, what passed, and any real open risk. Name only principles that changed a decision.
