### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main. Subagents inherit it. Multiple leaf tasks on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable. Commit bodies don't restate the subject.

**PRs.** Inspect the diff for slop before commit and run `/skill:no-comments` before review. Write every PR title, description, and commit body with `/skill:technical-writing` (every layer except Diátaxis, and apply the STE vocabulary rules: one word per action, keep articles, a plain verb over `-ing` where one works), then apply `/skill:unslop`.

**Titles.** Area, colon, then a plain sentence, no trailing period, for example `Lead prompt: ask before posting on a repo you do not own`. The area is the part of the repo the change lives in. Do not use Conventional Commits.

**Descriptions.** The PR body is a one-minute briefing, not a lab notebook, for a reviewer who has the diff. It says why the change exists, what it leaves out, what it could break, and how you proved it works. Write short, simple sentences with few identifiers, no walls of text. The body becomes the squash commit body, so keep that commit under about 40 lines. Use `##` headings, not bold lead-ins, in this order, and drop a section with nothing to say:

- `## Why`: impact first. Say who or what was hurt and how, then the cause, in 1–3 short sentences. The first sentence is the TL;DR. No SHAs, rebase genealogy, or "based on main" preamble.
- `## What changed`: break the change down the way `/skill:show-me` would: a small diagram, call tree, pseudocode, or before/after diff, plus 1–3 short bullets. Explain each new rule, check, or term in plain words, named as the code names it, with a concrete case it guards against and the test that proves it. Name both sides of a rename or retarget.
- `## Scope`: 1–3 short items on what it covers and what it deliberately leaves out (a follow-up, a known gap). Add what it could break and why that is safe, and any rejected alternative a reviewer would ask about. If main is red, state the cost of leaving it red. No symbols, paths, or file-by-file essay.
- `## Verification`: paste short real proof, under about 10 lines: the command and what it printed. Link anything longer. Perf: one primary number with its unit, `before → after`, and a link for the rest. No metric tables.

After the sections, attach videos or screenshots when they prove a claim. Full SHAs, swarm or arena lane recitals, lever-correction essays, file-by-file checklists, and "CLEAN" verdicts go in a linked artifact, not the body.

**Forge.** Resolve the forge before the first PR operation and keep that choice for create, edit, view, watch, and merge. GitHub CLI (`gh`) is the default. If `command -v origin` succeeds and Origin can resolve the repository, prefer `origin pr ...`. If Origin is absent or cannot resolve the repository, stay on `gh` and record the fallback. Do not require Graphite (`gt`).

**Built-in PR tool.** When the run provides a built-in PR tool, create, edit, retarget, and mark ready through it, never through a forge CLI. A CLI-made PR misses what the tool tracks. Use the resolved forge for everything the tool does not cover, and for every PR operation when the run has no such tool.

**Size and stacks.** Prefer five narrow PRs to one large PR. A stack is a base-branch chain. The root PR targets trunk. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. As a parent merges, move its child onto trunk per step 4 of the local Shipping gates in `../SKILL.md`. Without a built-in PR tool, per the resolved forge, create a child with `origin pr create --status open --base <parent-branch>` or `gh pr create --base <parent-branch>`, and retarget one with `origin pr edit <pr> --base <parent-branch>` or `gh pr edit <pr> --base <parent-branch>`. Branch from trunk only for independent work. Rebase on trunk before substantial stack work.

**Readiness.** Open every PR ready, never as a draft. A built-in PR tool can default to draft, so set `draft: false` on every creation call through it. With Origin, pass `--status open`. With `gh`, omit `--draft`. If a PR still opens as a draft, mark it ready through the PR tool, or run `origin pr ready <number>` or `gh pr ready <number>` according to the resolved forge. Run `origin pr view <number>` or `gh pr view <number>` before you refer to PR status.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits later waves restart. Push back when feedback drifts from intent.

A leaf task that opens a PR runs a diff inspection for slop and `/skill:no-comments`, and posts the URL. It returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner under a parent-owned local fallback. That owner's brief assigns the babysit loop and is the ask the local Babysit gates wait for. The owner starts the loop after its code-ready report, reports merge-ready, and is exempt from the rules here and in the local Babysit gates that hold babysitting until a whole stack is built.
