---
name: figure-it-out
description: Design and execute a bespoke workflow for an unclear but testable outcome. Use when no existing playbook fits and the user wants the agent to determine the path.
disable-model-invocation: true
---

# Figure it out

Own the route to a concrete result when no existing workflow fits.

1. State the done predicate in observable terms. Separate facts you can probe from genuine product choices.
2. Read relevant files and run `/skill:how`. Use `/skill:why` when history constrains the solution.
3. Generate two or three plausible routes. Use `../poteto-mode/playbooks/prototype.md` or `/skill:arena` when a small run can distinguish them.
4. Write the chosen phases in `pstack_todo`. Each phase ends with a check and leaves a useful repository state.
5. Use `/skill:swarm` only for independent slices. Keep shared writes under one owner.
6. Execute until the predicate passes, evidence disproves the route, or an external irreversible action needs approval. Replan from evidence rather than waiting for guidance.
7. Verify the real surface and run project checks. Keep a decision trail with `/skill:show-me-your-work` when the route spans several phases.

Report the predicate, route chosen, evidence that changed it, checks, and any unresolved external gate.
