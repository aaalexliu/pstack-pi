---
name: maintain-verification-skill
description: "Keep a project's verification skill and feature map honest through source review and live feature coverage. Use for maintain-verification-skill or audit the verify skill; ship at most one set of proven corrections."
disable-model-invocation: true
---

# Maintain a verification skill

The unit of coverage is the feature, not every sentence. Cover every feature file from source and exercise every feature live without turning every bullet into a separate task.

## Outcome and edit scope

Return exactly one outcome:

- **clean:** every feature got source and live coverage, with nothing worth shipping. No branch or PR.
- **changed:** proven skill, harness, or map corrections are ready in one focused change; when authorized, ship at most one PR.
- **blocked:** coverage could not finish or a proven fix could not ship safely. Name the blocker.

Edit only the verification skill's directory: `SKILL.md`, `features/`, and helpers it owns. Never edit product code. Decide whether changed behavior is doc drift or a product regression; report broken product behavior rather than hiding it by rewriting the map.

## Pass

0. **Locate.** Find the project-local skill with launch/drive sections and a feature map, usually `.pi/skills/verify-*/`. Several candidates: ask which. None: stop and point at `/skill:create-verification-skill`, rather than inventing a target.

1. **Index hygiene.** Read `features/README.md` and list sibling files. Fix missing, extra, duplicate, and dead entries. Keep this lightweight; no generated inventory.

2. **Source wave.** Use `subagent` with one read-only `general-purpose` task per feature, explicit paths, and a finite `timeoutMs`. Batch at most eight leaf children in one live request at a time. Each returns `feature summary / source entry points / likely drift or none / one live recipe`, with citations. Children use only `read`, `grep`, `find`, and `ls`; they do not drive, edit, access external systems, or delegate. The parent owns writes, external access, and all live driving. If delegation is unavailable, do the same source pass locally and disclose it.

3. **Reconcile.** Require a summary for every feature. Merge overlapping recipes into as few app states as practical. Spot-check cited drift, not every clean source claim. Sweep recent churn for missing user surfaces; require a concrete source path before calling one missing.

4. **Live pass.** Required even when source looks clean. Follow the target skill's Launch model: one long-lived server/UI instance driven serially, or a fresh isolated session per short-lived CLI drive. Exercise every feature at least once, tracking entry points without claiming an untried route passed. Hold these invariants through every failure:

   - Doctor before first drive, on each fresh per-drive session, and after any failed or surprising drive. Never drive an instance not health-checked since its last surprise. If doctor cannot see a wedged UI, reset to a known state or relaunch.
   - Preserve all captured action/result and side-effect evidence through every cleanup. Check it at the named paths, do not assume it survived.
   - Nothing started by a drive outlives its usefulness. Clean failed-attempt residue whether the instance is stuck, exited, or shared. Clean residue on shared instances, not the instance itself. Never kill by process name.

   A doctor failure due to skill drift is drift: fix it within scope and retry once before calling the pass blocked. Restart only what the fix invalidated. Use `verified-unreachable` only with the concrete prerequisite (auth, entitlement, OS, or external state) and route attempted. A missing prerequisite in the map is drift. This label records a proven access limit, not successful feature behavior; coverage that cannot finish remains blocked.

5. **Triage and re-prove.** Wrong or missing user-facing descriptions are doc drift. Working behavior that the harness cannot drive is a harness gap. Fix both within the skill directory. Helpers must be executable and their invocation documented. Re-drive every harness fix and changed recipe live before it ships. Broken app behavior is a product gap: report it outside this change, never paper over it in docs. Follow the skill's real-path proof rules, not internal setters, final-screen-only claims, or assumed dry-run safety.

6. **Teardown and handoff.** Final teardown follows the last drive, including re-proofs. Remove owned resources, retain evidence, and verify it remains. Re-read every changed file. Ship at most one PR only under caller authorization and host policy; otherwise report the local patch and pending handoff. Clean and blocked outcomes create no PR.

Keep concise run notes in scratch, not Git: source/live coverage by feature and entry point, unreachable prerequisites and attempts, drift, product gaps, commands/results, evidence paths, cleanup, changes, and outcome. Report partial coverage honestly.
