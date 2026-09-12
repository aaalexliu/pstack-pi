# Real Pi test controls

`npm run test:pi` runs Pi 0.85.1 against a bounded loopback provider. The runner packs the real package, checks its tar inventory and bytes, and loads the extracted package in an isolated profile.

## Recursion positive control

`recursion.test.mjs` tests the observer and watchdog, not a flaw in the shipped delegate. The production delegate remains leaf-only. No production flag enables recursion.

The runner has two launch choices. `packed` loads the extracted package. `recursion-control` loads only `fixtures/unsafe-recursion.mjs` with `--no-extensions -e <fixture>`. The fixture registers `subagent` only when explicit test configuration and a matching run nonce exist. It imports no production runtime. Each execution spawns one real Pi without a shell and awaits its exit. Every child loads the same fixture. There is no depth policy in this fixture.

The root Pi has depth zero. Depth four means one live chain of five Pi processes with four PPID edges. Four real `subagent` executions create those edges. Request counts, prompts, environment variables, and model text do not establish depth.

The provider sends four delegation calls. Request five asks the deepest child to use the built-in `read` tool on a generated marker file. Request six verifies that tool result and stalls. All five Pi processes must remain live until the 15-second watchdog kills the root-owned process group. Only a `PiTestError` whose sole cause is `PiWatchdogTimeout` passes, after the test has checked the read and process evidence.

`ProcessObserver` reads PID, PPID, PGID, process state, start time, and command from OS `ps` snapshots. It samples every 100 ms and at all six provider boundaries, plus the watchdog boundary. It matches the resolved Node executable and installed Pi CLI invocation exactly. Pi later changes its process title to `pi`. That title counts only for an identity whose original invocation the observer already saw. Missing that evidence fails the test. Start times from `ps lstart` have one-second resolution.

The control rejects observer errors, missed polling bounds, overlapping polls, truncation, sequential siblings, a sixth Pi, provider errors, malformed JSONL, early refusal, and a missing read. Child JSONL confirms each tool execution independently of the OS chain.

After the watchdog, the runner checks the full process table and probes every recorded PID. All recorded identities, group members, and descendants must be gone. The provider must be closed. The runner removes the temporary profile, marker, and child output. It never creates child prompt files.

The test retains one compact `observation.json` in an OS temporary directory and prints its path. This artifact contains process evidence, tool-event summaries, cleanup results, and the pack inventory. It contains no provider request bodies or raw prompts beyond the fixed CLI invocation. Both npm's file list and the real tar inventory must exclude all `tests/` files.

## Bounds

| Evidence or operation | Limit |
| --- | --- |
| Root watchdog | 15 seconds after spawn |
| Process polling | 100 ms interval, 1 second per `ps`, 1.5 seconds between polls |
| Process samples | 512 |
| Process table | 16,384 rows, 8 MiB per poll |
| Owned identities and rows per sample | 32 |
| Owned command | 4 KiB |
| Live Pi processes in the control | 5 |
| Observer errors | 16 entries, 1,024 characters each |
| Provider script | 16 steps maximum, exactly 6 in the control |
| Provider request | 256 KiB |
| Retained provider requests | 16 requests, 1 MiB total, memory only |
| Provider reply | 32 KiB |
| Awaited provider check | 1 second |
| Provider request timeout | 5 seconds to receive the request, not the stalled response |
| Provider errors | 16 entries, 4,096 characters each |
| Root stdout and stderr | 1 MiB each, 65,536-character diagnostic tail |
| JSONL | 256 events per process, 64 KiB per line, 1 MiB per stream |
| Child stdout and stderr | 64 KiB each; overflow fails rather than passing truncated evidence |
| Child error record | One extra entry, 1,024 characters |
| Test configuration | 4,096 characters, plus a 32-digit hexadecimal nonce |
| Root close wait and group cleanup wait | 2 seconds each |
| Retained JSON artifact | 256 KiB |

## Phase 7 reuse

Phase 7 can reuse `ProcessObserver`, the runner's observer and stopped-verification hooks, and the bounded watchdog with the packed production launch. Keep this unsafe control unchanged as the positive control. Compare production depth and cancellation results against OS evidence, not model claims.

The observer accepts macOS and Linux `ps` output. This change was verified on macOS only. Windows and other operating systems have no claimed cleanup coverage.
