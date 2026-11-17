---
name: intake
description: File a ticket for an agent to build, so the agent starts from the right reading. Use whenever you file or delegate a Linear ticket that an agent runner will work on, or when the user asks you to hand work to an agent.
---

# Intake

A ticket that an agent builds starts while the person who asked is still here. A few short headings, written now, stop most of the surprises that show up after the build. The agent does not need more than this, and the person should not need to read more than this.

## Steps

1. Restate the goal in your own words, not the user's. Show it to them before you file. A misreading costs one line now and a whole build later. Run the check under "Check the ask against what is decided" and show its objections with the goal.
2. Write the ticket with these headings, in this order:

   ```markdown
   ## Goal
   What the work is for, in your own words. One to three sentences.

   ## Reference
   An existing product, screen, file or past ticket it should feel like. Link it.

   ## Not doing
   What is out of scope, so the agent does not build it.

   ## Done when
   The evidence that proves it works: a command and its expected output,
   a screenshot of the real app, or an artifact.
   ```

   `Done when` is required when the result is judged by eye or changes what a user sees, and optional otherwise. Name the evidence itself, not a wish: "`npm test` prints `pass 12`", or "a screenshot of the settings page in the running app shows the new toggle", not "it works". If you cannot name the evidence, the work is not scoped yet: ask the user before you file.

3. Add the label that names the repo, if the runner picks repos by label. If the runner config has no repo for that label, the runner drops the ticket, so map the label to its repo in the config yourself and restart the runner before you delegate. Do not stop to ask. Add `Needs: screen` on its own line when the work drives the Mac's screen, a browser, or a simulator.
4. Set the ticket's state to `Todo` and delegate it to the runner's app user in the same step. The runner picks up only `Todo` tickets delegated to it. Do not assign it to the person; an assignee means it is their move.
5. Tell the user the ticket link and the goal line you wrote.

## Check the ask against what is decided

People reverse their own rules without noticing, and a session that has been talking with them tends to agree. So the check runs in a separate session with fresh context, such as a subagent. Give it only three things: the ask as you restated it, the project's design record (its principles, its decision log, and its list of what was tried and dropped; the repo's agent instructions name it when one exists), and the titles of the open tickets. Do not give it this conversation.

Ask it for at most three objections, one line each, each with a link to the line or ticket it rests on:

- The ask breaks a principle or reverses a logged decision.
- The ask brings back something that was tried and dropped.
- The ask overlaps or conflicts with an open ticket.

When the work is costly to undo, ask it one more question: what must be true for this to be the right thing to build, and what is the cheapest way to test that?

An objection with no link does not count. With no objection, say nothing about the check. Otherwise the person answers each one with "amend" or "drop". Amend means the rule changes: add a line to the decision log, or write under Goal that the agent must. Drop means the ask changes or goes.

The check never holds a ticket back. If the person is not there to answer, file the ticket with a `Conflict:` line under Goal for each objection, and follow their newest instruction. If you cannot start a separate session, run the check yourself and say that you did. A project with no design record gets only the open-ticket check.

## Rules

- Ask the user only for what you cannot fill yourself. If they gave no reference, ask once; if they have none, write "None".
- Keep each heading short. A long ticket hides the goal.
- Do not leave calls that are costly to undo for the agent, such as a data model, a public API, a migration, money, or anything outside the Mac. Ask the person now, while they are here, and write the answer under Goal. If they cannot answer yet, do not file the ticket.
- Do not build the work yourself in the session that files it.
