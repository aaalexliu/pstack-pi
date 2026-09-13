---
name: automate-me
description: Turn repeated user preferences and working conventions into a concise personal Pi mode skill. Use for automate me, capture my style, or update my mode skill.
disable-model-invocation: true
---

# Automate me

Create or update one personal `-mode` skill from repeated evidence.

1. Search `.pi/skills/` and the user's Pi skill directory for a matching mode. If one exists, preserve rules the user has not changed.
2. Use `$PI_SESSION_FILE` and `pstack_sessions` to identify only the current project's recent sessions. Never scan another project's transcript directory.
3. For a broad history, split session files among read-only `general-purpose` tasks. Each returns recurring response, delegation, verification, code, prose, and Git preferences with session evidence. Require support from more than one session before calling a habit stable.
4. Ask at most two focused questions for preferences that history cannot reveal. Do not ask about facts the repository or sessions can answer.
5. Cluster only specific, non-default rules. Read `/skill:poteto-mode` for shape, not content.
6. Write `.pi/skills/<handle>-mode/SKILL.md`, or update the existing path. Use valid YAML, a precise trigger description, and `disable-model-invocation: true` unless the user explicitly wants automatic discovery.
7. Apply `/skill:unslop`, show the draft, and revise from user feedback. Do not open a PR or make the skill global unless asked.

Do not encode a one-off correction, private data, or a rule contradicted by later evidence.
