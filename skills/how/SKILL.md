---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. The reader is not in the weeds of this codebase. Lead with the surrounding workflow: who acts, in what order, and what someone watching would see. Then one concrete example. Use a failure example when the point is a bug, a race, or an edge. Keep file and function names as places to look. Those names are not the explanation. Do not invent a short name for a phase. Use a name only if the code, the docs, or the user already use it, and say what it is the first time.

If the scope is ambiguous, state your interpretation and explore. The user can redirect. When the answer depends on an outside product, the parent reads its documentation alongside the code, gives the reader bounded extracts, and separates documented guarantees from assumptions.

## 1. Explain

For a narrow question, such as how one function or small utility works, skip the subagent: answer in this session, starting from what the session already knows, then read only the files still needed. Otherwise, spawn one `general-purpose` `subagent` with `wait: true` and a finite `timeoutMs` that explores and explains in one pass. Limit its tools to `read`, `grep`, `find`, `ls`, and child-local `pstack_todo`; it must not write or delegate. If delegation is unavailable, explore and explain in this session. Give it the user's question and this brief:

> You are writing an architectural explanation for a senior engineer. Explore the codebase and write an explanation that a senior engineer unfamiliar with this area could read and walk away with a solid mental model. They should understand the architecture well enough to start working in it confidently. You have read-only access to the codebase.

## 2. Present

Present the subagent's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.
