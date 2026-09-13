---
name: maintain-verification-skill
description: Audit a project verification skill and feature map against source and the live app. Use to refresh or repair an existing verify-* skill.
disable-model-invocation: true
---

# Maintain a verification skill

Return one outcome: clean, changed, or blocked.

1. Find the project-local `.pi/skills/verify-*/` skill. Ask which one only when several match. If none exists, use `/skill:create-verification-skill`.
2. Check its feature index for missing, duplicate, extra, and dead entries.
3. Run one read-only `general-purpose` task per feature, up to eight per request. Each traces source, cites likely drift, and returns one live recipe. Children do not drive or edit.
4. Reconcile results and spot-check every drift claim. Sweep recent source changes for user-facing features absent from the map.
5. Follow the verification skill's own launch and Doctor steps. Drive every feature. Recheck health after surprising behavior, preserve evidence, and remove only resources this run created.
6. Fix only the verification skill, feature map, and owned helpers. Report product defects instead of changing product code.
7. Re-drive every changed instruction. For a changed outcome, make at most one focused commit or PR when asked. Clean and blocked outcomes create no PR.

Report feature coverage, unreachable prerequisites, confirmed drift, product gaps, changed files, evidence paths, and outcome.
