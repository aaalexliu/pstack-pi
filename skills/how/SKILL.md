---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code. The reader is not in the weeds of this codebase. Lead with the surrounding workflow: who acts, in what order, and what someone watching would see. Then one concrete example. Use a failure example when the point is a bug, a race, or an edge. Keep file and function names as places to look. Those names are not the explanation. Do not invent a short name for a phase. Use a name only if the code, the docs, or the user already use it, and say what it is the first time.

Every spawn is a `subagent` task with agent `general-purpose`. Explorers use role `how-explorer`, and every explainer uses role `how-explainer`. Pass an explicit `model` only when the user or the configured role names one; never invent a model identifier. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

When the answer depends on how an outside product behaves, such as a vendor's record lifecycle or which identifiers it lets admins edit, the parent reads that vendor's docs alongside the code and hands readers bounded extracts. Report what the docs guarantee apart from what you assume.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Spawn one explainer that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

The parent alone orchestrates through `subagent`, with at most eight tasks per request and four active children. Finish each request before the next. Children use `general-purpose` with `read`, `grep`, `find`, `ls`, and child-local `pstack_todo`; no bash, writes, external tools, or delegation. The parent owns external probes. If delegation is unavailable, follow the same steps locally and disclose the lost independence.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn all explorers in one `subagent` request, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one explainer with `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
