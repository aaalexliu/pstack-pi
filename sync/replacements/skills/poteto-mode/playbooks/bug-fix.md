# Bug fix

1. Reproduce the bug end to end through the closest available user surface. Record the failing command, input, and observed output.
2. Trace the symptom to its first wrong state. Read `../../principle-fix-root-causes/SKILL.md`.
3. Add a focused regression test that fails for the observed behavior.
4. Name the broken data shape or boundary before changing logic. Read `../../principle-model-the-domain/SKILL.md` and `../../principle-boundary-discipline/SKILL.md`.
5. Make the smallest root-cause fix. Delegate a bounded implementation to `poteto-agent` with role `bug-fix` when a separate context helps. Continue locally if delegation is unavailable.
6. Run the regression test, nearby tests, the real reproduction, and the full repository check.
7. Inspect the final diff for unrelated edits and stale comments.

Reply with the reproduction, root cause, fix, checks, and remaining risk.
