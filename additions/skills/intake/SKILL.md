---
name: intake
description: File a ticket for an agent to build, so the agent starts from the right reading. Use whenever you file or delegate a Linear ticket that an agent runner will work on, or when the user asks you to hand work to an agent.
---

# Intake

A ticket that an agent builds starts while the person who asked is still here. Three short headings, written now, stop most of the surprises that show up after the build. The agent does not need more than this, and the person should not need to read more than this.

## Steps

1. Restate the goal in your own words, not the user's. Show it to them before you file. A misreading costs one line now and a whole build later.
2. Write the ticket with these headings, in this order:

   ```markdown
   ## Goal
   What the work is for, in your own words. One to three sentences.

   ## Reference
   An existing product, screen, file or past ticket it should feel like. Link it.

   ## Not doing
   What is out of scope, so the agent does not build it.

   ## Done when
   Optional. Checks a person could run on the finished thing.
   ```

3. Add the label that names the repo, if the runner picks repos by label. Add `Needs: screen` on its own line when the work drives the Mac's screen, a browser, or a simulator.
4. Delegate the ticket to the runner's app user in the same step. Do not assign it to the person; an assignee means it is their move.
5. Tell the user the ticket link and the goal line you wrote.

## Rules

- Ask the user only for what you cannot fill yourself. If they gave no reference, ask once; if they have none, write "None".
- Keep each heading short. A long ticket hides the goal.
- Do not decide calls that are costly to undo, such as a data model, a public API, a migration, money, or anything outside the Mac. Name them under Goal as open, and the agent will ask.
- Do not build the work yourself in the session that files it.
