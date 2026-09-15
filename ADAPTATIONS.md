# Reviewed Pi replacements

These files are derived from the matching files in the pinned Cursor pstack snapshot. The sync manifest binds each replacement to the exact upstream Git blob and to the replacement's SHA-256 digest. `npm run sync:check` fails when either side changes without review.

Use `copy` when Cursor content already works in Pi. Prefer an exact, count-checked `transform` for tool names, paths, frontmatter, or a bounded runtime section. Leave the rest of the source verbatim. Use `replace` only when execution ownership changes throughout the workflow. A replacement must preserve scope, triggers, evidence standards, checkpoints, outputs, and failure handling. Shortening is not a host adaptation.

## Fidelity repair

Commit `0a6f170` activated Interrogate as an 18-line replacement of the 111-line upstream workflow. Its rationale cited Cursor tool and model routing, but the rewrite also removed scope selection, configured panel membership, model attribution, and the verdict structure. The sync checks accepted the reviewed hashes and dependency closure; they did not check whether the skill still did the same job. Hash locking prevents unreviewed drift, not a lossy initial review.

The repair compares all 32 former replacements with the pinned source. It restores their workflow contracts and moves Interrogate to two exact transforms. Important repairs include plan-only Multi-phase Plan, the webhook-backed Make Bot UI with its secret and delivery rules, Why's original confidence tiers and source coverage, Arena's private rubric and complete configured panel, and evidence, approval, and output rules throughout the remaining skills. Pi-specific limits remain explicit rather than silently deleting work.

`tests/content/fidelity.test.mjs` checks critical clauses in every remaining replacement and rejects clause-removal mutations. It also proves that Interrogate's scope, intent, lead judgment, and output sections remain byte-identical to upstream. These are static instruction checks, not proof of model compliance or a substitute for reviewing upstream changes.

## Full-file replacements

| Upstream file | What the Pi replacement changes | Why copy or a short transform is unsafe |
| --- | --- | --- |
| `agents/poteto-agent.md` | Adds a strict Pi tool allowlist, a bounded implementation role, explicit verification, and a leaf-only no-delegation rule. | Cursor's `is_background` frontmatter is unsupported in Pi. The source has no Pi tool allowlist and assumes Cursor can resume and nest this agent. |
| `skills/how/SKILL.md` | Maps simple and parallel exploration to Pi's `subagent` input, exact `how-explorer` and `how-explainer` roles, and a local fallback. | The source uses Cursor `Task`, `subagent_type`, `readonly`, and Cursor-only default model slugs throughout the control flow. |
| `skills/how/references/explorer-prompt.md` | Names the read-only tools the bundled Pi agent actually receives and forbids nested delegation. | The source tells the child to use Cursor's `Glob` tool and does not state Pi's leaf boundary. |
| `skills/how/references/explainer-prompt.md` | Supports both direct and multi-explorer paths, uses Pi's read-only child contract, and keeps the same explanation sections. | The source assumes a Cursor synthesis child with `Glob` and always assumes prior explorer output. |
| `skills/poteto-mode/SKILL.md` | Routes the full main-skill set, maps delegation to Pi tools and roles, and keeps external or irreversible actions under host policy. | The source uses unsupported mode frontmatter, `AskQuestion`, `/loop`, Cursor cloud agents, nested agents, and external Cursor plugins. Small substitutions would leave false runtime promises. |
| `skills/poteto-mode/playbooks/bug-fix.md` | Keeps end-to-end reproduction, `why` history checks, root-cause tracing, regression coverage, a bounded Pi implementation delegate, and real-surface verification. | The source requires Cursor control plugins, `/loop`, nested subagents, and automatic pull-request workflows. |
| `skills/poteto-mode/playbooks/feature.md` | Keeps subsystem discovery, `architect`, `arena`, and `interrogate` routing, an explicit data owner, bounded delegation, parent review, and verification. | The source requires Cursor background agents, nested delegation, `/loop`, and automatic pull-request workflows. |
| `skills/poteto-mode/playbooks/investigation.md` | Keeps read-only scope, `how` and `why` routing, evidence splits, citations, and bounded Pi readers. | The source assumes Cursor routed agents, background tasks, model aliases, and automatic pull-request workflows. |
| `skills/poteto-mode/playbooks/prototype.md` | Keeps decision-first probes, `architect` and `arena` routing, competing options, observed evidence, cleanup, and handoff to Feature. | The source requires Cursor UI-control plugins, nested agents, and automatic pull-request workflows for each prototype class. |
| `skills/poteto-mode/playbooks/multi-phase-plan.md` | Keeps plan-only scope, explicit operator go, the plan skeleton, dependencies, live and perf proof, review gates, and manual validation when the checker is absent. | The source requires Cursor cloud lanes, `/goal`, `/loop`, `gt`, fixed ten-agent verification, and a Cursor agent-store path. |
| `skills/poteto-mode/playbooks/orchestrate.md` | Keeps independent workstream mapping, `swarm` and `blast-radius` routing, one-owner writes, bounded Pi task batches, ordered integration, and local fallback. | The source is a multi-day Cursor cloud coordinator backed by nested agents, an `orch` runtime, cloud VMs, `gt`, dashboards, and depth-three delegation. Pi's package intentionally supports leaf children and one live request. |
| `agents/comment-sicko.md` | Uses a lowercase Pi agent name, explicit read-only tools, report-only output, and no delegation. | The source has no Pi tool allowlist, uses an invalid spaced agent name, invokes nested skills, and expects the child to edit comments. |
| `skills/architect/SKILL.md` | Keeps caller-first scaffolds, rationale, opt-in sign-off, and the scrap loop; maps design packages to isolated leaf writers and `architect-runner`. | The source assumes Cursor model defaults and an external model-rule file rather than Pi's exact role router. |
| `skills/arena/SKILL.md` | Preserves the full model panel across bounded requests, isolated runnable candidates, private rubric, criterion scoring, grafting, and verified synthesis. | The source requires Cursor background tasks, cloud paths, `readonly`, and Cursor model configuration. |
| `skills/automate-me/SKILL.md` | Uses scoped Pi sessions, `.pi/skills`, read-only mining children, and direct skill authoring. | The source depends on Cursor transcript paths, `AskQuestion`, Cursor's built-in `create-skill`, and `.cursor/skills`. |
| `skills/create-verification-skill/SKILL.md` | Generates `.pi/skills/verify-*` with repository-native launch, drive, evidence, and cleanup steps. | The source writes `.cursor/skills` and assumes Cursor control surfaces and authoring behavior. |
| `skills/figure-it-out/SKILL.md` | Uses supported skills, `pstack_todo`, bounded leaf agents, and evidence-driven local continuation. | The source routes through unavailable Cursor orchestration, cloud, and loop behavior. |
| `skills/maintain-verification-skill/SKILL.md` | Finds `.pi/skills/verify-*`, bounds source readers, and keeps live driving and edits in the parent. | The source assumes `.cursor/skills`, Cursor fan-out, and Cursor-specific skill invocation. |
| `skills/make-bot-ui/SKILL.md` | Preserves the webhook UI, server-owned secrets, request headers, timeout/no-retry policy, failure log, harmless probe, tailnet setup, and event parsing. | Cursor's routine creation, secret-request cards, and wake handling need an available external service in Pi. Missing service access is a block, not a different design task. |
| `skills/no-comments/SKILL.md` | Uses the bundled read-only `comment-sicko`; the parent verifies and applies accepted changes. | The source invokes Cursor `Task` with a write-capable Comment Sicko and nested skill calls. |
| `skills/recall/SKILL.md` | Uses `pstack_sessions`, scoped Pi JSONL files, bounded readers, and live Git or issue checks. | The source assumes Cursor transcript directories and cloud subagents. |
| `skills/reflect/SKILL.md` | Uses `$PI_SESSION_FILE`, four exact Pi roles, read-only children, and parent-owned skill updates. | The source depends on Cursor transcript discovery, `Task`, MCP access inside children, and Cursor `create-skill`. |
| `skills/reflect/references/judgment-reviewer.md` | Narrows the reviewer to repeatable judgment lessons with transcript evidence. | The source assumes Cursor transcript shape and broader child capabilities. |
| `skills/reflect/references/tooling-reviewer.md` | Returns the smallest durable type, test, script, generator, lint, or runtime fix. | The source assumes Cursor tool names and transcript access inside the child. |
| `skills/reflect/references/divergent-reviewer.md` | Looks for bad premises, false success signals, and simpler missed routes without writing. | The source assumes Cursor `Task`, `Read`, and `Grep` behavior. |
| `skills/reflect/references/synthesizer.md` | Produces evidence-bound Accepted, Rejected, and Backlog lists without editing. | The source assumes a write-capable Cursor synthesis child and Cursor routing. |
| `skills/setup-pstack/SKILL.md` | Writes strict version-1 `pstack-pi/models.json` after `pstack_config` model discovery and validation. | The source writes Cursor always-applied rules and uses `AskQuestion` and Cursor model aliases. |
| `skills/show-me-your-work/SKILL.md` | Keeps the exact TSV schema with a manual appender, `$PI_SESSION_FILE`, append-only corrections, pivot coverage, and independent model-family audit with identity. | The source assumes Cursor transcript directories and helper placement. |
| `skills/swarm/SKILL.md` | Keeps coverage, race, and mixed-mode selection rules across bounded requests, isolated writes, role `swarm-worker`, and explicit dropout accounting. | The source requires Cursor cloud workers, background tasks, and cloud branch controls. |
| `skills/teach/SKILL.md` | Composes Pi `how`, `why`, and `unslop`, with optional available visual tools. | The source requires image generation for spatial teaching even when Pi has no such tool. |
| `skills/why/SKILL.md` | Keeps external evidence gathering in the parent and limits leaf agents to local archaeology and synthesis they can support. | The source discovers Cursor MCPs and expects delegated children to receive external MCP tools that this runtime intentionally withholds. |

## Exact transforms

All 23 principle skills remain byte-for-byte upstream copies. Six files use ordered literal transforms, each bound to an upstream blob and exact match counts:

- `skills/interrogate/SKILL.md`: replace only the reviewer-launch section with explicit Pi model selection and bounded read-only tasks; add parent claim verification to synthesis. Keep all other bytes upstream, including verdict categories and output format.
- `skills/architect/references/runner-prompt.md`: remove the false promise that each candidate uses a different model. The parent reports actual diversity.
- `skills/create-verification-skill/references/feature-map-example/search.md`: restore the query and results after clearing search, before recording proof. This also fixes a bug in the source example.
- `skills/technical-writing/SKILL.md`: change one skill command to Pi syntax.
- `skills/typescript-best-practices/SKILL.md`: remove unsupported `paths` frontmatter.
- `skills/why/references/synthesizer-prompt.md`: change one placeholder URL to `{URL}` and one skill-root-relative path to a file-relative path.

The pin remains `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`. Later Cursor model-default and reasoning-budget changes are a separate upstream update, not behavior deleted by these replacements.
