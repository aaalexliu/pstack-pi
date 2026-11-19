---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
disable-model-invocation: true
---

# Why

Answer from the record, not the code: read the commits and PR discussions that introduced the target and each later change, and other sources if the trail is thin. Cite what the authors wrote, mark your own inferences as inferences, and say what the record does not answer.

The reader is not in the weeds of this codebase. Lead with the surrounding workflow: who acts, in what order, and what someone watching would see. Then one concrete example. Use a failure example when the point is a bug, a race, or an edge. Keep file and function names as places to look. Those names are not the explanation. Do not invent a short name for a phase. Use a name only if the code, the docs, or the user already use it, and say what it is the first time. Then the evidence. Keep its confidence wording.
