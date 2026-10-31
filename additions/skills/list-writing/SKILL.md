---
name: list-writing
description: Write any list or breakdown so a reader can compare its items at a glance. Covers bullet lists, numbered steps, table rows, findings, options, cards, sibling headings, and titles for sessions, PRs, commits, and tickets. Use whenever you write or review two or more items of the same kind.
---

# List writing

People read a list fast only when its items are predictable and consistent. Write the set, not each item alone. These rules come from [Agent text at scale](https://fsdatalab.github.io/blog/agent-text-at-scale/), which grounds each one in reading research.

They apply to any output that breaks a problem or a topic into parts: bullets in a reply, steps in a plan, rows in a table, findings in a review, options in a comparison, cards on a dashboard, headings at one level, and titles in a feed.

## Steps

1. Pick the template before you write: the parts each item has, their order, the shared subject, and the tense.
2. Write the items.
3. Read only the first two words of each item, top to bottom. Each item should stand apart from the others, and all should share one form.
4. Look at every way the items differ: length, parts, detail, formatting, and order. Remove each difference that does not mean something.

## Rules

1. **Start with the subject or the verb.** Readers take the first noun as the actor and the next verb as its action. "Login bug fixed by the agent" reads as if the bug fixed something, until "by" forces a second pass. When every item shares a subject, drop it and start with the verb. Use the tense the reader expects: past for done work, the -ing form for work in progress, and the future for plans. Items that are only names, such as table row labels, skip this rule. Rule 3 still applies to them.
2. **Put the words that tell items apart first.** Readers often see only the first two words of each item. Write "Shipped: order #1001", not "Your order #1001 has shipped". In a breakdown, lead each item with its finding, not with "Another issue is that".
3. **Use one template and one word per concept.** Every item has the same parts in the same order and the same grammatical form. If one item says "issue", no item calls the same thing a "page".
4. **Vary only what means something.** Readers assume any difference carries meaning. If only one card names an app version, readers infer that only that version has the bug. Give every item the same fields, or move the extra detail below the list or into the item's own page. Order counts too. Sort by something that matters, such as severity or time, and say which. Show a key number, such as reviews per theme, in the same place on every item or as a chart.
5. **Match the verb's tone to the purpose.** A list of complaints says "Users complain that". A list of praise says "Users love". A reader should tell good news from bad by the verb alone. A card that opens with "Chess is a popular new draw" and then lists complaints breaks this rule.

## Other writing skills

- **technical-writing** governs running prose, including its advice to vary sentence length. Inside a list, keep one form.
- **unslop** applies to the item text after these rules, with one exception. An item may drop its shared subject and start with an -ing verb, despite unslop rule 33 and the technical-writing advice against -ing words. Keep articles.

## Examples

Session titles, before:

- KV persistence
- Switching to main
- Fine-tune model on personal writing

After. The agent is the subject of every session, so the titles drop it. Every session is in progress, so every verb takes the -ing form.

- Persisting the KV cache
- Switching to main
- Fine-tuning the model on personal writing

A breakdown of a bug, before:

- The main issue is that the cache is never invalidated after a write.
- Retry logic: the client retries 5 times with no backoff, which overloads the API (seen in production on Oct 12).
- Also worth noting the timeout is too low.

After. Each item names the part, a verb that says what goes wrong, and the cause. The production sighting moves below the list, next to the evidence for the other two items.

- The cache serves stale reads after a write, because nothing invalidates it.
- Retries overload the API, because the client retries 5 times with no backoff.
- The timeout cuts off slow calls, because the limit is too low.
