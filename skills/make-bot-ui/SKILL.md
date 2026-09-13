---
name: make-bot-ui
description: Design a clear visual identity and interface for a bot or agent product. Use for bot avatars, chat surfaces, agent dashboards, or bot-facing UI direction.
disable-model-invocation: true
---

# Make bot UI

Create a coherent bot identity and prove it in the real interface.

1. Gather product purpose, audience, brand constraints, existing UI tokens, and target surfaces from repository files and supplied assets.
2. Build two or three distinct directions. For each, specify shape language, color, typography, motion, avatar treatment, chat states, and accessibility constraints.
3. Use available image or web tools only when they exist. Do not assume Cursor image generation or external design plugins. If no image tool exists, produce SVG, HTML, CSS, or a precise asset brief in the repository's own stack.
4. Compare directions in one runnable prototype or contact sheet. Include normal, loading, error, empty, long-content, and narrow-width states.
5. Recommend one direction with concrete tradeoffs. Obtain a product preference only when runnable evidence cannot choose.
6. Implement through `/skill:poteto-mode` after direction approval. Drive the real surface, capture screenshots, check contrast and keyboard behavior, and compare against the chosen direction.

Return alternatives, recommendation, artifact paths, screenshots, and unresolved product choices.
