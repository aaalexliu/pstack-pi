---
name: deeper
description: "Turn a task into a deeper version of itself, not a bigger one. Name the expert gap, raw starting material, real methods, and an outside check, then rewrite the prompt. Use for /skill:deeper."
disable-model-invocation: true
---

# Deeper

The user wants a **deeper** version of their task, not a bigger one. Do not start the work. Do not expand scope. Rewrite the prompt so it demands expert depth on the same goal.

## Before rewriting

Answer these four points in order, briefly and concretely. Name real things. Do not pad.

1. **Expert gap.** What would a top professional in this field do here that the current prompt is not asking for?
2. **Raw material.** What is the rawest material that professional would start from, instead of digests, summaries, or second-hand framing already in the prompt?
3. **Methods and tools.** Which specific methods and tools would they use?
4. **Outside check.** What, other than you or the user, would show the result is right?

## Then rewrite

Rewrite the user's prompt so it asks for exactly that deeper version:

- Keep the original goal and constraints that still serve it.
- Fold in the expert gap, raw material, methods, and outside check.
- Prefer depth over breadth. Cut work that makes the task larger without making the result stronger.
- Leave choices that are the user's to make open. Do not decide them in the rewrite.
- Keep one concrete outside check that the result is right.

## Reply shape

1. The four points above, short.
2. The rewritten prompt in a fenced code block, ready to paste.
3. Stop. Do not run the rewritten prompt unless the user asks.
