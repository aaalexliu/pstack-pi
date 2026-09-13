# Multi-phase plan

1. Define the target state and proof that the whole change works.
2. Split work into phases that each leave a useful, checked repository state. Read `../../principle-sequence-verifiable-units/SKILL.md`.
3. For each phase, record scope, dependencies, files, checks, rollback path, and exit criteria.
4. Put only the current phase's concrete steps in `pstack_todo`.
5. Finish and verify one phase before starting the next. Commit each independent phase.
6. Keep a short decision log when later phases depend on earlier choices. Use `/skill:show-me-your-work` when the work needs a durable, checked record.
7. Replan when evidence changes the target, not merely because implementation is awkward.

Do not preserve a temporary compatibility layer unless a real caller needs it. Prefer a direct path to the target design.
