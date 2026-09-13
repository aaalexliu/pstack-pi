# Orchestrate

1. List the workstreams and the artifact each must produce.
2. Run blocking discovery before fan-out.
3. Parallelize only disjoint reads or writes. Read `../../principle-separate-before-serializing-shared-state/SKILL.md`.
4. Use `/skill:swarm` for broad parallel analysis or one `subagent` call with `tasks` for a smaller split. Keep at most eight tasks and expect at most four active children.
5. Give every task exact scope, file pointers, constraints, and output shape. Use `general-purpose` for read-only work and `poteto-agent` for owned edits.
6. Keep shared-file edits under one owner. Do not ask several agents to race on one checkout.
7. Review and integrate each result in input order. Use `/skill:blast-radius` before shipping changes that cross several boundaries. Run one full check after integration.
8. If a child fails or delegation is unavailable, continue the remaining work locally rather than waiting.

Read `../../principle-guard-the-context-window/SKILL.md` before a broad fan-out.
