---
name: setup-pstack
description: "Configure exact Pi models for pstack delegation roles. Use for setup pstack, configure pstack models, or changing role routing."
disable-model-invocation: true
---

# Setup pstack

The parent writes `<Pi agent dir>/pstack-pi/models.json`, a user-level version-1 role map read before each subagent request. This is not Pi's provider catalog `models.json` and not a project rule. Do not commit it.

## 1. Discover and load

Call `pstack_config` with `action: "list-models"` for the exact available `provider/model-id` selectors. Never write an unconfirmed selector. `inherit-parent` is always valid; Cursor's `auto` alias is not supported here. If discovery is unavailable, stop and ask for an available selector list rather than guessing model slugs or modifying provider credentials.

Call `pstack_config` with `action: "get"` to read current assignments. Preserve existing choices as the starting point. Treat unconfigured roles as `inherit-parent` for the proposed setup, and mark configured selectors absent from discovery as needing a choice. A malformed current file is an error to explain and repair with approval, not a reason to silently erase choices.

## 2. Show every role and confirm

Show every role from the current `subagent` schema with its current or proposed default value, not just invalid entries. The bundled role set is:

- `feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment`, `prose`, `hardest`.
- `how-explorer`, `how-explainer`, `how-critics`, `why-investigator`, `why-synthesizer`.
- `reflect-tooling`, `reflect-judgment`, `reflect-divergent`, `reflect-synthesizer`.
- `arena-runner`, `arena-cross-judge`, `swarm-worker`, `architect-runner`, `interrogate-reviewer`.
- `no-comments`, `review`, `test`, `verify`.

Ask whether to accept all choices or change named roles, offering detected selectors plus `inherit-parent`. Use an available structured question tool or compact numbered chat choices. Wait for explicit confirmation before writing, including on repeat runs. If a chosen real selector is unavailable, stop and ask again.

Explain Pi's pool semantics: a role value is a string or nonempty array, and arrays rotate deterministically across requests to that role. Preserve duplicate entries because they weight the rotation. Array length does not itself spawn a panel; each workflow sets a bounded task count. An `arena-cross-judge` pool does not guarantee a different model family, so that workflow must check the resolved model and select a confirmed alternative when needed. `swarm-worker` is the worker default unless an explicit model overrides it for a race or comparison. `inherit-parent` uses the current parent model. Explicit task model selection takes precedence over the role map.

## 3. Write and verify

Write only confirmed choices using exactly this schema (a valid minimal example, not a replacement for the user's full map):

```json
{"version":1,"roles":{"feature":"inherit-parent","review":["inherit-parent"]}}
```

Use only current role names. Rewrite the complete reviewed file so reruns stay idempotent, preserving accepted choices. Resolve the actual Pi agent directory, normally `~/.pi/agent`, including any configured override; do not confuse it with the project `.pi` directory. Create its `pstack-pi` subdirectory if needed. Before writing, require an owner-controlled directory and regular file, neither symlinked nor group/world writable; stop on unsafe paths. The directory is a directory, not a regular file. The parent uses Pi `write`/`edit` and local checks; no child writes user configuration.

Call `pstack_config` with `action: "get"` again and compare every assignment with the approved map. Recheck selectors against discovery and fix any parse, availability, or safety error before reporting success. `get` confirms parseable assignments, not that a live model request has succeeded. Report the exact path and choices, and say new subagent requests read it before admission; no new parent session is required. Rerunning this skill updates it.

## 4. Offer real-app verification once

Check for a project `verify-*` skill or an existing harness that drives the real app. If none exists, offer once: "Want a project-local verification skill so agents can drive the app like a user and prove changes work? I can generate one with /skill:create-verification-skill."

On yes, read and follow the installed `create-verification-skill` from its actual workspace, user, or package path. On no, move on without pushing. Do not create one without acceptance.
