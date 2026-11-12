# Reviewed Pi adaptations

**No full-file replacements remain.** The production manifest classifies 573 upstream files as 74 copies, 53 exact transforms, and 446 omissions. The statechart test suite and its two dev configs account for 378 of the omissions. Pi-owned content ships from `additions/`, outside the generated folders: the `general-purpose` agent and the `deeper`, `alex-show-me`, and `list-writing` skills. None is an upstream replacement.

Every transform starts from the pinned upstream file. It changes exact literal regions with checked occurrence counts; everything else stays verbatim. The importer requires the expected Git blob and locks the transform digest and output hash. Routine sync runs no LLM and performs no fuzzy matching.

The 31 former replacements were rebuilt from upstream, not encoded as whole-file patches of the rewrites. Thirty became targeted transforms. `skills/poteto-mode/playbooks/investigation.md` is a narrow reader-explanation transform, not a copy. Principle skills remain byte-for-byte copies, including the new `principle-explain-the-number` leaf. `benchmark-checklist` is a copy. `correct` only rewrites the Pi skill command. `deeper` lives in `additions/` and has no upstream file. `alex-show-me` lives there too. It adapts HumanLayer's MIT `show-me` skill, not a pstack file, and ships that license notice under `references/`. So does `list-writing`. It is the only skill without `disable-model-invocation: true`, so the model can load it for any list or breakdown.

The `c742dd6` pin added eight upstream skills. Five ship as narrow transforms: `in-your-own-words`, `create-formal-verification-skill`, `maintain-formal-verification-skill`, `statechart`, and `ketchup`. Three upstream skills are omitted:

- `poteto-help` is a Cursor setup guide that links to the omitted guide pages.
- `ketchup-video` renders a subtitled slide video and embeds it in the reply in place of ketchup's summary. Pi cannot play a video in the transcript, so the reply's main output would become a file path.
- `sharpen` asks the same four questions as the Pi-owned `deeper` addition, which predates the pin.

`statechart` ships its 27 runtime scripts as byte-for-byte copies. The `scripts/statechart` wrapper keeps its executable mode and runs `statechart.ts` with Node 22.18 to 22.x, Node 23.6 or later, Bun 1.1.5 or later, or Deno 2.0 or later. Its first run installs TLC and Java with mise and needs the network. The upstream suite under `scripts/test/` and the `scripts/package.json` and `scripts/tsconfig.json` that serve it stay omitted. The runtime never reads them, and the suite needs fast-check, Pele, Java, and TLC. Node refuses to strip types under `node_modules`, so the skill runs from a Git or local-path install, not an npm install. The content checker treats `skills/<name>/scripts/` as code: it checks bytes and mode, not instruction prose.

## Transformed files

The manifest contains the exact ordered `find`, `replace`, and `count` values for each file below. The table records why the edits exist, including small correctness fixes kept from the fidelity audit. It does not list copies or omissions; use `sync/manifest.json` for the complete inventory.

| Upstream file | Edit scope |
| --- | --- |
| `agents/comment-sicko.md` | Explicit read tools; parent supplies Git/context and applies proposed deletions. |
| `agents/poteto-agent.md` | Remove background/resume fields; add Pi tools and a bounded implementation role. The skill-read sentence names `{{PSTACK_ROOT}}/skills/poteto-mode/SKILL.md`, so the Cursor plugin-cache search is gone, and principle leaves live under `{{PSTACK_ROOT}}/skills/`. |
| `skills/architect/SKILL.md` | Pi command, todo, and model-panel routing; parent orchestrates isolated leaf design tasks. |
| `skills/architect/references/runner-prompt.md` | Remove the promise that every candidate uses a different model. |
| `skills/arena/SKILL.md` | Pi command, todos, full configured panel, isolated writers, bounded requests, file receipts, and a read-only cross-judge from another model family, tried in configured order and then from `list-models`. Models or reviewers the user names replace the panel; if one cannot run, the parent says so and asks before substituting. |
| `skills/automate-me/SKILL.md` | Pi skill/session paths, chat choices, bounded history readers, and native skill authoring. |
| `skills/create-verification-skill/SKILL.md` | Pi output paths and command names; use available control tools and a file-relative example link. |
| `skills/create-formal-verification-skill/SKILL.md` | Pi skill commands, including the three `/skill:statechart` references. The link to `../statechart/SKILL.md` and the rest of the statechart paragraph stay upstream. |
| `skills/create-verification-skill/references/feature-map-example/search.md` | Restore the query and results before recording proof after the clear-query step. |
| `skills/figure-it-out/SKILL.md` | Pi command and todos; bounded readers/writers, parent-owned services, and isolated scratch outputs. |
| `skills/how/SKILL.md` | Replace Cursor task fields and models with Pi roles and bounded leaf readers. Keep the senior-engineer bar. Explanations still lead with the surrounding workflow, one concrete example, and no coined phase name. When the answer depends on an outside product, the parent reads the vendor's docs and keeps documented guarantees apart from assumptions. A simple question is answered in the session with no subagent, because spawning an explainer for a narrow question cost a minute and drew a user correction. |
| `skills/how/references/explainer-prompt.md` | Pi read-tool names; distinguish direct exploration from supplied explorer findings. Keep the senior-engineer audience, including the depth bar. The reader is still not in this code: workflow and one example first, then file and function names. |
| `skills/in-your-own-words/SKILL.md` | Pi skill command only. |
| `skills/interrogate/SKILL.md` | Replace only the panel line and the adversary agent. Adversaries run as writable `poteto-agent` children in their own worktrees because each finding needs a run. The brief, verification, and output stay verbatim. |
| `skills/ketchup/SKILL.md` | Pi skill commands. A real Pi session showed a Markdown image in a reply as its alt text only, with the path dropped, so the reply shows each screenshot with the read tool and gives its absolute path. Pi plays no video, so the reply gives video paths. Pi has no `/visualize`, so charts become text bar charts in a code block. Mermaid stays because Pi draws supported Mermaid diagrams in the transcript. |
| `skills/maintain-formal-verification-skill/SKILL.md` | Pi skill commands only. |
| `skills/maintain-verification-skill/SKILL.md` | Pi skill paths/commands, bounded source readers, parent driving, and authorized publication. |
| `skills/make-bot-ui/SKILL.md` | Replace Cursor routine/secret-card UI assumptions with documented service access and private local secret setup. Keep the webhook protocol. |
| `skills/no-comments/SKILL.md` | Pi reviewer and skill commands; parent applies deletions and owns external checks. |
| `skills/poteto-mode/SKILL.md` | Remove unsupported frontmatter, Cursor plugins, and task defaults. Add Pi boundaries, string-checklist API examples, and explicit fallbacks for still-unbundled workflows. Keep the fresh-subagent default and consolidated handoff; Pi cannot resume a child. Playbook entries for omitted workflows say they are not bundled and name the local gates or figure-it-out fallback, because the index now derives `playbooks/<title>.md` from each title. Match the model to the job passes the reasoning level as the `blocking_subagent` `thinking` field and starts from the role selector's `:<level>` suffix. Pi has no fast mode, so the speed choice is gone. Point principle leaves at sibling paths such as `../principle-prove-it-works/SKILL.md` or `/skill:principle-prove-it-works` so Pi's skill-relative base does not invent `principles/`. Explanations lead with the surrounding workflow, one concrete example, and no coined phase name. During live design discussion, confirm or delegate widespread edits and stop when the user asks why. |
| `skills/poteto-mode/playbooks/investigation.md` | Explanations lead with the surrounding workflow, a concrete example, and no coined phase name. |
| `skills/poteto-mode/playbooks/authoring-a-skill.md` | Replace Cursor built-in create-skill with Pi skill-authoring docs or an installed create-skill / figure-it-out path. |
| `skills/poteto-mode/playbooks/bug-fix.md` | Replace the Cursor loop command and default model with local checkpoints and the bug-fix role. |
| `skills/poteto-mode/playbooks/eval.md` | Replace Cursor agent-transcripts paths with project-scoped Pi session paths. |
| `skills/poteto-mode/playbooks/feature.md` | Replace default models and nested delegation with parent-dispatched leaf implementation. |
| `skills/poteto-mode/playbooks/hillclimb.md` | Replace the default hillclimb model with configured judgment roles; state the Autonomous Run wake gap instead of promising an absent playbook. |
| `skills/poteto-mode/playbooks/multi-phase-plan.md` | Local task paths, model roles, bounded lanes, manual checker fallback, and parent-owned status/landing instead of cloud controls. Resolve Opening a PR to the bundled playbook. |
| `skills/poteto-mode/playbooks/opening-a-pr.md` | Replace `/deslop` and Cursor skill commands with local slop inspection and `/skill:` paths; soften Task nesting to leaf-task worktree language; point the stack retarget at the local Shipping gates. |
| `skills/poteto-mode/playbooks/orchestrate.md` | Replace cloud workers, sub-coordinators, forks, and messages with local leaf tasks the parent coordinates, in bounded `blocking_subagent` requests with a finite `timeoutMs`. Keep the owner, kickoff, verifier, supervision, and reply contracts. |
| `skills/poteto-mode/playbooks/perf-issue.md` | Use available surface-control tools and configured judgment roles instead of control-skill and default model ids. Retarget the Hillclimb cross-link to a same-directory path. |
| `skills/poteto-mode/playbooks/prototype.md` | Use available surface-control tools instead of assuming a control skill. An observation proves only the contract it ran; rerun it after the contract changes. |
| `skills/poteto-mode/playbooks/refactoring.md` | Replace the default refactoring model and control skill with configured mechanical-edit roles and available surface-control tools. |
| `skills/poteto-mode/playbooks/runtime-forensics.md` | Use available surface-control tools instead of assuming a control skill; parse large artifacts in a bounded leaf task. |
| `skills/poteto-mode/playbooks/trace-forensics.md` | Rewrite `subagent (` phrasing to a bounded leaf task so the content gate stays clean. |
| `skills/poteto-mode/playbooks/visual-parity.md` | Use available surface-control tools and an explicit local loop instead of control-skill and `/loop`. |
| `skills/recall/SKILL.md` | Scoped Pi session discovery and bounded local readers; parent owns shared-record searches. |
| `skills/reflect/SKILL.md` | Pi sessions, model roles, leaf readers, parent evidence follow-up, native authoring, and authorized tracker writes. Edit a copy in `.pi/skills/` or `~/.pi/agent/skills/`, never the installed package, and confirm Pi loads the copy. |
| `skills/reflect/references/divergent-reviewer.md` | Pi transcript/tool paths and invocation evidence; parent performs referenced external lookups. |
| `skills/reflect/references/judgment-reviewer.md` | Pi transcript/tool paths and invocation evidence; parent performs referenced external lookups. |
| `skills/reflect/references/synthesizer.md` | Parent external checks, Pi authoring routes, and supported trigger metadata; keep acceptance criteria and output tables. |
| `skills/reflect/references/tooling-reviewer.md` | Pi transcript/tool paths and invocation evidence; parent performs referenced external lookups. |
| `skills/correct/SKILL.md` | Pi skill command only. |
| `skills/setup-pstack/SKILL.md` | Pi model discovery and version-1 role JSON instead of Cursor rules; keep the budget ask in chat, confirmation, validation, and the verification and formal verification skill offers. The budget becomes a `:<level>` thinking suffix on each real selector, which Pi reads from `--model`. |
| `skills/show-me-your-work/SKILL.md` | Scoped Pi sessions, a manual TSV appender, append-only corrections, and explicit independent reviewer selection. |
| `skills/statechart/SKILL.md` | Pi skill command in the invocation hint only. Pi renders `mermaid` code blocks in interactive transcripts, so the chart and Pele rules stay upstream. |
| `skills/statechart/references/render.md` | Paint the chart background from `--pele-bg`. Pele draws no full background, so in dark mode a browser showed the light title and edge-label boxes on a white canvas. |
| `skills/swarm/SKILL.md` | Local leaf workers and Pi model roles instead of cloud fields; retain logical coverage across bounded requests. |
| `skills/teach/SKILL.md` | Parent-owned research and available visual tools; keep teaching and progressive-diagram rules. The person is not in this code: workflow and one example first, then file and function names. |
| `skills/technical-writing/SKILL.md` | Change one skill command to Pi syntax. |
| `skills/typescript-best-practices/SKILL.md` | Remove unsupported paths frontmatter. |
| `skills/unslop/SKILL.md` | Reject a coined local name for a step or phase. Say what happens, or use a name the code, the docs, or the user already use. |
| `skills/why/SKILL.md` | Parent owns Git/MCP searches and citation checks; leaf readers use supplied evidence. Remove Cursor task fields and defaults. Present the answer as a workflow and one concrete example before the evidence sections. A why question is not a change plan. |
| `skills/why/references/synthesizer-prompt.md` | Use an explicit URL placeholder and one file-relative reference path; external citation checks go back to the parent. |

## Preserved behavior and host limits

Upstream tells each delegating skill to pick a subagent's reasoning level and fast or standard speed. Pi keeps the reasoning level, which the `blocking_subagent` tool takes as `thinking`, and drops the speed, because Pi has no fast mode. The transform applies in every file that has the clause.

Removing a tool reference must not remove the work it supported. Pi readers return evidence requests when only the parent can run Git or external tools. The parent owns orchestration and integration. Logical panels and coverage may span several bounded requests; the eight-task limit does not shrink the planned work. Missing service access remains an explicit gap, not a successful step.

Tier A poteto-mode playbooks ship as copies or narrow transforms: `opening-a-pr`, `refactoring`, `pause-safely`, `hillclimb`, `perf-issue`, `authoring-a-skill`, `eval`, `runtime-forensics`, `trace-forensics`, and `visual-parity`. `pause-safely` needed no host edits and is a byte-for-byte copy. `trace-forensics` only rewrites the `subagent (` phrasing that the content gate rejects. Babysit, Shipping, bugbot-triage, Tier B (`autonomous-run`, `session-pickup`, `worktree-cleanup`), Tier C autopilot playbooks, and the other upstream scripts remain omissions. References to still-omitted workflows name the absent file and a local fallback instead of promising an unavailable path.

`tests/content/workflow-contracts.json` records reviewed upstream passages separately from Pi boundary clauses. `tests/content/fidelity.test.mjs` checks both against the package-loaded files, rejects full replacements, and checks that command edits do not alter scratch paths. Production tests replay every transform and verify all copied bytes. These tests check instructions and loading, not model compliance.

## Interactive subagents

`extensions/interactive-subagents/` is a squashed `git subtree` of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) at v3.7.2, commit `c100577ebf7393a11d098ad9810ec6c269dcfc30`. Its MIT `LICENSE` ships with it. It runs non-blocking subagents in cmux or tmux panes the user can watch and steer. Upstream's names stay: the `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list` tools, `subagent_done` and `caller_ping` in children, and the `/plan`, `/iterate`, and `/subagent` commands. pstack-pi's blocking tool is `blocking_subagent` so both fit. Upstream's `@mariozechner` and `@sinclair/typebox` imports stay; Pi 1.5.2 aliases them.

Each change below is one or more commits on top of the subtree. The first group ports [aaalexliu/pi-interactive-subagents](https://github.com/aaalexliu/pi-interactive-subagents) (fork commit `f767085`) without its tool rename, its `interactive-subagents.json`, or its `agentDirs` setting. `SYNCING.md` explains how to pull a new upstream tag.

| Change | Why | Files |
| --- | --- | --- |
| Force-close finished child panes in cmux. Cleanup runs in `finally`. | cmux 0.65 refuses `close-surface` while the pane still owns a process. The close failed and the parent lost the child's report. A close failure can no longer replace the result. | `pi-extension/subagents/cmux.ts`, `pi-extension/subagents/index.ts` |
| Children get no spawning tools unless their agent says `spawning: true`, and run with `PSTACK_SUBAGENT_DEPTH=1`. | Only the parent delegates. The depth hides `blocking_subagent` in children. | `pi-extension/subagents/index.ts`, `README.md` |
| Cap running children per parent at `maxConcurrent`, default 4, and queue the rest. | Bounds load. A queued call returns at once and starts when a slot frees. | `pi-extension/subagents/index.ts` |
| cmux puts each parent's children in one `agents: <session>` workspace, as a 2x2 grid or as tabs. The workspace closes only when nothing else is in it. A new workspace waits until cmux accepts its ref. | Keeps children out of the user's own panes. A terminal the user opened there survives, and a child no longer fails to start right after another workspace closes. | `pi-extension/subagents/cmux.ts`, `pi-extension/subagents/cmux-layout.ts`, `pi-extension/subagents/index.ts` |
| tmux opens each child as a window in the parent's session. | Full-size panes instead of ever narrower splits. | `pi-extension/subagents/cmux.ts` |
| A destroyed pane, window, or workspace ends the child's watcher and frees its slot. A Claude child's sentinel is checked again after a pane-gone read. | The parent gets a stopped report with the session path instead of waiting forever. A result written during that read is kept. | `pi-extension/subagents/cmux.ts`, `pi-extension/subagents/index.ts` |
| `maxConcurrent` and `cmuxLayout` live under `interactiveSubagents` in `<agent dir>/pstack-pi/settings.json`. A missing file or key means the defaults. A bad file keeps the last good settings. | One settings file for the package, the one `/pstack-cmux` already writes and keeps unknown keys in. A file saved mid-edit never fails cleanup, admission, or spawns. | `pi-extension/subagents/config.ts`, `pi-extension/subagents/index.ts`, `README.md` |
| Agent frontmatter lists accept YAML flow lists such as `tools: [read, bash]`. | pstack-pi's agents use them. | `pi-extension/subagents/index.ts` |
| Children find pstack-pi's `agents/` and `additions/agents/` with no config, after the bundled agents and before user and project agents. `{{PSTACK_ROOT}}` resolves to the package root. | Interactive children can run `poteto-agent`, `general-purpose`, and `comment-sicko`, as `blocking_subagent` can. | `pi-extension/subagents/index.ts`, `extensions/subagent/agents.ts` |
| A `blocking_subagent` child, at depth 1 or more without `PI_SUBAGENT_NAME`, registers none of the interactive spawning tools. | Both extensions load in every child. A blocking child with host default tools would otherwise get `subagent`. | `pi-extension/subagents/index.ts`, `test/pstack.test.ts` |

`package.json` registers `pi-extension/subagents/index.ts` and ships the extension modules, plan skill, Claude Code plugin, bundled agents, README, config example, package file, and license. The plugin's `on-stop.sh` keeps its executable mode. `tsconfig.json` leaves the subtree out of `tsc`; its unit tests cover it.

## Why the earlier replacements lost behavior

Commit `0a6f170` activated Interrogate as an 18-line replacement of the 111-line source workflow. Its reason cited Cursor tools and model routing, but the rewrite also dropped scope selection, configured panel membership, attribution, and the verdict structure. Hash checks accepted the reviewed bytes; they did not prove a faithful adaptation.

Commit `033024e` restored the missing contracts and converted Interrogate to two exact transforms. This pass removes the remaining full replacements. Future edits should change the narrow host-specific region, not summarize the skill. Do not use a giant transform to disguise a full rewrite.

The upstream pin is `c742dd61706fbacc1b95f1a20b7b988cf096ce6c` (tree `4719e1c4b4c43bac85d4206a8b41dd2899769c1c`).
