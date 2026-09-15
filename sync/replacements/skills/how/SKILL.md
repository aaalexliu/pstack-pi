---
name: how
description: Use for "how does X work", code walkthroughs before changing something, and placement, ownership, or layering questions. Explains subsystem architecture, runtime flow, and onboarding mental models. Use why for motivation.
disable-model-invocation: true
---

# How

Explore the codebase to answer how something works. Give a senior engineer new to the subsystem a working mental model, not annotated source code.

## Step 1. Assess complexity

If scope is unclear, state your interpretation and explore. The user can redirect.

- **Simple:** one module, a small utility, or a narrow function question. No explorers. One explainer explores and explains in one pass. Go to Step 2b.
- **Complex:** a subsystem spanning files or services, a cross-cutting feature, or a full architecture overview. Run parallel explorers first. Go to Step 2a.

When in doubt, take the simple path.

All children use `general-purpose`, with only `read`, `grep`, `find`, and `ls`. No shell commands, writes, external tools, or nested delegation. The parent owns the workflow. Use exact roles below for Pi model routing. If delegation is unavailable, perform the same work locally without claiming independent agents ran.

## Step 2a. Explore

Split complex questions into two to four distinct angles. Send one `subagent` request with a `tasks` array, each task using agent `general-purpose` and role `how-explorer`. Build each task from `references/explorer-prompt.md`, filling in the question and angle. Give children readable reference paths and the inputs they need.

Each explorer owns its angle and goes deep rather than trying to cover the whole subsystem. Wait for every result, then go to Step 3. Keep every request within Pi's eight-task limit and never overlap live delegation requests.

## Step 2b. Direct explain

Send one `subagent` request with agent `general-purpose` and role `how-explainer`. Build its task from `references/explainer-prompt.md`, omitting the explorer-findings section. It must explore and explain in one pass. Go to Step 4.

## Step 3. Synthesize

After all explorers return, send one `general-purpose` task with role `how-explainer`. Use `references/explainer-prompt.md` with every explorer's findings, including gaps. The explainer merges overlap and checks the code to resolve contradictions and fill gaps.

## Step 4. Present

Present the explainer's output. Light edits for clarity or conversation context are fine. Do not substantially rewrite it.

## Output

Use the sections and detail contracts in `references/explainer-prompt.md`, dropping only those that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas. Acknowledge unresolved questions within the explanation.
