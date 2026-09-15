---
name: why
description: Investigate why code has its current shape, design rationale, regressions, postmortems, and data-backed thresholds. Search source history, issues, docs, chat, infrastructure observability, error tracking, and product analytics. Use how for runtime behavior.
disable-model-invocation: true
---

# Why

Investigate motivation and intent. `how` explains what code does. `why` explains the forces that shaped it. Code alone does not prove intent.

## Operating posture

Work as a careful, cautious, precise investigator. Read `references/epistemics.md` in full. Every claim uses its tiers: **Direct**, **Supported**, **Inferred**, **Speculative**, **Unknown**. Explicit textual rationale is Direct. Converging indirect evidence is Supported. Inferred claims show the reasoning and use hedges. Speculative claims remain marked hypotheses. Unknown is a valid result, with the searches that failed to answer it.

## Step 1. Understand the target and question

Identify the code, pattern, feature, or decision and whether the ask concerns rationale, tradeoffs, an edge case, an external constraint, dead code, or broad history. If the referent is vague, infer it from the conversation, state your interpretation briefly, and proceed so the user can redirect.

## Step 2. Establish the code anchor

The parent owns the code anchor: file paths and line ranges, key symbols, an initial recent commit list, PR numbers from subjects such as `(#1234)`, and linked ticket IDs. Read current code for orientation, then collect history before assigning readers.

Run in the parent, not a read-only child:

```bash
git blame -L <start>,<end> <file>
git log --follow -p -- <file>
git log --oneline -20 -- <file>
git log -1 --format=%B <commit>
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

Fetch full PR bodies and discussion for substantive commits. Expand beyond last-touch commits with the pickaxe, full diffs, co-changes, earlier origins, and rename history in `references/sources/code-archaeology.md`. Do not treat the newest commit as authoritative. If Git, `gh`, authentication, or repository history is unavailable, report the concrete gap rather than inventing evidence.

## Step 3. Investigate in parallel by default

### Discover coverage

Inspect the parent session's actual tools and resource descriptions. Do not invent MCP names or assume a service is installed. Map each available source to its primary evidence category; record ambiguous classifications. Aim for complete coverage, not the smallest search.

Read `references/source-playbook.md`. Its example tools are guides to adapt to the tools actually available, not a promise of child access.

| Category | What it uniquely contributes | Playbook |
| --- | --- | --- |
| Source control history | Implementation-time rationale in commits, review, comments, and tests. Always investigate. | `references/sources/code-archaeology.md` |
| Issue / ticket tracker | Product or business forcing functions external to engineering. | `references/sources/linear.md` |
| Long-form documents | Design rationale written before code, alternatives, and decisions. | `references/sources/notion.md` |
| Real-time team chat | Deliberation that never reached a document, especially with a thin paper trail. | `references/sources/slack.md` |
| Infrastructure observability | Runtime conditions behind timeouts, retries, limits, and circuit breakers. | `references/sources/datadog.md` |
| Error / exception tracking | Specific exceptions and error trajectories behind guards and corrective code. | `references/sources/sentry.md` |
| Product analytics warehouse | Product and data reality behind flags, experiments, migrations, and numeric thresholds. | `references/sources/databricks.md` |

### Ownership and prompts

Keep one investigation lane per available category, each owning exactly one source or tool. Do not make one reader cover multiple MCPs. If several sources match, keep separate source-scoped findings under that category. Run independent parent searches in parallel when supported.

The parent runs all Git commands, `gh`, and external searches. `general-purpose` children have only `read`, `grep`, `find`, and `ls`: no bash, writes, external tools, or delegation. Use role `why-investigator` for local code/document reading and analysis of parent-collected evidence, not live Git archaeology. Always assign the source-control lane when delegation is available; otherwise do that investigation locally. Pass full evidence inline or in parent-written local evidence files with original citations and queries. Children return requests for missing history or external verification; the parent fetches it and follows up.

Build each lane from `references/investigator-prompt.md`, the single matching category playbook, the code anchor, and the original question. Fill every template input. Explicitly replace commands and external calls in child tasks with analysis of supplied evidence and follow-up requests. The parent follows those playbooks for live searches. Use one `subagent` request with a `tasks` array for independent local readers, at most eight tasks, with at most four running at once. Finish a request before starting another. If delegation is unavailable, keep the same source boundaries and output template in the parent.

Apply the investigator template in full: search wide then narrow, read whole PRs, tickets, documents, and threads, preserve exact quotes and locations, record verbatim queries, and surface contradictions and counterfactuals. Follow links within the assigned source. Return cross-source references as Additional Leads for the parent to route to the right lane. Do not substitute evidence about a nearby feature for the target.

Each lane returns **Source**, **What I Searched**, **Direct Evidence Found**, **Indirect / Circumstantial Evidence**, **Contradictions**, **Gaps**, and **Additional Leads**, with authors, dates, locations, inference chains, and alternative readings where available. Distinguish searches actually run by the parent from searches still requested.

### Defensive code and incident history

For null checks, retries, timeouts, rate limiting, feature flags, egress guards, or OOM handlers, add `references/sources/incident-postmortem.md` to every available source lane. Search incident history around introduction and ship dates. Fetch full postmortems and action items. Correlate incident IDs, tickets, chat, commits, traces, error trajectories, and product events without claiming timing alone proves causation. This is a cross-cutting angle, not an eighth category.

### Justified skips only

Record every skipped category in the final Sources Consulted block. Valid reasons are:

- No matching source or tool is available. This is a coverage gap, not a choice. Also report access failures or retention limits precisely.
- The source is **provably irrelevant**, not merely probably irrelevant. State the proof, such as a build-only target with no runtime path for error tracking.

A narrow question does not waive this rule. Document null searches rather than skipping them. A trivial single-commit question may be answered inline only after confirming searches of all seven available categories would be redundant and saying why. This exception should be rare.

## Step 4. Synthesize

Build from `references/synthesizer-prompt.md` with all findings, null results, skipped-source reasons, the full code anchor, original question, and `references/epistemics.md`. Use one `general-purpose` task with role `why-synthesizer` when the evidence can be read locally; otherwise synthesize in the parent.

The template's external citation checks belong to the parent in Pi. Spot-check external citations before handing off, supply their text and source locations, and resolve any new verification requests before presentation. The child can spot-check local citations with its read-only tools. Neither lane modifies external state.

Read all findings, merge duplicate references, surface both sides of contradictions, and calibrate every claim. Treat a hypothesis embedded in the user's question as one candidate, not a conclusion to confirm. Do not rationalize the current shape, erase stale reasons, or treat missing evidence as proof of absence. Follow the template's full quality checklist and revise any claim that fails it.

## Step 5. Present

Present the synthesis with light clarity or context edits only. Do not rewrite its confidence language.

Use the template's sections: **The Question**, **The Code in Question**, **What We Found**, **What We Can Reasonably Infer**, **Competing Hypotheses**, **What We Don't Know**, **Sources Consulted**, and **Confidence Summary**. Omit conditional inference or hypothesis sections only when they do not apply. Keep Direct and Supported findings cited, Inferred reasoning hedged, Speculative alternatives explicit, and Unknown gaps specific.

Sources Consulted has one line per investigator, covering all seven categories including null results and skips with reasons. Include actual queries, paths, commits/PRs, tickets, pages, chat ranges, operational items, or warehouse tables, time windows, and numeric summaries as appropriate.

If the question precedes a code change, add a **Preserve / Change / Avoid / Risk** constraint set after Sources Consulted: invariants and intent to preserve, justified changes, rejected or harmful approaches to avoid, and uncertainty or regression risks. Tie each constraint to the lineage evidence and its confidence rather than inventing design rules.
