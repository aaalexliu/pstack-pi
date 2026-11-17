# Testing

## Scripts

| Script | Use |
| --- | --- |
| `npm run test:fast` | Day-to-day iteration |
| `npm test` or `npm run test:full` | Full suite, the same one `npm run check` and CI run |
| `npm run test:pi` | Pi harness tests and packed real-Pi tests |
| `npm run test:pi:unit` | Pi harness tests without launching Pi |

`test:fast` runs the sync, content, pstack, subagent, profiles, title, recap, media, interactive-subagents, and Pi harness test files in one Node test invocation. Files keep separate processes and run concurrently. It skips packed real-Pi tests. `npm test` runs that same set, then the packed tests without repeating the harness tests.

`scripts/run-tests.mjs` discovers test files. New files under `tests/pi/` default to the packed suite unless listed in `PI_UNIT_TESTS`. It also runs the interactive-subagents subtree's files listed in `SUBTREE_TESTS`. It drops `PI_SUBAGENT_*` and `PI_DENY_TOOLS` from the test environment, so tests run from inside a subagent still see a root Pi.

`npm run check` runs `typecheck`, `sync:check`, `check:content`, and `npm test` in that order. CI runs the same command in the checkout and in a clean Git archive with no `.git` directory. A second CI job, `runner`, runs `node --test runner/*.test.ts` on Node 24; `npm run check` does not run those tests.

## Choose local checks by change

Use this table before committing or pushing. A docs-only push does not require `npm test` or `npm run check` locally. CI still runs the full suite in both environments.

| Change | Required local checks |
| --- | --- |
| Docs-only prose in guides, `AGENTS.md`, or test documentation | `npm run sync:check`, `npm run check:content`, and `git diff --check` |
| Skill or agent prompt text, sync transforms, sync/content scripts, or non-packed tests | `npm run typecheck`, `npm run sync:check`, `npm run check:content`, `npm run test:fast`, and `git diff --check` |
| Runtime, packaging, packed-Pi tests, or test-runner changes | `npm run check` and `git diff --check` |

Use the strongest gate for mixed changes. Markdown is not automatically docs-only: skill and agent prompts are product inputs. Changes to frontmatter that affect discovery, tools, or model selection belong in the full-check row.

Run the full check when a change affects any of:

- `extensions/subagent/**`, `extensions/interactive-subagents/**`, or `extensions/pstack/**` runtime behavior
- packed tests under `tests/pi/**`, their shared harness, or test orchestration such as `scripts/run-tests.mjs`
- dependencies, the supported Pi/Node versions, pack membership, package exposure, or profile isolation
- timeouts, parallelism, the spawning rule, `pi` resolution on `PATH`, or parent signal handling
- live progress, card, or usage reporting through real Pi

Use `npm run test:pi` for focused iteration on those paths. A passing full check need not run again after a prose-only follow-up; run the docs-only checks on the final tree instead. Do not reuse a previous result after changing code, package metadata, or executable test inputs.

Packed-Pi timeouts caused by other local sessions loading the machine are not product bugs. Re-run `test:pi` alone on a quiet machine before chasing a flake.

## Runtime

Local measurements on macOS with Node 24.19.0 and Pi 1.5.2:

| Suite | Wall time | Main cost |
| --- | --- | --- |
| `test:fast` | about 10s | Concurrent non-packed files |
| `npm test` | about 56s | Includes all packed real-Pi scenarios |
| `npm run check` | about 59s | `npm test` plus typecheck, sync and content checks |
| `test:subagent` | about 2s | Agent parsing, model routing, todos, and mode state |
| `test:sync` | about 8s | Real Git and filesystem cases; parsers use plain objects |
| `test:pi:unit` | about 3s | Provider, JSONL, package preparation, isolation, and cleanup cases |

These are observations, not timeout limits. CPU load and cold starts affect them.

## What each suite proves

`check:content` validates exact pack membership, YAML frontmatter, dependency closure, local links, file modes, explicit package exposure, and the dry-run pack inventory.

`test:content` rejects duplicate YAML keys, unresolved dependencies, Cursor-only mechanics, undeclared agents, and unexpected runtime registration. Its fidelity tests protect reviewed upstream passages and Pi boundaries, reject full-file replacements, and preserve Interrogate's unchanged sections exactly. They keep genuine protocol identifiers such as review author `cursor` and `CURSOR_AUTOMATION_ID`.

`test:sync` replays every transform against the pinned snapshot and verifies all copied bytes.

`test:pstack` drives the `pstack` extension against a fake ExtensionAPI: tool and command registration, lifecycle hooks, the todo reducer, and the absence of a blanket command gate.

`test:subagent` covers bundled agent parsing, model routing precedence and pool rotation, todos, Poteto Mode state, and `/pstack`.

`extensions/interactive-subagents/test/test.ts` is upstream's unit suite plus the ported fork changes: cmux and tmux placement, the agents workspace and its cleanup, force-close, the concurrency cap and queue, pane-gone detection, settings and their last-good fallback, agent discovery including pstack-pi's agents, and the spawning deny list. `test/pstack.test.ts` loads the extension as a root and as a child and checks which tools each gets, and drives `subagent` with `wait: true` against `test/fake-pi.mjs` with no multiplexer: the result and its model and session lines, `timeoutMs` killing the process group, a failing child, abort, two calls side by side, and a headless non-wait child. Both import `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, and `@sinclair/typebox`, which Pi aliases at runtime; devDependencies alias them to the pinned `@earendil-works` packages and `typebox`. Upstream's integration tests need a live multiplexer and model and do not run.

`tests/profiles` checks the auth profiles extension against fake credential stores: folder and inherited profile selection, the launch profile read once per process, logins and refreshes landing in the right file, and store restore on shutdown. `tests/profiles/e2e/run.sh` is a manual check against real Pi 1.x and a loopback Anthropic stand-in with fake keys; CI does not run it.

`tests/title` checks the session title extension against a fake Pi and model: the first prompt names the session, follow-ups keep the name and new tasks replace it, a `/name` wins, a resumed session keeps renaming, a newer prompt cancels an older request, the Haiku and session-model choice, failures, reply parsing, and the terminal title with no `π - ` prefix and a spinner while the agent works.

`tests/recap` checks the recap extension against a fake Pi, model, and clock: one recap three minutes after a run settles, cancellation by typing, `!` commands, a new run, or typing during the request, no repeat without new conversation, `/recap`, the TUI-only and Pi-version guards, the warning on failure, the renderer, and the transcript and reply cleanup.

`tests/media` checks cited images, videos, and PDFs in reply order against a fake Pi. It covers fenced code, path resolution, skipped files, deduplication, snapshot bytes after a source changes, repeat settles, prompt guidance, and image-capable and text-only renderers. Real loopback HTTP tests cover the token, Host check, HEAD, Range, feed order, conditional polling, and page headers. Fake cmux tests cover pane reuse, reopening, remote denial, branch rebuilds, resume, shutdown, and header links. The full check does not inspect the page in cmux or test its remote proxy.

`test:pi` packs the package, moves it into an isolated profile, and runs real Pi `1.5.2` against a loopback provider with no credentials. It checks discovery of the shipped skill commands, exact expansion of three sampled skills, arguments, relocated paths, and the declared extension tools. A scripted parent calls `subagent` with `wait: true` to have a real headless bundled child read a fixture, receives the result with its model and session lines, and runs harmless bash containing literal `git push` and `gh pr edit` text. Other runs use a user override in a subdirectory `cwd`, give a child with host default tools no delegation tools, and let `poteto-agent` edit through its tool set. Child requests carry the agent's tools plus `pstack_todo`, `caller_ping`, and `subagent_done`, never `subagent`. The child leads its own process group. Execution-safety tests cover `timeoutMs`, two simultaneous single calls, eight separate calls in one message with a four-child ceiling and one failing sibling, depth rejection, a fake `pi` in `PATH`, and parent `SIGTERM` and `SIGHUP` cleanup. Duplicate-name diagnostics go through Pi's resource-loader SDK because print-mode JSONL does not emit those warnings. `tests/pi/README.md` lists the harness files and bounds.

The packed-Pi files run serially in one process with `--experimental-test-isolation=none`. They share one validated production tarball and resolved Pi executable, but each run gets a fresh extraction, profile, provider, and process group. Custom fixture packages always pack again. Smoke tests check package listing and SDK resource discovery; other scenarios exercise the loaded package through real Pi without repeating those checks.

Individual tests still run concurrent children. The main delegation tests keep a copy of the tarball and `run.json` under the artifact paths printed in test output. Other test profiles are removed. The suite removes its shared pack at teardown. Running one packed test file directly still works; reuse then lasts only for that process.

These checks prove content loading and real tool execution, not model compliance with the skill instructions.
