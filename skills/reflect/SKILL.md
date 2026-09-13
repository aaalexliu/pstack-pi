---
name: reflect
description: Extract durable workflow lessons from the current Pi session and propose precise skill or structural updates. Use when asked to reflect or after a costly corrected path.
disable-model-invocation: true
---

# Reflect

Turn repeated evidence into a better future workflow. One-off preferences are not lessons.

1. Use `$PI_SESSION_FILE` when available. Do not search other projects' session directories. If no transcript path is available, write a tight session digest.
2. Run three read-only `general-purpose` tasks in one parallel request:
   - role `reflect-judgment` with `references/judgment-reviewer.md`
   - role `reflect-tooling` with `references/tooling-reviewer.md`
   - role `reflect-divergent` with `references/divergent-reviewer.md`
3. Run one read-only synthesis task with role `reflect-synthesizer` and `references/synthesizer.md`. Inline only the bounded reviewer findings, not the whole transcript.
4. Check each proposal against the transcript and current files. Prefer a lint rule, type, test, script, or runtime check over a prose reminder.
5. Present Accepted, Rejected, and Backlog proposals. Wait for explicit approval before changing shared skills or external trackers.
6. Apply approved changes with the smallest scope and run the skill validator or package checks.

If delegation is unavailable, apply the same four lenses locally and disclose that no independent model reviewed the result.
