---
name: why
description: Investigate why code or a product decision has its current shape using source history, issues, docs, chat, and operational evidence. Use for rationale, regressions, and postmortems.
disable-model-invocation: true
---

# Why

Investigate intent from evidence. Code proves what exists, not why it was chosen.

Read `references/epistemics.md` and `references/source-playbook.md` before synthesis.

## Anchor

1. Name the target, question, paths, and symbols.
2. Collect blame, recent commits, merge or PR identifiers, linked issues, and current behavior.
3. State which evidence categories are available: source control, issue tracker, long-form docs, team chat, observability, error tracking, and product data.

## Investigate

Use available parent-session tools for external systems. Do not invent an MCP name or pass parent-only tools to leaf agents. Run independent categories in parallel when the host supports parallel tool calls. Use `general-purpose` tasks with role `why-investigator` only for local source and Git archaeology.

Apply the matching source playbook: `references/sources/code-archaeology.md`, `references/sources/linear.md`, `references/sources/notion.md`, `references/sources/slack.md`, `references/sources/datadog.md`, `references/sources/sentry.md`, `references/sources/databricks.md`, or `references/sources/incident-postmortem.md`. Record unavailable and searched-with-no-result categories.

## Synthesize

Use one read-only `general-purpose` task with role `why-synthesizer` and `references/synthesizer-prompt.md` when the collected evidence fits the child tool boundary. Otherwise synthesize in the parent. Every claim about intent needs a commit, PR, issue, document, message, metric, trace, or explicit label as inference.

Surface contradictions and stale reasons. Use direct, strong, medium, weak, or speculative confidence from `references/epistemics.md`. Do not turn absence of evidence into proof.

Return the likely rationale, timeline, alternatives, constraints, contradictions, confidence, sources searched, null results, and open gaps.
