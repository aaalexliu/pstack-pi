# pstack for Pi

`@aaalexliu/pstack-pi` provides 54 of the 58 main skills from Lauren Tan's pstack, plus the Pi-owned `deeper`, `intake`, `list-writing`, and `show-me` skills.
It copies compatible upstream content and applies exact, reviewed edits to Cursor-specific instructions. No full-file replacements remain. It also includes branch-aware task tracking, scoped session discovery, model-config readback, and HazAT's interactive subagents in cmux or tmux panes, extended with bundled agents, role-based model routing, a wait mode, a spawning guard, and headless children with process-group cleanup. The three Benny Cursor Cloud Automation skills are outside this package's main-skill scope.

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
Use the subagent tool with wait: true and the general-purpose agent to inspect this repository and summarize its entry points.
```

For bounded parallel work:

```text
Use subagent calls with wait: true to run separate read-only checks for the API, tests, and package metadata in parallel.
```

You can also run a reviewed skill directly, such as `/skill:tdd add a regression test for this bug`.

A pinned Git package does not advance during `pi update --extensions`. Upgrade or remove it with:

```sh
pi install git:github.com/aaalexliu/pstack-pi@<new-full-commit-sha>
pi remove git:github.com/aaalexliu/pstack-pi
```

The package requires Pi `>=1.5.2` and Node.js `>=22.19.0`. We test against Pi `1.5.2`; older Pi releases are not supported.

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

Pi `1.5.2` discovers all 58 package skill commands in an isolated profile:

- Workflows: `/skill:architect`, `/skill:arena`, `/skill:automate-me`, `/skill:benchmark-checklist`, `/skill:blast-radius`, `/skill:bro`, `/skill:correct`, `/skill:create-formal-verification-skill`, `/skill:create-verification-skill`, `/skill:deeper`, `/skill:figure-it-out`, `/skill:how`, `/skill:in-your-own-words`, `/skill:intake`, `/skill:interrogate`, `/skill:ketchup`, `/skill:list-writing`, `/skill:maintain-formal-verification-skill`, `/skill:maintain-verification-skill`, `/skill:make-bot-ui`, `/skill:no-comments`, `/skill:poteto-mode`, `/skill:reflect`, `/skill:setup-pstack`, `/skill:show-me`, `/skill:show-me-your-work`, `/skill:statechart`, `/skill:swarm`, `/skill:tdd`, `/skill:teach`, `/skill:technical-writing`, `/skill:typescript-best-practices`, `/skill:unslop`, and `/skill:why`.
- Principles: `/skill:principle-attack-the-premise`, `/skill:principle-boundary-discipline`, `/skill:principle-build-the-lever`, `/skill:principle-encode-lessons-in-structure`, `/skill:principle-exhaust-the-design-space`, `/skill:principle-experience-first`, `/skill:principle-explain-the-number`, `/skill:principle-fix-root-causes`, `/skill:principle-foundational-thinking`, `/skill:principle-guard-the-context-window`, `/skill:principle-laziness-protocol`, `/skill:principle-make-operations-idempotent`, `/skill:principle-migrate-callers-then-delete-legacy-apis`, `/skill:principle-minimize-reader-load`, `/skill:principle-model-the-domain`, `/skill:principle-never-block-on-the-human`, `/skill:principle-outcome-oriented-execution`, `/skill:principle-prove-it-works`, `/skill:principle-redesign-from-first-principles`, `/skill:principle-separate-before-serializing-shared-state`, `/skill:principle-sequence-verifiable-units`, `/skill:principle-subtract-before-you-add`, `/skill:principle-test-behavior-not-implementation`, and `/skill:principle-type-system-discipline`.

Every skill except `intake`, `list-writing`, `show-me`, and the 24 principle skills keeps `disable-model-invocation: true` so Pi expands it only through an explicit skill command. Those also appear in the model's skill list: `list-writing` applies whenever a reply holds a list or a breakdown, `intake` applies whenever a session files a ticket for an agent, `show-me` applies when a topic or bug needs a picture, and each principle skill applies at the moment its description names, such as debugging or checking that work is done.

`/skill:statechart` runs its bundled `scripts/statechart` command. That command needs Node 22.18 to 22.x, Node 23.6 or later, Bun 1.1.5 or later, or Deno 2.0 or later, plus `mise`. Its first run downloads TLC and Java through mise. Rendering a chart to SVG uses the npm package `pele@1.9.0`, installed outside your repo. Node will not run the TypeScript scripts from a `node_modules` folder, so use the Git install above.

The package ships 124 generated skill and support files, two generated agents, nine Pi-owned files under `additions/`, twenty-five extension modules, 23 files from the interactive-subagents subtree, and the root package files.
It registers `pstack_config`, `pstack_papercut`, `pstack_sessions`, `pstack_todo`, and, at root depth, `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list`.
The subagents extension owns a `session_shutdown` hook that stops live children. A `subagent` wait result marks a failed child with `isError`. The papercut journal owns a `tool_execution_start` hook and a `tool_result` hook that append a one-line measurement to other tools' results. When `read` fails with ENOENT, a `tool_result` hook appends up to 10 existing paths from the nearest existing parent folder. It ranks the first missing path segment, same stem with other extensions first, then names within edit distance 3, and marks folders with a trailing `/`. The requested file name is added only when it exactly names a folder there. When Pi cuts `bash` output at its cap and saves the full output to a file, a `tool_result` hook replaces Pi's tail-only view with the first and last halves of that file. Each half holds at most half of Pi's byte cap and half of its line cap, and cuts on a line break unless whole lines would fill less than half of its byte budget; then it splits a long line on a character boundary. A marker between them names the file and the omitted lines and bytes. The exit status line stays at the end. A `tool_call` hook blocks a `bash` call that runs `grep -r` or `grep -R` without `--exclude-dir`, or `find` from `~`, `/`, or a folder above home without `-maxdepth` of 3 or less, and tells the agent to use `rg` or `git grep` instead. It reads each command in a pipeline or list, subshells, `sh -c` scripts, and `$(...)` or backtick substitutions, even inside double quotes. It skips other quoted text, comments, and heredoc bodies. A `cd` moves the commands after it, unless it runs in a child shell. The title extension owns an `input` hook that names the session in the background. The recap extension owns an `agent_settled` hook that starts its idle timer. The media extension records cited files after a TUI reply and draws a media entry under it.
Todo and Poteto Mode state follow the active session branch through versioned custom entries. The package registers `/pstack`, `/pstack-export`, `/papercuts`, `/recap`, `/media`, and the interactive extension's `/plan`, `/iterate`, and `/subagent`, but no prompts, themes, or blanket approval hooks.

`/pstack-export [path.html]` runs stock Pi HTML export (`pi --export`) for the current session, then injects a sticky token time series for the active branch. Bars jump to the first entry in that local-time minute. Scroll on the transcript updates the current bucket. Without a path it writes `pi-session-<session>.html` in the cwd.

`ADAPTATIONS.md` lists every transformed file and its edit scope. Host changes must preserve the skill's scope, evidence, checkpoints, and outputs. `SYNCING.md` explains the deterministic, count-checked transform path. Routine sync needs no LLM.

The package never installs a blanket command-approval gate, inspects unrelated shell strings, or requests package-wide confirmation for routine Git pushes or pull-request edits.
Those actions remain under host policy.
Its validation applies only to `subagent` requests.

## Core workflows

Run `/skill:poteto-mode <task>` to load the mode and keep its short operating reminder active on the current session branch. The reminder is a `pstack_poteto_mode` system prompt section. Pi records sections in the session, so a request rebuilt from the session, as `pi-cached-compaction` does, matches the one Pi sent. The mode selects one of its bundled playbooks, such as feature, bug fix, investigation, prototype, or multi-phase plan. Branching before the command restores the mode state from that earlier point.

Poteto Mode uses `poteto-agent` for bounded implementation work and `general-purpose` for read-only exploration. `poteto-agent` has `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`; it is a leaf process with no `subagent` tool. The parent still owns the design, diff review, and final checks.

Run `/skill:how <question>` for an architecture walkthrough. A narrow question is answered in the session. A broader one goes to one read-only `general-purpose` explainer that explores and explains in one pass.

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

When codemode is active, pstack-pi adds one rule after Pi's own codemode rule: keep each result under `max_output_tokens`, put at most one long file or diff in each result, return only the lines needed, and read the temp file a cut result names instead of rereading. Agents that batched several long files lost the middle of the output and read everything again.

## Papercuts

The agent calls `pstack_papercut` when friction costs it extra steps, blocks it, or gives it a wrong result, even if it recovers: retries, workarounds, confusing errors, stale docs, slow calls. Before its final response it records friction it missed, one note per distinct problem. It skips routine negative results, expected waits and product bugs. Secrets and raw tool output never belong in a note.

The agent fills four fields. `note` says what it was doing, what happened, what it cost, and how it got past it. `culprit` names the one thing whose change would have prevented it: its `type` (`pi-tool`, `command`, `mcp`, `doc`, `config`, `environment`, `self` or `unknown`) and, unless the type is `self` or `unknown`, its `name`, such as `read`, `gh`, or the path of a doc. `impact` is `extra-steps`, `blocked` or `wrong-result`. `fix`, optional, is the change that would have prevented it.

```json
{"note":"read returned the old file right after a write, so I reviewed stale code until a second read","culprit":{"type":"pi-tool","name":"read"},"impact":"wrong-result"}
```

pstack-pi stamps the rest, so the agent copies no numbers: `at`, `sessionId`, `callId` (the papercut call's own tool call id, its place in the session log), `cwd`, `repo` (the git root and short head of `cwd`, absent outside a repository), `host` (the machine name without `.local`), `model` (`provider/id`), and `build` (`pstack-pi@<short commit>` of the installed package, or `pstack-pi@<version>` when it is not a git checkout).

A top-level tool call that takes 10 seconds or more gets a trailer such as `[pstack: took 12s]`, because a model cannot feel time. Faster calls get none, and so do calls nested in another tool, such as a codemode script, so a script can `JSON.parse` a nested result as is. Tool inputs and outputs are never copied into the journal.

A Pi process records each papercut once per session. A second call with the same session, culprit and note writes nothing, even in a later turn. Notes match after trimming and collapsing whitespace. A turn records at most 5 papercuts, including calls made from codemode scripts. Calls past the cap write nothing and tell the agent to record only distinct problems. Neither refusal is an error, so the agent has no reason to retry.

Records stay local in private per-session, per-process JSONL files under `<Pi agent dir>/pstack-pi/papercuts/`, as version 3. The reader also accepts version 1 and 2 records, which carry a free-form `kind` and an optional `evidence` block in place of `culprit` and `impact`. It ignores malformed lines and records from newer versions, and keeps only the earliest record for each session, culprit (or `kind`) and note, so a burst in an older journal counts once.

| Command | Result |
| --- | --- |
| `/papercuts` | Show the 20 most recent papercuts for the current project |
| `/papercuts all` | Show the 20 most recent papercuts across all projects |

## Delegation

pstack-pi has one delegation tool, `subagent`. It comes from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), folded into `extensions/interactive-subagents/` with its own README. `subagent_resume`, `subagent_interrupt`, and `subagents_list` manage its children. Each child is a separate Pi process with its own context window and session file.

Pick by whether you need to wait:

- Without `wait`, the call returns at once and the child's result arrives later as a new parent turn. Use it for real work you want to watch and steer.
- With `wait: true`, the call returns when the child finishes, with its result after `resolved-model:`, `session-id:`, and `session-path:` lines. Use it for read-only lookups and answers you need before your next step. `timeoutMs` stops a child that runs too long and reports it as failed. To run several children at once, make several wait calls in one message; Pi runs them together.

```json
{"name":"Reader","agent":"general-purpose","task":"Read src/index.ts and explain its exports.","wait":true}
```

Inside cmux or tmux, each child opens as a real Pi you can watch and steer. In cmux, the children of one parent share an `agents: <session>` workspace in a 2x2 grid; in tmux, each child is a window. Outside both, the child runs headless as `pi -p` in its own process group, launched through the same Node binary and Pi entrypoint as the parent, never through `pi` on `PATH`. Abort, `timeoutMs`, and parent shutdown send `SIGTERM` to the whole group, then `SIGKILL` after three seconds. A parent runs at most four children at once, waiting or not, pane or headless, and queues the rest. Set `maxConcurrent` and `cmuxLayout` (`"grid"` or `"tabs"`) under `interactiveSubagents` in `<Pi agent dir>/pstack-pi/settings.json`.

The call accepts `agent`, `cwd`, `model`, `role`, and `thinking`, plus the interactive options in its README. `thinking` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; it overrides the level in a role's model, and Pi clamps it to the model.

What this package adds:

- Bundled agents. `general-purpose`, `poteto-agent`, `comment-sicko`, `pr-reviewer` and `sub-lead` ship in `agents/` and `additions/agents/`, next to the subtree's `scout`, `worker`, `planner`, `reviewer`, `visual-tester`, and `claude-code`. A project agent in `.pi/agents` or a user agent in `~/.pi/agent/agents` overrides one by name. `{{PSTACK_ROOT}}` in an agent body resolves to the installed package root.
- Model routing. `model` is an exact `provider/model-id`; `role` picks from `~/.pi/agent/pstack-pi/models.json`. See Model routing.
- One spawning rule. Every child gets `PI_DENY_TOOLS` naming each spawning tool (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`), unless its agent says `spawning: true`, so children cannot delegate. Explicit agent tool lists also include `pstack_todo`, so a child keeps its own checklist.

Limits worth knowing: a headless child's own detached, `SIGTERM`-ignoring processes are outside its process group and are not tracked, the same as Pi's bash tool. Headless delegation needs macOS or Linux for process groups. Claude Code agents need cmux or tmux.

## Model routing

The only routing config is `~/.pi/agent/pstack-pi/models.json` (under `getAgentDir()`).
A missing file means no configured roles. A malformed file fails the call with a message naming the file.

```json
{"version":1,"roles":{"feature":["inherit-parent","openai/gpt-4o"],"review":"inherit-parent"}}
```

A choice is `inherit-parent` or `provider/model-id`; only the first slash separates provider and model. A choice may end in a Pi thinking suffix, such as `anthropic/claude-opus-5-5:xhigh`, which sets that role's starting reasoning level. `/skill:setup-pstack` writes the chosen budget this way, and a `thinking` field on the call overrides it.
A role maps to one choice or to a pool of choices. Pools rotate round-robin per role for the life of the Pi session.

The role IDs are:

- `feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment`, `prose`
- `arena-runner`, `arena-cross-judge`, `swarm-worker`, `interrogate-reviewer`
- `no-comments`, `review`, `test`, `verify`, `scout`

Upstream retired `hardest`, `how-explorer`, `how-explainer`, `how-critics`, `why-investigator`, `why-synthesizer`, `reflect-tooling`, `reflect-judgment`, `reflect-divergent`, `reflect-synthesizer`, and `architect-runner`. A `models.json` that still names one loads, the extension ignores that key, and `/skill:setup-pstack` removes it on its next run.

`scout` is for cheap read-only reconnaissance, such as the interactive `scout` agent. Like every role it has no built-in model: set it in `models.json`, or the child runs on the parent's model.

Resolution order: the call's explicit `model`, then the call's `role`, then the agent file's `role`, then the agent file's `model`, then the parent's model. The `subagent` tool uses this lookup (`ModelRouter` in `extensions/subagent/model-config.ts`) and accepts `role`.
An unconfigured role falls through. `pstack_config` reads the same file and lists the models Pi can see.
The child receives the choice as `--model provider/model-id` and resolves credentials itself from the standard Pi config, exactly as a user typing that flag would.

## Auth profiles

An auth profile gives chats under chosen folders their own logins for chosen providers, such as a second Claude account for one client's repositories. Model names stay the same. Without `~/.pi/agent/pstack-pi/profiles.json` the extension does nothing.

```json
{"profiles":{"client-a":{"dirs":["~/dev/clients/client-a"],"providers":["anthropic"]}}}
```

Each session start, including `/new`, `/resume`, `/fork` and `/reload`, picks one profile:

1. `PI_AUTH_PROFILE`, if it was set when this Pi process started. A parent Pi sets it for its children. `default` means no profile.
2. Otherwise, the deepest `dirs` entry that contains the session folder, compared as real paths.
3. Otherwise, no profile.

Pi then sets `PI_AUTH_PROFILE` to that choice, so the bash tool, `!` commands and subagents inherit it wherever they run. To start in a profile from any folder, run `PI_AUTH_PROFILE=client-a pi`.

Inside a profile, its providers read `~/.pi/agent/pstack-pi/profiles/<name>/auth.json` first. `/login` saves there, refreshes write back to the file the login came from, and `/logout` removes only the profile login. A provider with no profile login falls back to the normal `auth.json`. The footer names the login behind the current model, for example `profile: client-a` or `profile: client-a (openai: default login)`.

The extension swaps the credential store on Pi's private `modelRegistry.runtime.credentials.store` and restores it on `session_shutdown`. If a Pi release changes that field, it warns and leaves the normal logins in place. `tests/profiles/e2e/run.sh` checks it against real Pi with a loopback Anthropic stand-in and fake keys.

## Session titles

In the interactive TUI, each prompt you type asks a small model, in the background, whether it starts a new task. If it does, the extension names the session after the task, such as "Counting markdown files". A follow-up such as "yes, do it" keeps the name. `/resume` lists the name, and the extension sets the terminal title to `<name> - <folder>`, or just the folder before the first name, so cmux and other terminals show it on the tab. This replaces Pi's own `π - <name> - <folder>` title, which Pi writes again after a session starts and after each rename; the extension writes its title after both. While the agent works, a braille spinner leads the title, as in Pi's `titlebar-spinner.ts` example. Do not also load that example: it writes `π - <name> - <folder>` back when each run ends.

- The model is Claude Haiku 5.5 when the session model is Anthropic and Haiku has a login. Otherwise it is the session model. The request holds the current name, the last 800 characters of the previous assistant reply, and the first 1,500 characters of your message.
- Each typed prompt costs one extra model call. Pi warns that Anthropic bills third-party use of a Claude subscription as extra usage, per token.
- A name you set with `/name` stays until it is cleared. A resumed session keeps renaming only if this extension set its name.
- Print, JSON, and RPC runs and subagent children never call the model.
- A failed request warns once per session and keeps the old name.

## Recaps

When a run ends in the interactive TUI and you then do nothing for three minutes, the same delay Claude Code uses, the recap extension adds a dim `※ recap:` line to the transcript. It says in under 40 words what the task was, where it stands, and the next step, if any. The line stays in the session file, but the model never sees it. Run `/recap` to write one now.

- The model choice matches session titles: Claude Haiku 5.5 on Anthropic sessions with a Haiku login, otherwise the session model.
- The request holds the session name and the newest 12,000 characters of the conversation: your prompts, the assistant's text, each tool call's name and input, and the output of failed tool calls. It leaves out thinking and other tool output.
- Typing, a `!` command, or a new run cancels a pending recap, including one the model is still writing. A run with nothing new since the last recap gets none.
- Print, JSON, and RPC runs and subagent children never start the timer.
- A failed automatic recap warns once per session.

## Cited media

In the interactive TUI, cite an image, video, or PDF in your final reply as a Markdown image or link, for example `![before](/tmp/before.png)`. The media extension also finds bare paths outside fenced code. It groups existing files from one reply in citation order under that reply. Terminals with image support show up to four thumbnails. Press the expand key (`ctrl+o` by default) to show all of them. Inside tmux, the entry shows a text header only. Videos and PDFs appear in the header.

The header links to a live media page grouped by reply. Each group shows its time and reply, clamped to three lines with a Show more button. The newest turn opens in full. A turn that is older when the page first loads shows a thumbnail strip until you click it. A turn that is already open stays open when newer turns arrive, so a playing video keeps playing. Before and after images have side-by-side, swipe, and flip views. Images open at full size on click; videos play in the page, and PDFs have an embedded viewer and an open link. The page updates when the agent cites more files. Run `/media` to show the page URL and open or reuse its pane.

Local cmux opens the page in a right-side browser split on the first new media turn. Over `cmux ssh`, Cmd-click the header link once to open the page in cmux. The remote relay does not allow a remote process to open a split without that click. The page then updates on its own. Without cmux, use the link in a browser that can reach the Pi host's loopback address. The server binds only to `127.0.0.1` and uses a random token in each process's URL. Treat the URL as access to that session's cited media.

The extension keeps copies under `<Pi agent dir>/pstack-pi/media/`, so later edits to the source do not change the saved media. It skips files over 1 GiB, non-regular files, and files it cannot read, and names them in the header. An image over 16 MiB shows its caption without a thumbnail.

## Develop locally

Run `npm ci` in the checkout, then register it with `pi install /absolute/path/to/pstack-pi`.
Pi records it in the user profile by default.
Add `-l` to register it in the current project's settings instead.

Use the change-based local checks in `TESTING.md` before pushing `main`. Docs-only prose does not need `npm test`; runtime, packaging, and test-runner changes need `npm run check`. Use `npm run test:fast` while iterating on non-runtime changes. `AGENTS.md` lists the editing rules, starting with the one that matters most: `skills/` and `agents/` are generated, so edit `sync/manifest.json` and run `npm run sync` instead.

`engines.pi` records the minimum supported version, but npm does not enforce it.
The package starts at version `0.1.0` and follows independent SemVer, not Cursor plugin versions.

## Upstream provenance

The sole source for shared content is [Lauren Tan's pstack in cursor/plugins](https://github.com/cursor/plugins/tree/2f87c854fe3e2fcda44ca86b46ede35aad3c46b7/pstack).
The [MIT license](LICENSE) preserves Lauren Tan's notice unchanged.

The pinned source commit is `2f87c854fe3e2fcda44ca86b46ede35aad3c46b7`.
Its `pstack` tree is `71d8e1d1d718e2149dc43b2535618064f29cba6b`.
`vendor/cursor-pstack/` contains that immutable snapshot.
`sync/upstream.lock.json` records source blobs, modes, and generated hashes.

`sync/manifest.json` is the only authored classification of the 551 source files.
It copies 36 files, transforms 69, and explicitly omits 446. No file uses `replace`.
Transforms change only reviewed commands, frontmatter, paths, runtime sections, or proof steps, leaving all other source bytes intact.
Each transformation requires its locked source blob and exact match count.
Even execution-ownership changes use targeted transforms rather than rewritten copies. The Investigation playbook stays a narrow transform. Each of the 24 principle skills drops only its `disable-model-invocation: true` line, so the model can load it by itself. `principle-never-block-on-the-human` also changes one line to name every call that is costly to undo.

Pi-owned files live in `additions/`, apart from the 551 upstream paths, and ship as written. `SYNCING.md` describes how `npm run check:content` checks them.

| File | Why it exists |
| --- | --- |
| `additions/agents/general-purpose.md` | Gives `subagent` one read-only delegate without turning on deferred upstream agents. |
| `additions/agents/pr-reviewer.md` | Gives `subagent` a reviewer that can read a PR and post its record with `gh`, for [job runner](runner/README.md) leads. |
| `additions/agents/sub-lead.md` | Builds one unit of a [job runner](runner/README.md) ticket through the lead's merge gate, with auto-exit on and no spawning tools. |
| `additions/skills/deeper/SKILL.md` | Turns a task into a deeper prompt. It predates upstream `sharpen`, which the manifest omits in its favor. |
| `additions/skills/show-me/` | Adapts the MIT-licensed `show-me` skill from [humanlayer/skills](https://github.com/humanlayer/skills) with bug views and set nodes. Ships the license notice in `references/humanlayer-license.md`. |
| `additions/skills/intake/SKILL.md` | Tells any session that files a ticket for an agent to check the ask against the project's decisions in a fresh session, write Goal, Reference and Not doing, then delegate it. The [job runner](runner/README.md) leads read those headings. |
| `additions/skills/list-writing/SKILL.md` | Turns the checklist in [Agent text at scale](https://fsdatalab.github.io/blog/agent-text-at-scale/) into rules for lists and breakdowns. |

Cursor distribution metadata, guides, branding assets, Cloud Automations, unbundled playbooks, and unsupported scripts remain omitted.
54 of the 58 upstream main skill entrypoints are present, including the webhook-backed `make-bot-ui`, plus the Pi-owned `deeper`, `intake`, `list-writing`, and `show-me` skills. `ADAPTATIONS.md` lists the four omitted skills and why. Missing external service capabilities remain explicit limits, not silently changed tasks.
Two upstream agents have targeted Pi transforms. `general-purpose`, `pr-reviewer` and `sub-lead` ship from `additions/agents/`.

[0xrsydn/pstack-pi](https://github.com/0xrsydn/pstack-pi) and [kkgogogo17/pi-pstack](https://github.com/kkgogogo17/pi-pstack) are implementation references, not sources for shared content.
The [aaalexliu/pstack-pi project](https://github.com/aaalexliu/pstack-pi) owns the Pi adaptations and package code.

## Regeneration and checks

Never edit generated `skills/`, generated `agents/`, or the pinned snapshot by hand.
Edit Pi-owned agents and skills in place under `additions/`, and list each file in `package.json`.
For a reviewed manifest change against the existing snapshot that also affects runtime or package loading, the full-check path is:

```sh
npm ci
npm run sync:relock
npm run sync
npm run check
```

Relock verifies the existing snapshot before updating adaptation hashes.
Sync writes only managed content.
Neither command changes package metadata or documentation.

Text-only manifest changes use the same relock and sync steps, then the non-runtime gate in `TESTING.md` instead of `npm run check`. `RELEASING.md` applies those change-based local gates before a push; CI always runs the full check. `SYNCING.md` covers moving the upstream pin and recovering from a failed sync.

The packed package has no runtime dependencies. Pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` to extensions.
`skipLibCheck` skips defective third-party declarations in Pi's dependency tree. Project TypeScript still uses strict checking.
