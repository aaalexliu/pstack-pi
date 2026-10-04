---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the user-level Pi role map that overrides the skill defaults, including an optional reasoning-budget preference. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
disable-model-invocation: true
---

# Setup pstack

The parent writes `<Pi agent dir>/pstack-pi/models.json`, a user-level version-1 role map that sets pstack's model per role. Resolve the configured Pi agent directory, normally `~/.pi/agent`; this is not the provider catalog `models.json` or a project rule. Do not commit it. Children do not write user configuration or access external services.

## Steps

### 1. Detect available models

Call `pstack_config` with `action: "list-models"` to enumerate the exact `provider/model-id` selectors available in this session. That is the dependable source. If you cannot detect any, ask the user to paste the slugs they have access to. Never write a real slug you have not confirmed is available. The alias `inherit-parent` is always valid even though it is not a detected slug. Pi does not accept `auto`.

### 2. Load current state

The default role-to-model mapping is the JSON shape shown in step 5 below. Call `pstack_config` with `action: "get"`; if a role map already exists, read it and treat its values as the current choices. Otherwise start from those defaults. A malformed file is an error to explain and repair with approval, not a reason to erase choices. Unknown roles from an older map, if any, are errors to explain rather than silent drops.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer an available structured choice tool or numbered chat choices over free text. Offer these four options with these exact labels, and name the current budget when a prior run recorded one.

- `unlimited - keep max`
- `large - xhigh reasoning`
- `medium - high reasoning`
- `small - medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults (all roles `inherit-parent` until the user picks concrete selectors), and on a re-run keep any role the user already set to a real slug or `inherit-parent`. `unlimited` leaves every selector as in that table. `large`, `medium`, and `small` only apply when a role already uses a real `provider/model-id` whose id encodes an effort token. The effort token is the last path segment token, or the one before a trailing `fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. If the result is not in `list-models`, use the same family's detected selector with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` does not change. Record the chosen budget label in the confirmation reply; `models.json` has no budget field.

**(c) Show the roles and confirm.** Show every role from the current `subagent` schema with its model, marking any real slug not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` (this role runs on the parent chat model) as the options. Prefer an available structured choice tool or numbered chat choices over free text. Wait for explicit confirmation before writing, including on repeat runs. Role values may be a selector or a nonempty list. Lists rotate deterministically across requests to the role; preserve duplicate entries because they weight that rotation. A list does not itself spawn a panel. Panel workflows (arena runners, architect runners, interrogate reviewers) must select each configured entry explicitly, alias entries included, within bounded requests. For `arena-cross-judge`, Arena selects a value whose model family differs from the parent's when possible; the pool alone does not guarantee diversity. `swarm-worker` is the default model for every worker unless a race or comparison assigns another model per arm. Explicit task model selection takes precedence over the role map.

### 4. Validate

Every real slug written must be in the detected set. `inherit-parent` always passes. Reject unknown roles, empty lists, invalid selectors, extra fields, and versions other than 1. If a chosen real slug is not available, stop and ask again.

### 5. Write the role map

Write `<Pi agent dir>/pstack-pi/models.json` with exactly `version` and `roles`, using the current role keys. Before writing, require owner-controlled paths. Existing directories must be directories and the config must be a regular file, neither symlinked nor group/world writable; stop on unsafe paths. Create the `pstack-pi` directory and config if absent. Write only the approved choices. Overwrite the whole file so re-runs stay idempotent. Shape:

```json
{
  "version": 1,
  "roles": {
    "feature": "inherit-parent",
    "refactoring": "inherit-parent",
    "bug-fix": "inherit-parent",
    "perf-issue": "inherit-parent",
    "hillclimb": "inherit-parent",
    "judgment": "inherit-parent",
    "prose": "inherit-parent",
    "hardest": "inherit-parent",
    "how-explorer": "inherit-parent",
    "how-explainer": "inherit-parent",
    "how-critics": "inherit-parent",
    "why-investigator": "inherit-parent",
    "why-synthesizer": "inherit-parent",
    "reflect-tooling": "inherit-parent",
    "reflect-judgment": "inherit-parent",
    "reflect-divergent": "inherit-parent",
    "reflect-synthesizer": "inherit-parent",
    "arena-runner": "inherit-parent",
    "arena-cross-judge": "inherit-parent",
    "swarm-worker": "inherit-parent",
    "architect-runner": "inherit-parent",
    "interrogate-reviewer": "inherit-parent",
    "no-comments": "inherit-parent",
    "review": "inherit-parent",
    "test": "inherit-parent",
    "verify": "inherit-parent"
  }
}
```

### 6. Confirm

Call `pstack_config` with `action: "get"` again and compare every assignment with the approved map. Recheck selectors against discovery. Fix any parse, availability, or safety error before reporting success. Readback proves the map parsed, not that a live model request succeeded. Tell the user the role map was written, give its exact path, and say it applies to new subagent requests; no new parent session is required. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke `/skill:create-verification-skill` (resolve its actual installed path: workspace, user, or Pi package). On no, move on without pushing.
