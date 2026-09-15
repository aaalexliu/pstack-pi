---
name: create-verification-skill
description: "Generate a project-local Pi verification skill that drives the real app like a user, on any language, framework, or platform. Use for create-verification-skill, make a control skill for this repo, or when UI/CLI/service behavior has no repeatable proof path."
disable-model-invocation: true
---

# Create a verification skill

Write `.pi/skills/verify-<app>/` for the next agent to read cold, mid-task. The core output is a verification skill plus an indexed feature map. The parent owns authoring, launch, live driving, evidence, cleanup, and any permitted external access. Do not assume browser, desktop, or mobile control tools exist in Pi.

## 1. Interview the repo, not the user

Answer from code and docs before asking:

- **Surface:** web, CLI/TUI, desktop, API, mobile, or library. Pick the primary user surface and note the others.
- **Run:** prefer documented repository commands. Record ports, environment, seed data, and auth.
- **Drive:** use existing Playwright/Cypress tests, expect/PTY helpers, HTTP endpoints, or debug ports first. Then choose an available browser/CDP, tmux/PTY, or HTTP harness. A library's public API is its user surface.
- **Observe:** screenshots, terminal transcripts, response bodies, logs, exit codes, and stored state.
- **Isolate:** separate ports, data directories, and profiles. If safe parallel instances are impossible, say so and refuse to double-drive shared state.

If the checkout does not build or start, fix it within authorized scope or report the exact blocker before generating. Do not teach steps against a broken base. An irrelevant missing asset may be created as clearly labeled verification scaffolding, with removal in cleanup.

## 2. Generate the skill

Write `SKILL.md` with `name: verify-<app>` and a description naming the app, surface, and trigger. Use valid YAML and these sections with exact repo-grounded commands, no placeholders:

- **Launch:** startup command, readiness predicate, and teardown. For a short-lived CLI/TUI, build or install once, then start each drive in its own isolated PTY or tmux session rather than keeping a fake server alive.
- **Doctor:** one read-only check for process health, expected version/build, owned port, and valid auth. Run before first drive and whenever anything looks off. On fresh per-drive sessions, run it each time. After a failed or surprising drive, doctor again; if the process looks healthy but UI state is wedged, reset to a known state or relaunch rather than hoping.
- **Drive:** real selectors and commands. Prefer ARIA labels, data attributes, prompt strings, and routes over coordinates or tab order.
- **Evidence:** name a proof directory outside scratch cleanup. Exercise the real user path, not internal setters or test-only endpoints. Capture the action and resulting state, not just a final screen. Check side effects such as files, rows, and messages alongside visible output. Use mocks only at an existing production boundary. Observe what a dry-run or test mode actually skips through files, network, and Git refs; its name is not proof and it may still use the network or open a browser.
- **Cleanup:** tear down only owned instances and scratch state. Never kill by process name; kill what this run started. For shared instances, remove owned residue, not the instance. Preserve proof artifacts at their named location and check that they survive every cleanup, including failed attempts.
- **Helpers:** make shipped scripts executable and document their invocation in the skill body. Do not make the next agent reverse-engineer them.

If required drive tools are unavailable, report the gap and mark the skill a draft until its real path can run. The parent must obtain approval for external or irreversible actions under host policy; child readers cannot perform them.

## 3. Seed the feature map

Create `features/README.md` and one file per user-facing feature, starting with the top 3-5 from routes, commands, menus, or docs. Read the complete shape in [the feature-map example](references/feature-map-example/README.md), including the README and feature files. Replace example app details with observed facts.

Each file starts with an H1 and user-visible summary, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. Include prerequisites, every user entry point, exact action/command/result pairs, and observable pass states. Keep implementation detail out of the map. The index and feature files are the maintained verification source: one convenient entry point does not prove the other listed paths. Record feature ID and entry point on artifacts, and report skipped routes with the attempt and unmet prerequisite instead of calling them verified.

## 4. Prove the generated instructions

Run the skill end to end once: launch, doctor, drive ONE mapped feature through the real surface, capture action/result and side-effect proof, then clean up. One feature is enough for generation; report what remains untested. Confirm proof files still exist at the named location after cleanup.

Fix failures, run cleanup after every failed iteration, and repeat until the instructions work. Do not strand processes or ports. Evidence erased by cleanup fails this step. An unexecuted skill is a draft, not a deliverable.

## 5. Offer maintenance

Report generated paths, the feature and entry points exercised, commands, results, evidence, cleanup, and limits. Point to `/skill:maintain-verification-skill` for later upkeep. Suggest a cadence only if asked.
