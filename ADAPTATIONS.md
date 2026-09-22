# Reviewed Pi adaptations

**No full-file replacements remain.** The production manifest classifies 158 upstream files as 51 copies, 50 exact transforms, and 57 omissions. The Pi-owned `general-purpose` agent is a separate addition, not an upstream replacement.

Every transform starts from the pinned upstream file. It changes exact literal regions with checked occurrence counts; everything else stays verbatim. The importer requires the expected Git blob and locks the transform digest and output hash. Routine sync runs no LLM and performs no fuzzy matching.

The 31 former replacements were rebuilt from upstream, not encoded as whole-file patches of the rewrites. Thirty became targeted transforms. `skills/poteto-mode/playbooks/investigation.md` needed no host edits and is now a byte-for-byte copy. All 23 principle skills also remain byte-for-byte copies.

## Transformed files

The manifest contains the exact ordered `find`, `replace`, and `count` values for each file below. The table records why the edits exist, including small correctness fixes kept from the fidelity audit. It does not list copies or omissions; use `sync/manifest.json` for the complete inventory.

| Upstream file | Edit scope |
| --- | --- |
| `agents/comment-sicko.md` | Lowercase agent name and explicit read tools; parent supplies Git/context and applies proposed deletions. |
| `agents/poteto-agent.md` | Remove background/resume fields; add Pi tools, an absolute shared-skill path, and a bounded implementation role. |
| `skills/architect/SKILL.md` | Pi command, todo, and model-panel routing; parent orchestrates isolated leaf design tasks. |
| `skills/architect/references/runner-prompt.md` | Remove the promise that every candidate uses a different model. |
| `skills/arena/SKILL.md` | Pi command, todos, full configured panel, isolated writers, bounded requests, file receipts, and read-only cross-judge. |
| `skills/automate-me/SKILL.md` | Pi skill/session paths, chat choices, bounded history readers, and native skill authoring. |
| `skills/create-verification-skill/SKILL.md` | Pi output paths and command names; use available control tools and a file-relative example link. |
| `skills/create-verification-skill/references/feature-map-example/search.md` | Restore the query and results before recording proof after the clear-query step. |
| `skills/figure-it-out/SKILL.md` | Pi command and todos; bounded readers/writers, parent-owned services, and isolated scratch outputs. |
| `skills/how/SKILL.md` | Replace Cursor task fields and models with Pi roles and bounded leaf readers. |
| `skills/how/references/explainer-prompt.md` | Pi read-tool names; distinguish direct exploration from supplied explorer findings. |
| `skills/how/references/explorer-prompt.md` | Pi read-tool names only. |
| `skills/interrogate/SKILL.md` | Replace only reviewer launch mechanics; add parent claim verification. Scope, judgment, and verdict format stay verbatim. |
| `skills/maintain-verification-skill/SKILL.md` | Pi skill paths/commands, bounded source readers, parent driving, and authorized publication. |
| `skills/make-bot-ui/SKILL.md` | Replace Cursor routine/secret-card UI assumptions with documented service access and private local secret setup. Keep the webhook protocol. |
| `skills/no-comments/SKILL.md` | Pi reviewer and skill commands; parent applies deletions and owns external checks. |
| `skills/poteto-mode/SKILL.md` | Remove unsupported frontmatter, Cursor plugins, and task defaults. Add Pi boundaries, string-checklist API examples, pointers to bundled lifecycle playbooks, and fallbacks for still-unbundled Autopilot workflows. |
| `skills/poteto-mode/playbooks/authoring-a-skill.md` | Replace Cursor built-in create-skill with Pi skill-authoring docs or an installed create-skill / figure-it-out path. |
| `skills/poteto-mode/playbooks/autonomous-run.md` | Replace Cursor `/loop` wake and AskQuestion with active-session checkpoints and no unattended wake promise; keep exit-predicate discipline. |
| `skills/poteto-mode/playbooks/babysit.md` | Replace watch-pr and `/loop` with forge/`gh`/`origin` active-session checkpoints; fold phase-leaf, background fallback, and anti-merge rules from the former Local Babysit gates. |
| `skills/poteto-mode/playbooks/bug-fix.md` | Replace the Cursor loop command and default model with local checkpoints and the bug-fix role. |
| `skills/poteto-mode/playbooks/eval.md` | Replace Cursor agent-transcripts paths with project-scoped Pi session paths. |
| `skills/poteto-mode/playbooks/feature.md` | Replace default models and nested delegation with parent-dispatched leaf implementation. |
| `skills/poteto-mode/playbooks/hillclimb.md` | Replace the default hillclimb model with configured judgment roles; point unattended wake limits at `playbooks/autonomous-run.md` without inventing a watcher. |
| `skills/poteto-mode/playbooks/multi-phase-plan.md` | Local task paths, model roles, bounded lanes, manual checker fallback, and parent-owned status/landing instead of cloud controls. Point Autopilot fallbacks and skeleton gates at bundled Babysit/Shipping and bugbot-triage. |
| `skills/poteto-mode/playbooks/opening-a-pr.md` | Replace `/deslop` and Cursor skill commands with local slop inspection and `/skill:` paths; soften Task nesting to leaf-task worktree language. |
| `skills/poteto-mode/playbooks/orchestrate.md` | Remove cloud/nested-agent and orch runtime requirements; keep the queue, briefs, ledgers, pilot, verification, and reply contracts. |
| `skills/poteto-mode/playbooks/perf-issue.md` | Use available surface-control tools and configured judgment roles instead of control-skill and default model ids. Retarget the Hillclimb cross-link to a same-directory path. |
| `skills/poteto-mode/playbooks/prototype.md` | Use available surface-control tools instead of assuming a control skill. |
| `skills/poteto-mode/playbooks/refactoring.md` | Replace the default refactoring model and control skill with configured mechanical-edit roles and available surface-control tools. |
| `skills/poteto-mode/playbooks/runtime-forensics.md` | Use available surface-control tools instead of assuming a control skill; parse large artifacts in a bounded leaf task. |
| `skills/poteto-mode/playbooks/session-pickup.md` | Replace Cursor agent-transcripts and cloud-agent URLs with scoped Pi session discovery; use bounded leaf readers. |
| `skills/poteto-mode/playbooks/shipping.md` | Replace cloud agents, control-kit, and watch-pr/`/loop` with parent-owned independent reviewers and forge checkpoints; fold patch-id and contiguous-landing gates from the former Local Shipping gates. |
| `skills/poteto-mode/playbooks/trace-forensics.md` | Rewrite `subagent (` phrasing to a bounded leaf task so the content gate stays clean. |
| `skills/poteto-mode/playbooks/visual-parity.md` | Use available surface-control tools and an explicit local loop instead of control-skill and `/loop`. |
| `skills/poteto-mode/playbooks/worktree-cleanup.md` | Drop the omitted audit script and `.cursor` paths; keep prune authorization gates; soft-disclose iOS simulator steps; never treat idle as safe to delete. |
| `skills/recall/SKILL.md` | Scoped Pi session discovery and bounded local readers; parent owns shared-record searches. |
| `skills/reflect/SKILL.md` | Pi sessions, model roles, leaf readers, parent evidence follow-up, native authoring, and authorized tracker writes. |
| `skills/reflect/references/divergent-reviewer.md` | Pi transcript/tool paths and invocation evidence; parent performs referenced external lookups. |
| `skills/reflect/references/judgment-reviewer.md` | Pi transcript/tool paths and invocation evidence; parent performs referenced external lookups. |
| `skills/reflect/references/synthesizer.md` | Parent external checks, Pi authoring routes, and supported trigger metadata; keep acceptance criteria and output tables. |
| `skills/reflect/references/tooling-reviewer.md` | Pi transcript/tool paths and invocation evidence; parent performs referenced external lookups. |
| `skills/setup-pstack/SKILL.md` | Pi model discovery and version-1 role JSON instead of Cursor rules; keep confirmation, validation, and verification-skill offer. |
| `skills/show-me-your-work/SKILL.md` | Scoped Pi sessions, a manual TSV appender, append-only corrections, and explicit independent reviewer selection. |
| `skills/swarm/SKILL.md` | Local leaf workers and Pi model roles instead of cloud fields; retain logical coverage across bounded requests. |
| `skills/teach/SKILL.md` | Parent-owned research and available visual tools; keep teaching and progressive-diagram rules. |
| `skills/technical-writing/SKILL.md` | Change one skill command to Pi syntax. |
| `skills/typescript-best-practices/SKILL.md` | Remove unsupported paths frontmatter. |
| `skills/why/SKILL.md` | Parent owns Git/MCP searches and citation checks; leaf readers use supplied evidence. Remove Cursor task fields and defaults. |
| `skills/why/references/synthesizer-prompt.md` | Use an explicit URL placeholder and one file-relative reference path. |

## Preserved behavior and host limits

Removing a tool reference must not remove the work it supported. Pi readers return evidence requests when only the parent can run Git or external tools. The parent owns orchestration and integration. Logical panels and coverage may span several bounded requests; the eight-task limit does not shrink the planned work. Missing service access remains an explicit gap, not a successful step.

Tier A and Tier B poteto-mode playbooks ship as copies or narrow transforms. Tier B adds `babysit`, `shipping`, `bugbot-triage` (byte-for-byte copy), `autonomous-run`, `session-pickup`, and `worktree-cleanup`. Former Local Babysit and Shipping gates in `SKILL.md` were folded into those playbooks; `SKILL.md` keeps short pointers. Tier C autopilot playbooks and upstream scripts remain omissions. References to still-omitted workflows name the absent file and a local fallback instead of promising an unavailable path.

`tests/content/workflow-contracts.json` records reviewed upstream passages separately from Pi boundary clauses. `tests/content/fidelity.test.mjs` checks both against the package-loaded files, rejects full replacements, and checks that command edits do not alter scratch paths. Production tests replay every transform and verify all copied bytes. These tests check instructions and loading, not model compliance.

## Why the earlier replacements lost behavior

Commit `0a6f170` activated Interrogate as an 18-line replacement of the 111-line source workflow. Its reason cited Cursor tools and model routing, but the rewrite also dropped scope selection, configured panel membership, attribution, and the verdict structure. Hash checks accepted the reviewed bytes; they did not prove a faithful adaptation.

Commit `033024e` restored the missing contracts and converted Interrogate to two exact transforms. This pass removes the remaining full replacements. Future edits should change the narrow host-specific region, not summarize the skill. Do not use a giant transform to disguise a full rewrite.

The upstream pin remains `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`. Later Cursor model-default and reasoning-budget changes require a separate upstream update.
