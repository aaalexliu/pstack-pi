### Opening a PR

Invoked at the end of every other playbook.

Work from a git worktree off trunk, and keep unrelated work out of it. Rebase into small, landable commits. Inspect the diff for slop before commit and run `/skill:no-comments` before review.

Title: `Area: subject`, with a plain sentence and no trailing period, naming a real symbol when one carries the change. Do not use Conventional Commits. Body: a one-minute briefing under 40 lines with these `##` headings in order: `## Why`, `## What changed`, `## Scope`, `## Verification`. Start Why with who or what was hurt and how. Show What changed with a small diagram, call tree, pseudocode, or before/after diff and a concrete case and test for each new rule. Scope names what the change leaves out, the risk, and rejected alternatives when relevant. Paste short real proof in Verification (command and outcome, under about 10 lines); link longer output. Drop an empty section except Scope.

Stack follow-ups by base branch. Open PRs ready with `gh pr create` without `--draft`, or `origin pr create --status open` when Origin's CLI resolves the repository. Opening a PR does not start a babysit.
