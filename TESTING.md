# Testing

## Scripts

| Script | Use |
| --- | --- |
| `npm run test:fast` | Day-to-day iteration |
| `npm test` or `npm run test:full` | Full suite, the same one `npm run check` and CI run |
| `npm run test:pi` | Pi harness tests and packed real-Pi tests |
| `npm run test:pi:unit` | Pi harness tests without launching Pi |

`test:fast` runs the sync, content, pstack, subagent, and Pi harness test files in one Node test invocation. Files keep separate processes and run concurrently. It skips packed real-Pi tests. `npm test` runs that same set, then the packed tests without repeating the harness tests.

`scripts/run-tests.mjs` discovers test files. New files under `tests/pi/` default to the packed suite unless listed in `PI_UNIT_TESTS`.

`npm run check` runs `typecheck`, `sync:check`, `check:content`, and `npm test` in that order. CI runs the same command in the checkout and in a clean Git archive with no `.git` directory.

## Choose local checks by change

Use this table before committing or pushing. A docs-only push does not require `npm test` or `npm run check` locally. CI still runs the full suite in both environments.

| Change | Required local checks |
| --- | --- |
| Docs-only prose in guides, `AGENTS.md`, or test documentation | `npm run sync:check`, `npm run check:content`, and `git diff --check` |
| Skill or agent prompt text, sync transforms, sync/content scripts, or non-packed tests | `npm run typecheck`, `npm run sync:check`, `npm run check:content`, `npm run test:fast`, and `git diff --check` |
| Runtime, packaging, packed-Pi tests, or test-runner changes | `npm run check` and `git diff --check` |

Use the strongest gate for mixed changes. Markdown is not automatically docs-only: skill and agent prompts are product inputs. Changes to frontmatter that affect discovery, tools, or model selection belong in the full-check row.

Run the full check when a change affects any of:

- `extensions/subagent/**` or `extensions/pstack/**` runtime behavior
- packed tests under `tests/pi/**`, their shared harness, or test orchestration such as `scripts/run-tests.mjs`
- dependencies, the supported Pi/Node versions, pack membership, package exposure, or profile isolation
- timeouts, parallelism, the depth guard, `pi` resolution on `PATH`, or parent signal handling
- live progress, card, or usage reporting through real Pi

Use `npm run test:pi` for focused iteration on those paths. A passing full check need not run again after a prose-only follow-up; run the docs-only checks on the final tree instead. Do not reuse a previous result after changing code, package metadata, or executable test inputs.

Packed-Pi timeouts caused by other local sessions loading the machine are not product bugs. Re-run `test:pi` alone on a quiet machine before chasing a flake.

## Runtime

Local measurements on macOS with Node 24.19.0 and Pi 0.85.1:

| Suite | Wall time | Main cost |
| --- | --- | --- |
| `test:fast` | about 10s, down from 30s | Concurrent non-packed files |
| `npm test` | about 51s, down from 105s | Includes all packed real-Pi scenarios |
| `test:subagent` | about 8s, down from 17s | One real 3s SIGKILL grace test and shutdown coverage |
| `test:sync` | about 8s, down from 11s | Real Git and filesystem cases; parsers use plain objects |
| `test:pi:unit` | about 3s | Provider, JSONL, package preparation, isolation, and cleanup cases |

These are observations, not timeout limits. CPU load and cold starts affect them. Subagent progress uses ready/release signals rather than sleeps. The timeout test advances a fake clock only after real children are ready. Batch abort uses a short injected grace; production defaults stay unchanged.

## What each suite proves

`check:content` validates exact pack membership, YAML frontmatter, dependency closure, local links, file modes, explicit package exposure, and the dry-run pack inventory.

`test:content` rejects duplicate YAML keys, unresolved dependencies, Cursor-only mechanics, undeclared agents, and unexpected runtime registration. Its fidelity tests protect reviewed upstream passages and Pi boundaries, reject full-file replacements, and preserve Interrogate's unchanged sections exactly. They keep genuine protocol identifiers such as review author `cursor` and `CURSOR_AUTOMATION_ID`.

`test:sync` replays every transform against the pinned snapshot and verifies all copied bytes.

`test:pstack` drives the `pstack` extension against a fake ExtensionAPI: tool and command registration, lifecycle hooks, the todo reducer, and the absence of a blanket command gate.

`test:subagent` drives the `subagent` tool with a fake `pi` that speaks the JSON protocol: routing precedence and pool rotation, stdin task and `0600` prompt delivery, parallel order and concurrency, chain substitution, abort and timeout killing a `SIGTERM`-ignoring grandchild, and shutdown. Renderer tests cover narrow terminals, long chains, output expansion, and both inspector views.

`test:pi` packs the package, moves it into an isolated profile, and runs real Pi `0.85.1` against a loopback provider with no credentials. It checks discovery of all 47 commands, exact expansion of three sampled skills, arguments, relocated paths, and the declared extension tools. A scripted parent delegates a fixture read to a real bundled child, receives the result, and runs harmless bash containing literal `git push` and `gh pr edit` text. Other runs hide project agents by default, run a user override in a subdirectory `cwd`, and let `poteto-agent` edit through its tool set. Child requests carry the agent's tools plus `pstack_todo`, never `subagent`. The child leads its own process group, and prompt temp files are gone after return. Execution-safety tests cover `timeoutMs`, two simultaneous single calls, eight parallel tasks with a four-child ceiling and one failing sibling, depth rejection, a fake `pi` in `PATH`, and parent `SIGTERM` and `SIGHUP` cleanup. Progress tests check live tools, child-owned todos, model and usage before completion, saved snapshots, and timeout cards. Duplicate-name diagnostics go through Pi's resource-loader SDK because print-mode JSONL does not emit those warnings. `tests/pi/README.md` lists the harness files and bounds.

The packed-Pi files run serially in one process with `--experimental-test-isolation=none`. They share one validated production tarball and resolved Pi executable, but each run gets a fresh extraction, profile, provider, and process group. Custom fixture packages always pack again. Smoke tests check package listing and SDK resource discovery; other scenarios exercise the loaded package through real Pi without repeating those checks.

Individual tests still run concurrent children. The main delegation tests keep a copy of the tarball and `run.json` under the artifact paths printed in test output. Other test profiles are removed. The suite removes its shared pack at teardown. Running one packed test file directly still works; reuse then lasts only for that process.

These checks prove content loading and real tool execution, not model compliance with the skill instructions.
