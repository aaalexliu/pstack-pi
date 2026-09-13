---
name: create-verification-skill
description: Create a project-local Pi skill that launches and drives the real app, captures proof, and cleans up owned resources. Use when a project lacks a repeatable user-level verification path.
disable-model-invocation: true
---

# Create a verification skill

Build `.pi/skills/verify-<app>/` for the next agent to use cold.

1. Interview the repository. Find the primary user surface, launch command, readiness signal, existing driver, observable evidence, isolation controls, and cleanup path. Ask only what code and docs cannot reveal.
2. Write `SKILL.md` with valid frontmatter and exact Launch, Doctor, Drive, Evidence, Cleanup, and Helpers sections. Use stable selectors and commands from this repository. Never kill by process name.
3. Create `features/README.md` and one file for each main user feature. Use `references/feature-map-example/README.md` as the shape. Each feature names the user route, driver steps, observable pass state, and gotchas.
4. Run the generated skill once end to end. Launch, run Doctor, drive one mapped feature through the real surface, save evidence, clean up, and confirm the evidence remains.
5. Fix failed instructions and rerun cleanup after every failed attempt. A skill that has not driven the app is a draft.
6. Point the user to `/skill:maintain-verification-skill` for later audits.

Do not add test-only endpoints when the real surface is available. State when auth, shared state, or platform limits prevent safe parallel runs.
