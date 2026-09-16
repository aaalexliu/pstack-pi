# Real Pi test controls

`npm run test:pi` runs the harness tests, then Pi 0.85.1 against a bounded loopback provider. The runner packs the real package once per packed suite, checks its tar inventory and bytes, and extracts it into a fresh isolated profile for each test. Custom fixture packages always pack again.

## Files

- `runner.mjs` shares a validated production tarball and Pi executable lookup, writes a fresh isolated profile, starts a fixture provider, spawns one real root Pi in its own process group, parses its JSONL, and verifies exit, request counts, and group cleanup. Smoke tests opt into package listing and SDK resource discovery; custom fixtures scan by default.
- `provider.mjs` is a sequential scripted OpenAI-compatible provider. Each request consumes the next step in order. It rejects overlapping requests after a short grace for a just-closed client socket.
- `concurrent-provider.mjs` routes by the exact final user message, so several children can talk to it at once. Parallel and simultaneous delegation tests use it.
- `process-observer.mjs` and `production-observer.mjs` read `ps` snapshots to count live Pi processes and confirm that every child under the root is gone before the test rescues anything.
- `unit.test.mjs` covers revision, JSONL, provider bounds, missing executables, test-file classification, pack reuse, fresh extracts, and failed-setup cleanup. `provider.test.mjs` and `concurrent-provider.test.mjs` test the loopback providers. `npm run test:pi:unit` runs these three files without launching Pi. `npm run test:fast` includes them.
- `smoke.test.mjs` proves package loading, three sampled skill expansions (`bro`, `poteto-mode`, one principle), and the declared tool surface. `todo.test.mjs` proves persisted todos.
- `delegate.test.mjs` proves a real parent delegating to real bundled, user, and poteto children, with exact child tool lists and no leftover prompt files.
- `progress.test.mjs` proves live model, tool, checklist and usage metadata, persisted final snapshots, and timeout cards through packed Pi. Renderer tests under `tests/subagent/` cover scrolling, raw status, long chains, overlap, and reload. The demo script exercises the real terminal views.
- `execution-safety.test.mjs` proves the depth guard, `timeoutMs`, simultaneous calls, eight parallel tasks with a four-child ceiling, fake `pi` in `PATH`, and parent `SIGTERM` and `SIGHUP` cleanup.

Packed test files run serially in one process via `--experimental-test-isolation=none --test-concurrency=1`. This shares preparation without sharing test profiles. Non-packed files retain process isolation. Individual packed tests still run concurrent children. Explicit child tool lists include the agent's tools plus `pstack_todo`, never `subagent`.

The runner deletes its shared pack at suite teardown and on normal process exit. Retained runs get their own tarball copy alongside `run.json`. A direct `node --test tests/pi/smoke.test.mjs` invocation prepares its own pack and cleans it up. New `tests/pi/*.test.mjs` files default to packed tests; add only non-Pi harness files to `PI_UNIT_TESTS` in `scripts/run-tests.mjs`.

## Bounds

| Evidence or operation | Limit |
| --- | --- |
| Root watchdog | 20 seconds after spawn by default |
| Process polling | 100 ms interval, 1 second per `ps`, 1.5 seconds between polls |
| Process samples | 512 |
| Process table | 16,384 rows, 8 MiB per poll |
| Live Pi processes | 2 by default; 3 for simultaneous calls; 5 for eight parallel tasks |
| Provider script | 16 steps maximum |
| Provider request | 256 KiB |
| Retained provider requests | 16 requests, 1 MiB total, memory only |
| Provider reply | 32 KiB |
| Awaited provider check | 1 second |
| Provider request timeout | 5 seconds to receive the request, not the stalled response |
| Root stdout and stderr | 1 MiB each, 65,536-character diagnostic tail |
| JSONL | 256 events per process, 64 KiB per line, 1 MiB per stream |
| Root close wait and group cleanup wait | 2 seconds each |

The observer accepts macOS and Linux `ps` output. These tests were verified on macOS only. Windows has no claimed cleanup coverage.
