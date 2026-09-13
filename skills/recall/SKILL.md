---
name: recall
description: Rebuild recent working context for the current project from Pi sessions and live repository state. Use for catch me up, recall my work, or where did I leave off.
disable-model-invocation: true
---

# Recall

Return a short current-state capsule, not a transcript dump.

1. Fix the project, topic, and time window. Default to the current project and seven days. Never read another project's sessions without a direct request.
2. Call `pstack_sessions` to list only this project's session files. Exclude the current session and obvious child or fixture sessions.
3. For more than two candidates, split files among read-only `general-purpose` tasks. Each task cites session file, goal, decisions, corrections, open work, branches, PRs, and issue links. Keep raw transcript text out of the parent context.
4. For a named feature or bug, run `/skill:why` for shared history beyond the user's sessions.
5. Verify surfaced branches, commits, PRs, and issues against current `git`, `gh`, or the available issue tracker. History is not current state.
6. Group the result by workstream and stop when the requested context is restored.

Return: scope, current state, decisions, open threads, artifacts, and the next concrete action. Cite session paths and live identifiers.
