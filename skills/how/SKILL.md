---
name: how
description: Use for "how does X work", code walkthroughs, and ownership or layering questions. Explains subsystem architecture, runtime flow, and where code belongs.
disable-model-invocation: true
---

# How

Explore the codebase and give a senior engineer a working model of the named subsystem.

## Choose the path

- For one function or module, run one `general-purpose` subagent with role `how-explainer`.
- For a flow that crosses files or services, split it into two to four independent angles and run one parallel `tasks` request with role `how-explorer`. Then run one `general-purpose` subagent with role `how-explainer` to combine the findings.
- If delegation is unavailable, follow the same steps in the parent session.

Use `references/explorer-prompt.md` for exploration tasks and `references/explainer-prompt.md` for the final explanation. Point tasks at these files instead of pasting them when the child can read the package path.

## Rules

1. State your interpretation when the scope is unclear, then proceed.
2. Trace from an entry point through calls and data changes. Do not infer behavior from names.
3. Read type definitions and boundaries, not only the main function.
4. Cite exact file paths and symbols. Add line numbers when they help the reader find a small region.
5. Name gaps instead of guessing.
6. Use a diagram only when it makes a multi-step flow easier to follow.
7. Present one coherent explanation. Review child findings against the code before using them.

## Output

Use only the sections that help: Overview, Key Concepts, How It Works, Where Things Live, Gotchas, and Open Questions.
