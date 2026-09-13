---
name: architect
description: Sketch types, signatures, and module boundaries before code, then implement against the chosen shape. Use for architecting or designing non-trivial changes.
disable-model-invocation: true
---

# Architect

Design the shape before filling in logic.

## Ground

1. Track Ground, Sketch, Choose, Implement, and Verify with `pstack_todo`.
2. Run `/skill:how` over every affected subsystem. Run `/skill:why` when existing ownership or layering carries historical constraints.
3. Write the caller's usage first. Name the core data shape, its owner, public operations, and failure states.

## Sketch

Use `/skill:arena` for at least two structurally different candidates. Give each `poteto-agent` task the same requirements and a separate output path. Use role `architect-runner`. Each candidate follows `references/runner-prompt.md` and returns the package in `references/rationale-template.md`.

Screen candidates with `references/design-red-flags.md`. Reject shallow wrappers, leaked internals, temporal layers, scattered mutable state, and APIs that make callers enforce hidden rules.

Choose the candidate that hides the most complexity behind the smallest clear interface. Record rejected shapes and why they lost. Use `/skill:interrogate` when the choice is contested or hard to reverse.

## Implement

Give one `poteto-agent` ownership of the chosen files, or implement locally when delegation is unavailable. The sketch is the contract. A repeated need to escape its types or add special cases means the sketch may be wrong. Re-ground and redesign instead of stacking workarounds.

## Verify

Run focused tests, the real user path, and the full project check. Report every deviation from the sketch. Keep the final rationale with the implemented artifact when future maintainers need it.
