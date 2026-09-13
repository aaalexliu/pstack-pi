# Feature

1. Read the affected code and trace the user-facing path. Use `/skill:how` when the flow spans several files or layers.
2. Name the feature's core data shape and owner. Read `../../principle-model-the-domain/SKILL.md` and `../../principle-boundary-discipline/SKILL.md`. Use `/skill:architect` when the shape or ownership is unclear, and `/skill:arena` when two real designs remain.
3. Put these checkpoints in `pstack_todo`:
   - Blocking facts and failing baseline.
   - Independent workstreams and shared writes.
   - Smallest safe implementation.
   - Real behavior and full verification.
4. Delegate a well-bounded implementation to `poteto-agent` with role `feature` when a separate implementation context helps. Otherwise implement locally. Never wait when delegation is unavailable.
5. Review the files and diff yourself. Keep the smallest design that fully solves the task.
6. Use `/skill:interrogate` before shipping a contested or high-risk diff.
7. Verify the real surface, then run the full repository check.
8. Commit in small units when each unit can pass on its own.

Reply with what changed, the key choice and its reason, checks run, and any open risk.
