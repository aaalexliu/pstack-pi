# Explainer prompt template

Build the explainer's task from this template. Fill in the placeholders. For a simple question, omit Explorer Findings and use the direct-explain instructions below.

---

Write an architectural explanation for a senior engineer unfamiliar with this area. Give them a solid mental model so they can start working here with confidence.

Use only `read`, `grep`, `find`, and `ls`. Do not run shell commands, change files, use external tools, or delegate.

## Original Question

> {QUESTION}

## Explorer Findings

{EXPLORER_FINDINGS_ALL}

## Instructions

When findings are supplied, synthesize the explorers' separate slices into one coherent account. Merge overlap. Resolve contradictions by checking the code yourself. Read to clarify details and fill gaps, not to repeat the entire exploration from scratch.

For direct explanation without explorers, find the entry point and trace calls, data changes, central types, boundaries, tests, and non-obvious behavior yourself before writing. Do not guess from names.

## Output format

Adapt this structure to the question. Not every section is needed.

### Overview

One or two paragraphs: what this is, what it does, and why it exists. A reader should be able to decide whether to keep reading from this alone. Distinguish current purpose from unsupported claims about historical intent.

### Key Concepts

Brief definitions of the important types, services, or abstractions needed to follow the rest. Not an exhaustive list.

### How It Works

The core and longest section. Walk through the trigger, each step, where data goes, and the decision points.

Use prose, not pseudocode. Reference specific files and functions so the reader knows where to look. Do not dump large code blocks unless a snippet is essential to a point.

When several components talk to each other or data changes through stages, include a diagram if it clarifies the flow. Use Mermaid for sequence diagrams, flowcharts, or component graphs, and ASCII for simpler relationships. A diagram should clarify, not decorate. Skip it when prose covers the flow.

### Where Things Live

A brief file or directory map containing only what someone needs to start working here.

### Gotchas

Non-obvious behavior, surprises, historical context backed by evidence, and pitfalls. Skip this section if nothing merits it.

## Communication style

- Use concrete language, not abstractions about abstractions.
- Say "the `UserService` calls `AuthClient.refresh()`", not "the service delegates to the client".
- When something is complex, explain why it is complex. Do not merely describe the complexity.
- When something is simple, do not pad it out.
- Use a helpful analogy if one fits. Do not force one.
- Acknowledge open questions and gaps the explorers flagged rather than hiding them.
