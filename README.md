# pstack for Pi

`@aaalexliu/pstack-pi` provides all 47 main skills from Lauren Tan's pstack.
It copies compatible upstream content and applies exact, reviewed edits to Cursor-specific instructions. No full-file replacements remain. It also includes branch-aware task tracking, scoped session discovery, model-config readback, and a `subagent` tool built on Pi's bundled example with bundled agents, role-based model routing, a depth guard, and process-group cleanup. The three Benny Cursor Cloud Automation skills are outside this package's main-skill scope.

## Install

Pi packages run with full system access. Review this repository before installation.

Install a tested commit by its full 40-character SHA:

```sh
pi install git:github.com/aaalexliu/pstack-pi@<full-commit-sha>
```

Check that Pi found it:

```sh
pi list
```

Then start Pi in your project. For example:

```text
Use the subagent tool with general-purpose to inspect this repository and summarize its entry points.
```

For bounded parallel work:

```text
Use the subagent tool to run separate read-only checks for the API, tests, and package metadata in parallel.
```

You can also run a reviewed skill directly, such as `/skill:tdd add a regression test for this bug`.

A pinned Git package does not advance during `pi update --extensions`. Upgrade or remove it with:

```sh
pi install git:github.com/aaalexliu/pstack-pi@<new-full-commit-sha>
pi remove git:github.com/aaalexliu/pstack-pi
```

The package supports Pi `0.85.1` and Node.js `>=22.19.0` in this release.

## Documentation

| File | Answers |
| --- | --- |
| `README.md` (this file) | What the package does and how to install and use it |
| `AGENTS.md` | Rules for agents and contributors editing this repository |
| `SYNCING.md` | How to regenerate, change a transform, or move the upstream pin |
| `ADAPTATIONS.md` | Which upstream files change, and why |
| `TESTING.md` | Which test script to run, and what each suite proves |
| `RELEASING.md` | The release gate and install-by-commit procedure |

## Supported scope

Pi `0.85.1` exposes 47 manual commands:

- Workflows: `/skill:architect`, `/skill:arena`, `/skill:automate-me`, `/skill:blast-radius`, `/skill:bro`, `/skill:create-verification-skill`, `/skill:figure-it-out`, `/skill:how`, `/skill:interrogate`, `/skill:maintain-verification-skill`, `/skill:make-bot-ui`, `/skill:no-comments`, `/skill:poteto-mode`, `/skill:recall`, `/skill:reflect`, `/skill:setup-pstack`, `/skill:show-me-your-work`, `/skill:swarm`, `/skill:tdd`, `/skill:teach`, `/skill:technical-writing`, `/skill:typescript-best-practices`, `/skill:unslop`, and `/skill:why`.
- Principles: `/skill:principle-attack-the-premise`, `/skill:principle-boundary-discipline`, `/skill:principle-build-the-lever`, `/skill:principle-encode-lessons-in-structure`, `/skill:principle-exhaust-the-design-space`, `/skill:principle-experience-first`, `/skill:principle-fix-root-causes`, `/skill:principle-foundational-thinking`, `/skill:principle-guard-the-context-window`, `/skill:principle-laziness-protocol`, `/skill:principle-make-operations-idempotent`, `/skill:principle-migrate-callers-then-delete-legacy-apis`, `/skill:principle-minimize-reader-load`, `/skill:principle-model-the-domain`, `/skill:principle-never-block-on-the-human`, `/skill:principle-outcome-oriented-execution`, `/skill:principle-prove-it-works`, `/skill:principle-redesign-from-first-principles`, `/skill:principle-separate-before-serializing-shared-state`, `/skill:principle-sequence-verifiable-units`, `/skill:principle-subtract-before-you-add`, `/skill:principle-test-behavior-not-implementation`, and `/skill:principle-type-system-discipline`.

Each skill keeps `disable-model-invocation: true` so Pi expands it only through an explicit skill command.

The package ships 83 generated skill and support files, three generated agents, fifteen extension modules, and the root package files.
It registers `pstack_config`, `pstack_papercut`, `pstack_sessions`, `pstack_todo`, and, at root depth, `subagent`.
The delegation extension owns one `session_shutdown` hook that stops live children and a `tool_result` hook that marks its own failed calls. The papercut journal owns a `tool_execution_start` hook and a `tool_result` hook that append a one-line measurement to other tools' results.
Todo and Poteto Mode state follow the active session branch through versioned custom entries. The package registers `/pstack`, `/subagents`, `/pstack-cmux`, and `/papercuts`, but no prompts, themes, or blanket approval hooks.

`ADAPTATIONS.md` lists every transformed file and its edit scope. Host changes must preserve the skill's scope, evidence, checkpoints, and outputs. `SYNCING.md` explains the deterministic, count-checked transform path. Routine sync needs no LLM.

The package never installs a blanket command-approval gate, inspects unrelated shell strings, or requests package-wide confirmation for routine Git pushes or pull-request edits.
Those actions remain under host policy.
Its validation applies only to `subagent` requests.

## Core workflows

Run `/skill:poteto-mode <task>` to load the mode and keep its short operating reminder active on the current session branch. The mode selects one of six bundled playbooks: feature, bug fix, investigation, prototype, multi-phase plan, or orchestration. Branching before the command restores the mode state from that earlier point.

Poteto Mode uses `poteto-agent` for bounded implementation work and `general-purpose` for read-only exploration. `poteto-agent` has `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`; it is a leaf process with no `subagent` tool. The parent still owns the design, diff review, and final checks.

Run `/skill:how <question>` for an architecture walkthrough. Narrow questions use one read-only explainer. Broad questions can use two to four read-only explorers followed by one explainer. The configured `how-explorer` and `how-explainer` roles select their models, with parent-model inheritance as the default.

## Todos

The `pstack_todo` tool stores a checklist in versioned Pi custom entries. Its state follows the active session branch, so branching from an earlier point restores the checklist from that point rather than a later sibling.

The tool supports four strict actions:

```json
{"action":"get"}
{"action":"set","items":["Reproduce the bug","Fix it","Verify the fix"]}
{"action":"add","item":"Review the diff"}
{"action":"complete","item":"Reproduce the bug"}
```

`complete` marks every exact matching open item with `[done] `. `set` and `add` accept at most 128 nonblank items of at most 4,096 characters each. Reads do not add session entries. The loader ignores malformed entries and entries from newer state versions.

## Workflow support tools

Run `/pstack` to show the current model config and the exact file path to edit (normally `~/.pi/agent/pstack-pi/models.json`). It reads the file each time, does not change it, and makes no model request. Config changes apply to new subagent requests without restarting Pi.

`pstack_config` has strict `get` and `list-models` actions. `get` reads `<Pi agent dir>/pstack-pi/models.json` through the same version-1 parser used by delegation. `list-models` returns the exact `provider/model-id` values available from Pi's model registry. The tool does not write config. `/skill:setup-pstack` validates model choices first, then writes the file with Pi's normal file tools.

`pstack_sessions` has one strict `list` action. It returns at most 100 saved Pi session paths for the current working directory and reports whether it truncated the list. It does not accept a path from the model and does not scan sessions for other projects.

## Papercuts

The agent can call `pstack_papercut` when it finds friction that could improve future agent work. The tool accepts a free-form lowercase `kind`, a concise `note`, and an optional `evidence` measurement. Its prompt guideline tells the agent not to record expected waits, ordinary project failures, errors caused by the current task, secrets, or raw tool output.

```json
{"kind":"tool.output-noisy","note":"cat of a lockfile dumped the whole file into context","evidence":{"tool":"bash","durationMs":24,"outputBytes":51338}}
```

pstack-pi appends a one-line trailer to every other tool result, for example `[pstack: bash 22ms 80B failed]`. The measurement sits next to the output it describes, so the agent can judge a slow call or a large dump in context and copy the numbers into `evidence`. pstack-pi never decides on its own which call a note is about. Tool inputs and outputs are never copied into the journal.

Records stay local in private per-session, per-process JSONL files under `<Pi agent dir>/pstack-pi/papercuts/`. The reader ignores malformed lines and records from newer versions.

| Command | Result |
| --- | --- |
| `/papercuts` | Show the 20 most recent papercuts for the current project |
| `/papercuts all` | Show the 20 most recent papercuts across all projects |
| `/papercuts aggregate` | Write a timestamped Markdown aggregation across all projects |

Aggregations always span every project because papercuts describe the tooling, not one repository. Each note row still carries its project. Aggregations are immutable snapshots under `<Pi agent dir>/pstack-pi/papercut-aggregations/`.

## Delegation

The `subagent` tool is Pi's bundled subagent example (`examples/extensions/subagent`) plus a few additions.
Each call spawns a separate `pi --mode json -p --no-session` process per task, so every child has its own context window.

```json
{"agent":"general-purpose","task":"Read src/index.ts and explain its exports."}
```

Three modes, exactly one per call:

- Single: `agent` and `task`.
- Parallel: `tasks`, an array of 1-8 `{agent, task}` entries. At most four children run at once; results keep input order.
- Chain: `chain`, an array of `{agent, task}` steps run in order. `{previous}` in a task is replaced by the prior step's output. A failed step stops the chain.

Every task entry, and the call itself, accepts optional `cwd`, `model`, and `role`. The call also accepts `timeoutMs`, `agentScope`, and `confirmProjectAgents`.
`cwd` is any directory; a relative path resolves against the parent's working directory.
`timeoutMs` kills any child still running after that many milliseconds and reports the task as failed with `Timed out after N ms`.

What this package adds to the example:

- Bundled agents. `general-purpose`, `poteto-agent`, and `comment-sicko` ship in `agents/`. A file with the same name in `~/.pi/agent/agents` overrides a bundled one. Project agents under `.pi/agents` appear only with `agentScope: "both"` or `"project"`, and an untrusted project asks for confirmation in interactive mode.
- Model routing. `model` is `inherit-parent` or an exact `provider/model-id`; `role` picks from `~/.pi/agent/pstack-pi/models.json`. See Model routing.
- A depth guard. The child receives `PSTACK_SUBAGENT_DEPTH=1`; at depth one or more the subagent extension registers nothing, so children cannot delegate. Explicit agent tool lists also include `pstack_todo`, so a child can report its own checklist.
- Process groups. Each child is a detached session leader. Abort, `timeoutMs`, and parent shutdown send `SIGTERM` to the whole group, then `SIGKILL` after three seconds. Parent shutdown waits up to one second for children to exit and discards any result that arrives during shutdown.
- Private inputs. The system prompt goes through a `0600` temp file with `--append-system-prompt` and the task through stdin, so neither appears in `ps`. The temp file is removed after the child exits.
- Error results. Pi 0.85.1 ignores `isError` returned from `execute`, so a `tool_result` hook marks the result as an error when a single task fails, a chain stops, or every parallel task fails. A parallel call with some failures stays a normal result that names each failure.
- The child is launched through the same Node binary and Pi entrypoint as the parent, never through `pi` on `PATH`.

A child is otherwise a normal Pi. It loads extensions, skills, and project context files by Pi's own rules, uses the parent's provider auth from `auth.json`, and runs with the builtin tools its agent lists.
A child inheriting the parent model also inherits the parent thinking level; a pinned model uses Pi's default thinking level.

Agent files need a name and a description. `tools` accepts a YAML list or a comma-separated string. `model` is optional:

```markdown
---
name: reader
description: Read files and answer a focused question.
tools: [read, grep, find, ls]
model: openai/gpt-4o
---
Answer from file evidence. Do not delegate.
```

A file that fails to parse is skipped; the other agents in that directory still load.

### Results

The tool returns the child's final assistant text. Parallel results are joined as `### [agent] completed` or `### [agent] failed (reason)` sections, each capped at 50 KiB with the full text kept in `details`.
`details` holds `mode`, `agentScope`, `projectAgentsDir`, and one entry per task with the agent, its source (`bundled`, `user`, `project`), the task, `exitCode`, every `message_end` message from the child, capped stderr, summed usage (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `contextTokens`, `turns`), the resolved `model`, and `modelSource` (`explicit`, `role`, `agent`, `parent`).
A task fails when the child exits nonzero, is killed by a signal, or ends with `stopReason` `error` or `aborted`.
`details.progress` stores the public status snapshot with the result. Live cards show role, selected/observed model, state, elapsed time, last event, reported usage, todo counts, and current activity. Completed cards keep that metadata and preview the original result text. Ctrl+O expands the full result.

### Inspect subagents

Use `/subagents` for the latest request's tasks, public message previews, checklists, usage, and recent event summaries. Use `/subagents raw` for the same public snapshot as JSON, not the raw protocol or private thinking. Both views update live. `j`/`k`, arrows, PageUp/PageDown, and Home/End scroll; `q` or Esc closes the view without stopping work. Esc in the parent stops the batch.

The collapsed card shows at most eight tasks and favors unfinished work. Ctrl+O also reveals every task's metadata in a longer chain, even after reload. The inspector shows every step of the most recently started request; older overlapping calls cannot replace that view. Each call keeps its own inline card. There is no duplicate widget. In cmux, the sidebar shows up to eight tasks using keys owned by this Pi instance. A cmux error triggers best-effort removal of those keys instead of keeping stale running status.

Checklists are self-reported. A quiet warning after 60 seconds and a long-run warning after 10 minutes suggest checking the task; neither proves a loop or lack of progress. Usage can lag. Public previews and event history are bounded. This is not a process-tree monitor and does not find arbitrary shell-launched agents.

Saved tool cards survive reload. The inspector keeps only the latest request in memory. Graceful shutdown clears owned sidebar keys; a hard kill may leave stale keys.

To try the real Pi UI with scripted fixture responses and no live credentials:

```sh
node scripts/demo-subagents.mjs
```

`--quick` shortens the wait; `--overlap` runs two separate simultaneous calls; `/quit` exits. Fixture responses are not actual review findings.

### Optional cmux transcript tabs

Transcript tabs default to off. Use `/pstack-cmux on` to activate them, `/pstack-cmux off` to deactivate them, and `/pstack-cmux status` to check the setting. The commands save `cmuxTabs` in `<Pi agent dir>/pstack-pi/settings.json`, normally `~/.pi/agent/pstack-pi/settings.json`:

```json
{"version":1,"cmuxTabs":true}
```

The setting persists across sessions and applies to newly started subagents without a reload. Turning it off leaves existing tabs and agents running. It does not disable the inline cards or cmux sidebar status.

When enabled and the parent runs inside cmux (`CMUX_WORKSPACE_ID` is set), the first child opens a right-hand pane. Later children, including parallel tasks and chain steps, open tabs in that same pane. New tabs do not take keyboard focus. cmux preserves the tab you are reading in the focused pane, but may select the newest tab in a background pane. If you close the shared pane, the next child creates a new one. Each parent session owns its own pane.

Tabs show completed assistant messages, tool calls, tool results, and final status. They are read-only transcripts, not interactive Pi sessions. Closing a tab does not stop its child. Completed tabs remain for inspection; their followers stop, and the text stays in terminal scrollback. Private transcript files are removed when the parent session shuts down or reloads. Missing or failed cmux commands do not prevent delegation.

Limits worth knowing: a child's own detached, `SIGTERM`-ignoring processes are outside its process group and are not tracked, the same as Pi's bash tool. Delegation needs macOS or Linux for process groups.

## Model routing

The only routing config is `~/.pi/agent/pstack-pi/models.json` (under `getAgentDir()`).
A missing file means no configured roles. A malformed file fails the call with a message naming the file.

```json
{"version":1,"roles":{"feature":["inherit-parent","openai/gpt-4o"],"review":"inherit-parent"}}
```

A choice is `inherit-parent` or `provider/model-id`; only the first slash separates provider and model.
A role maps to one choice or to a pool of choices. Pools rotate round-robin per role for the life of the Pi session.

The role IDs are:

- `feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment`, `prose`, `hardest`
- `how-explorer`, `how-explainer`, `how-critics`, `why-investigator`, `why-synthesizer`
- `reflect-tooling`, `reflect-judgment`, `reflect-divergent`, `reflect-synthesizer`
- `arena-runner`, `arena-cross-judge`, `swarm-worker`, `architect-runner`, `interrogate-reviewer`
- `no-comments`, `review`, `test`, `verify`

Resolution order: the task's explicit `model`, then the configured `role`, then the agent file's `model`, then the parent's model.
An unconfigured role falls through. `pstack_config` reads the same file and lists the models Pi can see.
The child receives the choice as `--model provider/model-id` and resolves credentials itself from the standard Pi config, exactly as a user typing that flag would.

## Develop locally

Run `npm ci` in the checkout, then register it with `pi install /absolute/path/to/pstack-pi`.
Pi records it in the user profile by default.
Add `-l` to register it in the current project's settings instead.

Run `npm run test:fast` while iterating and `npm run check` once before pushing `main`. `TESTING.md` explains the split and what each suite proves. `AGENTS.md` lists the editing rules, starting with the one that matters most: `skills/` and `agents/` are generated, so edit `sync/manifest.json` and run `npm run sync` instead.

`engines.pi` records the tested version but npm does not enforce it.
The package starts at version `0.1.0` and follows independent SemVer, not Cursor plugin versions.

## Upstream provenance

The sole source for shared content is [Lauren Tan's pstack in cursor/plugins](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack).
The [MIT license](LICENSE) preserves Lauren Tan's notice unchanged.

The pinned source commit is `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`.
Its `pstack` tree is `6d4e9d1140f70c483e5617c405baa5bb5654e211`.
`vendor/cursor-pstack/` contains that immutable snapshot.
`sync/upstream.lock.json` records source blobs, modes, and generated hashes.

`sync/manifest.json` is the only authored classification of the 158 source files.
It copies 49 files, transforms 36, and explicitly omits 73. No file uses `replace`.
Transforms change only reviewed commands, frontmatter, paths, runtime sections, or proof steps, leaving all other source bytes intact.
Each transformation requires its locked source blob and exact match count.
Even execution-ownership changes use targeted transforms rather than rewritten copies. All 23 principle skills and the Investigation playbook remain byte-for-byte copies.

`sync/additions/agents/general-purpose.md` is a Pi-owned source, separate from the 158 upstream paths. `SYNCING.md` describes how additions are declared and checked.

Cursor distribution metadata, guides, branding assets, Cloud Automations, unbundled playbooks, and unsupported scripts remain omitted.
All 47 main skill entrypoints are present, including the webhook-backed `make-bot-ui`. Missing external service capabilities remain explicit limits, not silently changed tasks.
Two upstream agents have targeted Pi transforms; the third agent is a Pi-owned addition.

[0xrsydn/pstack-pi](https://github.com/0xrsydn/pstack-pi) and [kkgogogo17/pi-pstack](https://github.com/kkgogogo17/pi-pstack) are implementation references, not sources for shared content.
The [aaalexliu/pstack-pi project](https://github.com/aaalexliu/pstack-pi) owns the Pi adaptations and package code.

## Regeneration and checks

Never edit generated `skills/`, generated `agents/`, or the pinned snapshot by hand.
Edit Pi-owned agent sources under `sync/additions/`.
For a reviewed manifest change against the existing snapshot, run:

```sh
npm ci
npm run sync:relock
npm run sync
npm run check
```

Relock verifies the existing snapshot before updating adaptation and addition hashes.
Sync writes only managed content.
Neither command changes package metadata or documentation.

`npm run check` is the release gate. `TESTING.md` lists the scripts it runs and what each suite proves. `SYNCING.md` covers moving the upstream pin and recovering from a failed sync.

The packed package has no runtime dependencies. Pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` to extensions.
`skipLibCheck` skips defective third-party declarations in Pi's dependency tree. Project TypeScript still uses strict checking.
