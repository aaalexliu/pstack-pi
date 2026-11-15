---
name: create-verification-skill
description: "Generate a project-local verification command (`.agents/verify`) and skill that drive your app the way a user does — any language, framework, or platform. Use for /skill:create-verification-skill, \"make a control skill for this repo\", or when a project has no scripted way to prove UI/CLI/service behavior."
disable-model-invocation: true
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as an executable `.agents/verify` command and a short project-local skill (`.pi/skills/verify-<app>/`), both tailored to the repo. A person runs the command from a terminal and an agent runs it the same way, so the steps live in code, not in prose an agent follows by hand. Write the skill for the next agent: it will be read cold, mid-task, by an agent that has never seen the app. It points at the command and holds the judgment the command cannot, such as what counts as proof.

The parent owns authoring, live driving, evidence, cleanup, and external services under caller authorization and host policy. Pi does not supply browser, desktop, or mobile control by default. Use a real-surface harness that a shell command can call, because `.agents/verify` calls it; a tool only an agent can call cannot drive the command. Missing access blocks proof and leaves a draft, not a verified deliverable. Any child reader stays read-only and does not delegate, drive the app, or access external services. Read the installed Pi `docs/skills.md` before authoring.

## 1. Interview the repo, not the user

Answer these from the codebase and only ask the user what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI/TUI, a desktop app, an API, a mobile app, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive:** how can a script drive it from a shell? Existing harnesses first — Playwright/Cypress specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then pick a generic recipe: browser/CDP for web and Electron, a tmux/PTY harness for CLI/TUI, plain HTTP for services.
- **Observe:** what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, fix that first (or report it precisely) before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), `launch` may create it, clearly marked as verification scaffolding, and `cleanup` removes it.

## 2. Generate the command and the skill

Write `.agents/verify`, an executable that runs from a plain terminal with no agent tools and never prompts. Use the repo's own scripting language, or POSIX sh. If the repo already has `.agents/verify`, extend it: its no-argument run keeps every check it already makes. Give it these parts, each grounded in what the interview actually found (no placeholders left):

- **`launch`:** starts the app for verification and waits until it's ready (a log line, a prompt). Launch must reach a usable state from an empty data dir, including any migrations and seed data. Ready means usable, not just that a process answers. A database health check can pass while its init scripts are still running. Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **`doctor`:** one read-only check that answers "is this instance worth driving?" — process up, right version/build, port owned by us, auth valid. Run it first whenever anything looks off.
- **`drive <feature>`:** runs the harness recipe for one feature in the map (section 3), with real selectors/commands from this repo, not examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence:** each drive captures its proof in one evidence directory and prints that path. The skill states the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not just the final screen; verify side effects (files written, rows inserted, messages sent) alongside what's visible; mocks only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **`cleanup`:** tears down instances the run created. Never kill by process name; kill what you started. Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in the directory the command prints.
- **No arguments:** runs the whole proof: `launch`, `doctor`, `drive` for every mapped feature, then `cleanup`, which also runs when a step fails. It prints one line per step that says PASS, FAIL, or SKIP, then the evidence directory, and exits non-zero if any step failed. A feature that needs something outside the repo (an account, an OS, external state) prints SKIP with that prerequisite, never PASS. This is the contract a job runner calls before review.
- **Helpers:** `.agents/verify --help` lists every subcommand, and any helper script it calls is executable. A helper the reader has to reverse-engineer is not a helper.

Then write `.pi/skills/verify-<app>/SKILL.md` with YAML frontmatter (`name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it; without frontmatter the skill never registers). Keep it short. Point at `.agents/verify` and its subcommands instead of repeating their steps, then give what the command cannot decide: the proof standards above, which evidence a person or agent must still look at before calling a feature proven, and whether two instances can run side by side. A step that lives only in the skill's prose is a step the command is missing.

## 3. Seed the feature map

Create `.pi/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can identify (aim for the top 3-5 to start, from routes, commands, menus, or docs). Follow the shape in [the feature-map example](references/feature-map-example/README.md), with a README index and one file per feature. Each file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. The four H2s are `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. The file name without `.md` is its `drive` argument, and the recipe under `Driving it with <harness>` describes what `.agents/verify drive <feature>` does, so a change to one changes the other. If the seed data lacks a precondition that a journey needs, the journey reports a failure and the reason goes in that feature's `Gotchas`. Never weaken the journey to make it pass. The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated command before handing it over

Run `.agents/verify` with no arguments once from a plain terminal, the way a person would: it launches, runs doctor, drives every mapped feature, captures evidence, and cleans up. Its output must say which steps passed and where the evidence is; keep that output for the handoff. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails in the command, the skill, or the map, and run `.agents/verify cleanup` after every failed iteration too, so broken attempts don't strand processes and ports. A generated command that never ran end to end is a draft, not a deliverable. When the app itself fails a journey, leave its code alone: keep that step FAIL and name it in the handoff. Only a checkout that does not build or start gets fixed first, per section 1. If you proved it in a stand-in for the real target (a container in place of a fresh VM, a local stack in place of a remote one), list every setup step the stand-in did that the target will not. Those steps stay unverified until a run on the real target covers them.

## 5. Offer the maintenance loop

Point the user at `/skill:maintain-verification-skill` for keeping the map honest as the app changes. Suggest a cadence only if they ask.
