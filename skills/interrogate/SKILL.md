---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Multiple LLM reviewers challenge changes from independent angles."
disable-model-invocation: true
---

# Interrogate

Spawn one reviewer per configured model to adversarially review code changes. Each model gets the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas.

The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1, Determine Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset
- If the user's message references recent work, gather the relevant files

Package the diff (or file contents) plus any surrounding context files the reviewers need to understand the code.

## Step 2, State the Intent

Before spawning reviewers, state the intent explicitly. Derive this from:

- The user's message
- Commit messages
- PR description if one exists
- The code itself

Write one clear paragraph. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Read `pstack_config` with action `get`. Use the `interrogate-reviewer` role's configured model pool, one reviewer per entry. A single model assignment means one reviewer. Without a configured role, use one `inherit-parent` reviewer and disclose that model diversity is unavailable; offer `setup-pstack` rather than inventing defaults or calling repeated samples different models.

Launch reviewers with Pi's `subagent` tool using a `tasks` array. Use one request for up to eight reviewers; process larger configured pools in successive batches without dropping entries. Extend or shrink Reviewer A/B/C/D labels to match the pool. For each task set:

- `agent`: `general-purpose`
- `role`: `interrogate-reviewer`
- `model`: the exact configured entry, including `inherit-parent`. Explicit selection keeps panel membership independent of the role router's current rotation.
- `task`: the same filled reviewer template, plus a read-only, no-delegation boundary.

The bundled reviewer can read, search, and list local files, but cannot run shell commands, write, use external tools, or delegate. The parent gathers the diff and external context before launching. Model diversity supplies the adversarial signal; do not substitute assigned personas or different prompts.

If a model is unavailable, use `pstack_config` with action `list-models` to inspect valid exact selectors. Report the failed slot and ask before changing the configured panel. Continue with available reviewers without claiming complete coverage; do not silently substitute a model or edit configuration. If delegation is unavailable, do one local review and label it as a local fallback, not an independent panel.

Read `references/reviewer-prompt.md` and fill in the template with:
1. The stated intent
2. The diff or file contents and surrounding context
3. The review rubric from `references/rubric.md`
4. The code-quality lens from `references/code-quality-review.md`

The same filled template goes to all reviewers, so every model applies the code-quality lens. Record each reviewer's requested selector and whether it completed, failed, or returned no findings. Report a resolved model identity only when the tool result exposes it; otherwise label inherited or unresolved identities as unknown, not a guessed model name. Repeated or inherited model choices do not count as distinct model families.

## Step 4, Synthesize

As results come back, build a unified picture:

1. **Parse all findings** from the reviewers. Verify each claim against the code and reachable call paths; include exact files and lines. State any test or evidence gaps. Model agreement is a signal, not proof.
2. **Identify consensus**. Findings raised by 2+ models independently are highest signal.
3. **Identify lone-model findings**. Still worth reading, but weight accordingly.
4. **Deduplicate**. Different models may describe the same issue differently. Merge these and note which models raised it.
5. **Note disagreements**. If one model flags something and another explicitly says the opposite, that's useful context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator.

Read `references/lead-judgment.md` for the full framework.

Categorize every finding using these buckets:

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. These would block a real PR.
- **Consider**. Legitimate points, but you're not sure they outweigh the cost of addressing them right now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact given the current stage.
- **Dismissed**. Wrong, nitpicky, or missing context. Brief explanation why.

For each finding, include:
- Which model(s) raised it
- The category (act on / consider / noted / dismissed)
- A one-line rationale for the categorization

## Output Format

Present the verdict in this structure:

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [model name], [N findings] (one bullet per reviewer)

### Act On
[Findings that should be addressed. For each: description, which models raised it, why it matters.]

### Consider
[Findings worth thinking about. For each: description, which models raised it, tradeoff involved.]

### Noted
[Valid but low-priority. Brief list.]

### Dismissed
[Rejected findings with brief rationale.]

### Agreement Map
[Where did models agree, where did they diverge, and what does the pattern of agreement/disagreement tell us?]
