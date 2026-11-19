---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the user-level Pi role map that overrides the skill defaults. The budget becomes a `:<level>` thinking suffix on each real selector. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
disable-model-invocation: true
---

# Setup pstack

The parent writes `<Pi agent dir>/pstack-pi/models.json`, a user-level version-1 role map that sets pstack's model per role. Resolve the configured Pi agent directory, normally `~/.pi/agent`; this is not the provider catalog `models.json` or a project rule. Do not commit it. Children do not write user configuration or access external services.

## Steps

### 1. Detect available models

Call `pstack_config` with `action: "list-models"` to enumerate the exact `provider/model-id` selectors available in this session. That is the dependable source. If you cannot detect any, ask the user to paste the slugs they have access to. Never write a real slug you have not confirmed is available. The alias `inherit-parent` is always valid even though it is not a detected slug. Pi does not accept `auto`.

### 2. Load current state

The default role-to-model mapping is the JSON shape shown in step 5 below. Call `pstack_config` with `action: "get"`; if a role map already exists, read it and treat its values as the current choices. Otherwise start from those defaults. If `get` rejects an existing file, read it directly and name the error. A key whose role is not in step 5 is from a retired role. Drop it; step 5 writes the map without it. Any other malformed content is an error to explain and repair with approval, not a reason to erase choices.

A role map from an older setup may carry a `:max` suffix from the retired `unlimited` budget. Before step 3, change each `:max` suffix to `:xhigh`, because no role runs above `xhigh`. Earlier Pi defaults were all `inherit-parent`, so the map holds no old default slugs to replace.

Every other value is the user's choice and stays, including every `inherit-parent` value. Tell the user which values you replaced.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer an available structured choice tool or numbered chat choices over free text. Offer these three options with these exact labels, and name the current budget when every real selector's `:<level>` suffix matches its role's target under one budget in (b). With no role map, say that `large` matches the skill defaults.

- `large - xhigh reasoning`
- `medium - high reasoning`
- `small - medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults (all roles `inherit-parent` until the user picks concrete selectors), and on a re-run keep any role the user already set to a real selector, a list, or `inherit-parent`. A role's default effort is `high` for `arena-runner`, `arena-cross-judge`, `swarm-worker`, and `interrogate-reviewer`, and `xhigh` for every other role. Each role has a target effort, which is its default's effort moved by the budget. `large` keeps it, `medium` lowers it one step, and `small` lowers it two steps, on the ladder `xhigh` > `high` > `medium` > `low`. No role runs above `xhigh`, and a target at the bottom of the ladder stays there. Most defaults are at `xhigh`, and each budget label names where those land. Set the thinking level of every real selector in the role, panel entries included, to the role's target. Write the level as a `:<level>` suffix, such as `anthropic/claude-opus-5-5:xhigh`, replacing any suffix already there. `inherit-parent` does not change; that role runs at the parent's level. So `medium` writes `:high` on `feature` and `:medium` on `arena-runner`, and `small` writes `:medium` and `:low`. The `subagent` tool passes the selector to the child's `--model`, and Pi clamps a level the model does not support. The suffixes record the budget; `models.json` has no separate budget field.

**(c) Show the roles and confirm.** Show every role from the current `subagent` schema with its model, marking any real slug not in the detected set as needing a choice. Also list each role step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models at `xhigh` or below plus `inherit-parent` (this role runs on the parent chat model) as the options. Prefer an available structured choice tool or numbered chat choices over free text. Wait for explicit confirmation before writing, including on repeat runs. Role values may be a selector or a nonempty list. Lists rotate deterministically across ordinary requests to the role; preserve duplicate entries because they weight that rotation. For panel roles (`arena-runner`, `interrogate-reviewer`) the value is a list, and the panel workflow selects each entry explicitly, one subagent per entry, alias entries included, so the list length sets the count. `arena-cross-judge` is also a list, but Arena runs one judge. It tries only values from a vendor other than the parent's, in list order, so order it by preference. Fable and the other Claude models are one vendor. A model's vendor is the company behind its model line, such as Claude, GPT, Gemini, or Grok, not the selector's provider. An `inherit-parent` value never judges. `swarm-worker` is the default model for every worker unless a race or comparison assigns another model per arm. Explicit task model selection takes precedence over the role map.

### 4. Validate

Every real slug written must be in the detected set once its `:<level>` suffix is removed. A suffix must be `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`, so no role runs above `xhigh`. `inherit-parent` always passes. Reject unknown roles, empty lists, invalid selectors, extra fields, and versions other than 1. If a chosen real slug is not available, stop and ask again.

### 5. Write the role map

Write `<Pi agent dir>/pstack-pi/models.json` with exactly `version` and `roles`, using only the role keys shown below, so a retired role from an older map is gone after this run. Before writing, require owner-controlled paths. Existing directories must be directories and the config must be a regular file, neither symlinked nor group/world writable; stop on unsafe paths. Create the `pstack-pi` directory and config if absent. Write only the approved choices. Overwrite the whole file so re-runs stay idempotent. Shape:

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
    "arena-runner": "inherit-parent",
    "arena-cross-judge": "inherit-parent",
    "swarm-worker": "inherit-parent",
    "interrogate-reviewer": "inherit-parent",
    "no-comments": "inherit-parent",
    "review": "inherit-parent",
    "test": "inherit-parent",
    "verify": "inherit-parent",
    "scout": "inherit-parent"
  }
}
```

### 6. Confirm

Call `pstack_config` with `action: "get"` again and compare every assignment with the approved map. Recheck selectors against discovery. Fix any parse, availability, or safety error before reporting success. Readback proves the map parsed, not that a live model request succeeded. Tell the user the role map was written, give its exact path, and say it applies to new subagent requests; no new parent session is required. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke `/skill:create-verification-skill` (resolve its actual installed path: workspace, user, or Pi package). On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /skill:create-formal-verification-skill." On yes, invoke `/skill:create-formal-verification-skill` (resolve its actual installed path: workspace, user, or Pi package). On no, move on without pushing.
