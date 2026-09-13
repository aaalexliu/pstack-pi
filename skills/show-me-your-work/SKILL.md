---
name: show-me-your-work
description: Keep a compact append-only decision trail for long or high-stakes work so another person can audit choices and evidence.
disable-model-invocation: true
---

# Show me your work

Keep one TSV log for decisions and checked milestones, not every command.

Copy `references/decision-log-template.tsv` to start. Columns are timestamp, phase, decision, reason, evidence, and result. Keep every cell on one line. Evidence is a path, commit, PR, issue, log, trace, or screenshot, not a paragraph.

Use `decisions.tsv` or `.audit/<task>.tsv`. Keep it local unless the work is large enough that a reviewer needs the trail in Git. Append corrections as new rows. Never rewrite history.

Log a route choice, completed phase, failed hypothesis, pivot, external gate, and final verification. Skip routine reads and commands. Prefix spreadsheet formula characters in user-controlled cells with a single quote.

Before handoff, compare the log with `$PI_SESSION_FILE` when available. Do not scan unrelated Pi session directories. Check that each action happened, each evidence pointer resolves, and each result states verified, failed, inconclusive, or open.

For a committed high-stakes trail, seek one independent review with role `review` when delegation is available. Report weak evidence, missing pivots, and risky choices. Continue locally if delegation is unavailable.

Return the log path and an Attention section with review findings or a clear note that independent review was unavailable.
