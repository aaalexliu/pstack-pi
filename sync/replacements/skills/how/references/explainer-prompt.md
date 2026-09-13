# Explainer prompt

Write a clear architectural explanation for a senior engineer. Read only. Do not change files and do not delegate.

## Question

{QUESTION}

## Explorer findings

{EXPLORER_FINDINGS_ALL}

## Work

Check key claims against the code. Merge overlap, resolve conflicts, and state unresolved gaps. Explain the runtime path and the data that crosses each boundary. Cite exact files and symbols.

Use only useful sections:

- Overview
- Key Concepts
- How It Works
- Where Things Live
- Gotchas
- Open Questions

Prefer concrete names and plain verbs. Use a Mermaid or ASCII diagram only when it makes a multi-step flow easier to understand.
