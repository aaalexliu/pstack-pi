# Testing

## Scripts

| Script | Use |
| --- | --- |
| `npm run test:fast` | Day-to-day iteration |
| `npm test` or `npm run test:full` | Full suite, the same one `npm run check` and CI run |
| `npm run test:pi` | Packed real-Pi suite only |
| `npm run test:pi:unit` | Sub-second Pi fixtures only |

`test:fast` runs `test:sync`, `test:content`, `test:pstack`, `test:subagent`, and `test:pi:unit`. It skips the packed real-Pi tests.

`npm run check` runs `typecheck`, `sync:check`, `check:content`, and `npm test` in that order. CI runs the same command in the checkout and in a clean Git archive with no `.git` directory.

## When to run the packed real-Pi suite

Run `npm run test:pi` (or `npm test`) when you change any of:

- `extensions/subagent/**` or `extensions/pstack/**` runtime behavior
- `tests/pi/**` other than the unit fixtures
- package packing, profile isolation, or process-group cleanup
- timeouts, parallelism, the depth guard, `pi` resolution on `PATH`, or parent signal handling
- live progress, card, or usage reporting through real Pi

Skill text, sync transforms, and docs-only edits can stay on `test:fast` plus the focused suite they touch (`test:content`, `test:sync`). Still run `npm run check` once before merging or releasing.

Packed-Pi timeouts caused by other local sessions loading the machine are not product bugs. Re-run `test:pi` alone on a quiet machine before chasing a flake.

## Why `test:fast` takes about 30 seconds

Most of the time is not Pi:

| Suite | Wall time | Why |
| --- | --- | --- |
| `test:subagent` | about 17s | Intentional waits for timeouts, abort, and process-group teardown |
| `test:sync` | about 10s | Many filesystem sync and check fixtures |
| `test:pi:unit` | about 1s | Provider, JSONL, and missing-executable fixtures |
| `test:content`, `test:pstack` | 1s to 2s | Unit coverage |

## What each suite proves

`check:content` validates exact pack membership, YAML frontmatter, dependency closure, local links, file modes, explicit package exposure, and the dry-run pack inventory.

`test:content` rejects duplicate YAML keys, unresolved dependencies, Cursor-only mechanics, undeclared agents, and unexpected runtime registration. Its fidelity tests protect reviewed upstream passages and Pi boundaries, reject full-file replacements, and preserve Interrogate's unchanged sections exactly. They keep genuine protocol identifiers such as review author `cursor` and `CURSOR_AUTOMATION_ID`.

`test:sync` replays every transform against the pinned snapshot and verifies all copied bytes.

`test:pstack` drives the `pstack` extension against a fake ExtensionAPI: tool and command registration, lifecycle hooks, the todo reducer, and the absence of a blanket command gate.

`test:subagent` drives the `subagent` tool with a fake `pi` that speaks the JSON protocol: routing precedence and pool rotation, stdin task and `0600` prompt delivery, parallel order and concurrency, chain substitution, abort and timeout killing a `SIGTERM`-ignoring grandchild, and shutdown. Renderer tests cover narrow terminals, long chains, output expansion, and both inspector views.

`test:pi` packs the package, moves it into an isolated profile, and runs real Pi `0.85.1` against a loopback provider with no credentials. It checks discovery of all 47 commands, exact expansion of three sampled skills, arguments, relocated paths, and the declared extension tools. A scripted parent delegates a fixture read to a real bundled child, receives the result, and runs harmless bash containing literal `git push` and `gh pr edit` text. Other runs hide project agents by default, run a user override in a subdirectory `cwd`, and let `poteto-agent` edit through its tool set. Child requests carry the agent's tools plus `pstack_todo`, never `subagent`. The child leads its own process group, and prompt temp files are gone after return. Execution-safety tests cover `timeoutMs`, two simultaneous single calls, eight parallel tasks with a four-child ceiling and one failing sibling, depth rejection, a fake `pi` in `PATH`, and parent `SIGTERM` and `SIGHUP` cleanup. Progress tests check live tools, child-owned todos, model and usage before completion, saved snapshots, and timeout cards. Duplicate-name diagnostics go through Pi's resource-loader SDK because print-mode JSONL does not emit those warnings. `tests/pi/README.md` lists the harness files and bounds.

The packed-Pi files run serially to avoid startup contention against short watchdogs. Individual tests still run concurrent children. The main delegation tests keep their tarballs and `run.json` under the artifact paths printed in test output. Other test profiles are removed.

These checks prove content loading and real tool execution, not model compliance with the skill instructions.
