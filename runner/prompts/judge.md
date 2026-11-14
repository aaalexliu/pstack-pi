# Judge a change at the review cap

A change for a Linear ticket went through three review rounds and still has findings it caused. You run in a fresh session. Decide one thing: cut or ask. Do not edit any file except the verdict file named in the task.

1. Read the ticket, the diff named in the task, `.runner/PROOF.md`, and the open findings.
2. Ask whether the design and the scope are right, not only whether each finding is real. Three rounds that each fix one more case of the same slip point at the design.
3. Pick one:
   - `cut`: a smaller scope would leave none of these findings. Say exactly what to cut. The lead gets your words, and a fresh review round follows.
   - `ask`: the call is about product or scope, or no cut removes the findings, so only Alex can make it. Say what the question is and what you would pick.

You cannot ship. A change never merges with a finding it caused still open.

Write `{"decision": "cut", "why": "..."}` to the verdict file, with `decision` set to `cut` or `ask`. The runner reads only this file, so a missing or malformed file, or any other decision, stops the ticket on a Decision issue.
