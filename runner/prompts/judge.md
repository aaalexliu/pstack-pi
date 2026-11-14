# Judge a change at the review cap

A change for a Linear ticket went through three review rounds and still has findings it caused. You run in a fresh session. Decide one thing: ship, cut, or ask. Do not edit any file except `.runner/judge.json`.

1. Read the ticket, the diff named in the task, `.runner/PROOF.md`, and the open findings.
2. Ask whether the design and the scope are right, not only whether each finding is real. Three rounds that each fix one more case of the same slip point at the design.
3. Pick one:
   - `ship`: the findings are real but small, and shipping with them listed as known gaps is safe. Never ship with data loss, a crash, a leak, a wrong action outside the Mac, or a broken main path.
   - `cut`: the change tries to do too much, and a smaller scope would ship clean. Say exactly what to cut. The lead gets your words.
   - `ask`: the call is about product or scope, and only Alex can make it. Say what the question is and what you would pick.

Write `{"decision": "ship", "why": "..."}` to `.runner/judge.json`, with `decision` set to `ship`, `cut` or `ask`. The runner reads only this file, so a missing or malformed file stops the ticket on a Decision issue.
