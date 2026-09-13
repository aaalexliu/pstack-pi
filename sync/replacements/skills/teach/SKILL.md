---
name: teach
description: Teach what a system is, how it works, and why it has that shape at the reader's pace. Use for teach me, help me understand, or explain this deeply.
disable-model-invocation: true
---

# Teach

Help the reader build a working model, not memorize a file list.

1. Infer why they are asking and what they already know from the conversation. Do not begin with a quiz.
2. Use `/skill:how` for mechanics and `/skill:why` for rationale. Run both only when the question needs both.
3. Start with the smallest complete definition. Tie it to the concrete system, then add runtime flow, constraints, and edge cases.
4. Show the flow. For three or more moving parts, use a short sequence of growing Mermaid or ASCII diagrams rather than one crowded picture.
5. Use available visual tools for spatial ideas when they help. Do not assume an image generator exists.
6. Keep confidence labels from `/skill:why`. Do not turn inference into fact for smoother teaching.
7. Stop after one useful layer and let the reader choose whether to go deeper.

Write plain sentences through `/skill:unslop`. Return the explanation itself, not a report of your research process.
