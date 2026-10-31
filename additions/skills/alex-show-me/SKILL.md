---
name: alex-show-me
description: "Explain the current topic visually with concise diagrams, code-shape sketches, and focused HTML artifacts. For a bug, lead with matched 'What happened' and 'What should happen' views and put the detail below. Use for /skill:alex-show-me."
disable-model-invocation: true
---

Help the user understand the current topic of conversation visually. Skip the preamble and keep prose brief. Pick the smallest view that makes the key point clear.

- Show logic or an algorithm as pseudocode:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
  return fresh result
```

- Show runtime control flow as a call tree:

```text
submitForm
  createSession
    persistPrompt
    launchAgent
  navigateToSession
```

- Show UI structure as a component tree, including state and module boundaries that matter:

```tsx
<SessionPage> (apps/example/src/routes/session.tsx)
  useSessionEvents()
  <SessionToolbar>
    <RunSkillButton> (packages/ui)
```

- Show file responsibility or a broad refactor as a shallow file tree:

```text
src/
├── commands/       # parses user actions
├── sessions/       # owns session state
└── transport/      # sends API requests
```

- Show component interaction, control flow, or data flow with Mermaid:

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant Daemon
    User->>UI: choose command
    UI->>Daemon: send expanded prompt
    Daemon-->>UI: stream result
```

- Use `diff` when the point is what changes and the surrounding shape already exists. Match the diff shape to the topic.

For a component change:

```diff
 <SessionPage>
   useSessionEvents()
   <SessionToolbar>
+    <RunSkillButton />
   <SessionTimeline>
+    <SkillResultCard />
```

For a file-layout change:

```diff
 src/
 ├── commands/
+│   └── show-me.ts       # expands the slash command
 ├── sessions/
-└── transport.ts
+└── transport/
+    ├── client.ts
+    └── stream.ts
```

For a call-tree or call-stack change:

```diff
 submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
-  navigateToSession
+  navigateToSession
+    subscribeToEvents
```

For a state or control-flow change:

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write new content
+  invalidate cache
```

- Show the whole block when most of it is new, when omitted context would hide ownership or order, or when the user needs a copyable target shape:

```ts
function expandSkill(command: string): string {
  const skillName = command.slice(1)
  return `use the ${skillName} skill`
}
```

- For a visual UI, layout, state comparison, or concept too dense for Mermaid, write one focused HTML file: a diagram, an infographic, or a short slide deck, whichever fits the point. Match the product's colors, type, spacing, and components; use real labels and data; support desktop and mobile. Then open it for the user:

```
Bash(open path/to/show-me-{description}.html)
```

### guidance

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to answer the user's current question or the options to resolve the current discussion point.

Write box labels, card text, legends, and any list in a view with the **list-writing** skill.

For a diagram of rules, when many inputs feed one rule, draw a set with an "any" or "none" rule instead of one edge per input. Group outputs only when their rules and results match.

You may use one of these, you may use several, it is unlikely you will use all of them. Use your judgement and don't overwhelm the user.

### Showing a bug

Use this when the point is the gap between how something behaves and how it should.

- Lead with two views side by side, "What happened" and "What should happen". Use the same example and the same layout, so the only visible change is the bug.
- In each view, draw the input that starts the example, the step where the two views split, and the result the user sees. Leave out anything that looks the same in both views and isn't needed to follow the split. It goes below.
- Give each box a short name the user would recognize, such as a button label or a form section title. Put code names in small text. Full question text and option lists go below.
- Below the views, explain each concept, show the rule or code that decides, list evidence and sources, and put raw source last, collapsed if the format allows.
- Say where each fact comes from: production, a local copy, a fixture, a replay, or a repro. Never present a worked example as a fact about an incident.
- Keep the user's first framing. Later requests for detail go below the views.
- When you hand off a brief, mark which parts the user asked for and which you chose.
