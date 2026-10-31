# Agent guidance

This repository packages Lauren Tan's Cursor pstack for Pi. Read this file before editing anything. Each rule below names the doc that explains it.

## Layout

| Path | Role | Edit it? |
| --- | --- | --- |
| `vendor/cursor-pstack/` | Pinned upstream snapshot | Never. Move the pin with `SYNCING.md`. |
| `sync/manifest.json` | Classifies every upstream file as `copy`, `transform`, or `omit` | Yes. This is where skill edits live. |
| `sync/upstream.lock.json` | Source blobs and generated hashes | Only through `npm run sync:relock`. |
| `skills/`, `agents/` | Generated from the snapshot, manifest, and lock | Never by hand. Run `npm run sync`. |
| `additions/` | Pi-owned agents and skills with no upstream counterpart. They ship as written. | Yes. Sync never reads or writes it. |
| `extensions/pstack/`, `extensions/subagent/` | Pi extensions: todo, config, sessions, papercuts, delegation | Yes. |
| `scripts/` | Sync, content checks, demo | Yes. |
| `tests/` | Content, sync, extension, and packed real-Pi tests | Yes. |

## Rules

1. To change a skill, edit its transform in `sync/manifest.json`, update its row in `ADAPTATIONS.md`, then run `npm run sync:relock && npm run sync`. Never edit `skills/` or `agents/` directly. `SYNCING.md` has the full procedure.
2. To add or change a Pi-owned skill or agent, edit it under `additions/` and list each file in `package.json`. It needs no manifest entry, lock hash, or sync run.
3. Keep transforms narrow. Change the host-specific clause, not the file. A full rewrite disguised as one large transform fails review. `ADAPTATIONS.md` explains why.
4. When you add or remove a shipped file, update `files` in `package.json`, `expectedPackFiles` in `scripts/check-content.mjs`, and the pack count in `tests/pi/smoke.test.mjs`. `npm run check:content` and `npm run test:pi` fail if they disagree.
5. Match local checks to the change using `TESTING.md`. Docs-only prose needs `sync:check`, `check:content`, and `git diff --check`, not `npm test`. Run `test:fast` for skill text, sync, and other non-runtime changes. Runtime, packaging, and test-runner changes need `npm run check`. Mixed changes use the strongest gate. CI still runs the full suite.
6. The release is a pushed commit on `main`. No npm publish, no tags, no GitHub releases without an explicit request. `RELEASING.md` has the gate.
7. Docs use plain dashes, straight quotes, and sentence-case headings. No em dashes.

## Docs

| File | Answers |
| --- | --- |
| `README.md` | What the package does and how to install and use it |
| `SYNCING.md` | How to regenerate, change a transform, or move the upstream pin |
| `ADAPTATIONS.md` | Which upstream files change, and why |
| `TESTING.md` | Which test script to run, and what each suite proves |
| `RELEASING.md` | The release gate and install-by-commit procedure |
| `tests/pi/README.md` | The packed real-Pi harness and its bounds |
