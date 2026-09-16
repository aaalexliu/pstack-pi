# Subagent depth blockers

## What leaf-only means

A leaf agent does its assigned work without spawning another agent. Today, only the main session coordinates subagents. This is a pstack policy, not a fundamental Pi limit.

Counting the main session as depth 0:

```text
Current:
main (0) -> worker (1)

Proposed depth 2:
main (0) -> coordinator (1) -> worker (2)
```

Depth 2 would let a delegated implementation agent ask for a focused investigation or review without making the main session coordinate every step.

## Blockers to enabling depth 2

### Runtime guard

`extensions/subagent/index.ts` skips registering `subagent` when `PSTACK_SUBAGENT_DEPTH >= 1`.

Allow registration at depth 1, but not depth 2. Grandchildren must remain leaves. Keep depth 1 as the default and make the extra level an explicit choice.

### Tool allowlists

Bundled agents have explicit tool lists that omit `subagent`. Changing the depth guard alone would not give those agents the tool.

Grant delegation only to agents meant to coordinate. Research workers need not become coordinators. A descendant's permissions must not exceed the permissions granted to its parent.

### Agent and skill instructions

Agent prompts and adapted skills forbid delegation or assume leaf workers. Those instructions must match the new runtime contract.

Update the source inputs in `sync/manifest.json` or `sync/additions/`, as appropriate, then regenerate. Do not edit generated `agents/` or `skills/` files by hand.

## Blockers to reliable depth 2

### Whole-tree cancellation

This is the main engineering blocker.

Each spawned agent owns a detached process group. A grandchild would start another group, so killing the direct child's group would not necessarily kill the grandchild.

Graceful shutdown may cascade through each agent's child registry. Forced termination cannot rely on that. Root cancellation and timeout must reach every descendant, even if a coordinator crashes or cannot run cleanup.

The runtime needs whole-tree lifecycle tracking and cleanup, not just a higher depth limit.

### Shared execution limits

Local limits multiply when agents can delegate. If eight children each spawn eight workers, one wave can create 72 descendants: eight children and 64 grandchildren.

A depth limit bounds the tree's height, not its total work. Add:

- A shared concurrency budget across the tree.
- A total-spawn budget for the request.
- An inherited deadline, rather than a fresh full timeout for each nested task.

Budget enforcement must also account for retries and sequential delegation.

## Related requirements

### Progress and usage

Show nested workers, failures, and progress so a coordinator does not appear stalled while its children run. Verify that token and cost totals count each call once.

### Write ownership

Descendants must stay within their coordinator's assigned files or worktree. Delegation must not create competing owners of the same files.

### Tests

Prove these behaviors before enabling depth 2:

- A depth-1 coordinator can delegate to a depth-2 worker.
- A depth-2 worker cannot delegate again.
- Descendants cannot expand their granted permissions.
- Shared concurrency, spawn budgets, and deadlines hold across branches.
- Abort and timeout clean up every descendant.
- Coordinator crashes and forced termination leave no orphan workers.
- Nested progress remains visible and usage is counted once.

## Tradeoffs and recommendation

Depth 2 makes coordinator workflows easier to compose and reduces the main session's coordination load. It also adds briefing and summary steps, increases latency, can lose evidence between layers, and makes failures harder to observe.

Keep root-managed parallel workers for ordinary research and review. Allow depth 2 explicitly for tasks that benefit from a coordinator, once whole-tree cancellation and shared budgets exist.

Enabling depth 2 requires guard, allowlist, and instruction changes. Making it reliable requires lifecycle and budget controls. It is not a one-line change.
