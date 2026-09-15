---
name: show-me-your-work
description: "Keep a reviewable TSV decision trail for long-running, unattended, or multi-phase work: what, why, evidence, and result. Local by default; commit only when a reviewer needs the trail to trust the result."
disable-model-invocation: true
---

# Show me your work

Keep one canonical decision log. This skill owns its format; other workflows reference it instead of inventing or restating another schema. The parent owns appends and evidence checks. Review children only read.

## Format

Copy `references/decision-log-template.tsv`, or create its exact tab-separated header:

```tsv
ts	phase	decision	why	evidence	result
```

One row is one decision or checkpoint. Six single-line cells, in exactly that order:

- **ts:** ISO8601 timestamp, preferably UTC such as `2026-05-24T09:02:00Z`.
- **phase:** phase or workstream.
- **decision:** what was chosen or done, one line.
- **why:** plain reason, including any principle in plain words rather than a jargon tag.
- **evidence:** resolvable link or pointer, not prose: commit SHA, PR number, `file:line`, artifact, log, trace, or screenshot path.
- **result:** observed outcome or predicate state, for example `tests green`, `reverted`, `pixel-diff 0`, `INCONCLUSIVE`, or `open`.

Use `/skill:unslop` for row text. Write as you would tell a teammate what happened. Do not copy illustrative decisions into a real log.

## Append safely

The upstream log.sh helper is not shipped in this Pi package. Do not assume it exists. Use a manual equivalent with the same contract: create parent directories and the exact header on first use, stamp UTC ISO time, replace tabs/newlines/CR in every cell with spaces, and prefix any cell beginning with `=`, `+`, `-`, or `@` with a single quote. Apply this to generated text as well as user-supplied values to prevent spreadsheet formula execution.

With an available Python 3 interpreter, the parent may use this inline equivalent. Replace the six shell arguments with the real log path and row values; never leave placeholders in a real trail:

```sh
python3 - decisions.tsv phase decision why evidence result <<'PY'
import datetime
import pathlib
import sys

if len(sys.argv) != 7:
    raise SystemExit('usage: <logfile> <phase> <decision> <why> <evidence> <result>')
log = pathlib.Path(sys.argv[1])
header = 'ts\tphase\tdecision\twhy\tevidence\tresult\n'
log.parent.mkdir(parents=True, exist_ok=True)
if log.exists():
    with log.open(encoding='utf-8', newline='') as source:
        if source.readline() != header:
            raise SystemExit('unexpected TSV header; do not mix schemas')
else:
    with log.open('x', encoding='utf-8', newline='') as target:
        target.write(header)

def clean(value):
    value = value.translate(str.maketrans({'\t': ' ', '\n': ' ', '\r': ' '}))
    return "'" + value if value.startswith(('=', '+', '-', '@')) else value

stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
with log.open('a', encoding='utf-8', newline='') as target:
    target.write('\t'.join(map(clean, [stamp, *sys.argv[2:]])) + '\n')
PY
```

If Python is unavailable, use another local tool with exactly those byte rules and verify the header and six-cell shape before appending. Only the parent appends, so parallel children cannot race on the file.

Log forks chosen, units completed with verification, pivots and reverts with their triggers, blockers, and gates fixed. For loop runs, write one row per iteration. Skip trivial commands and self-evident actions. Prefer evidence produced by committed scripts over hand-made one-offs; `/skill:principle-encode-lessons-in-structure` applies.

## Location and corrections

Use `decisions.tsv` in the work directory, or `.audit/<task-slug>.tsv` for concurrent efforts. Keep it local and out of Git by default. Commit only when the work is ambitious enough that reviewers need the trail, and only under the caller's Git authorization.

Append-only: supersede wrong calls in new rows. Never edit or delete history. If audit finds invented, aspirational, or padded rows, append explicit retractions identifying them and marking their claims invalid; do not preserve them as evidence or rewrite the story. Append missing decisions with the true known event time or state that the entry is retrospective.

## Audit against the run

Before handoff, read this run's `$PI_SESSION_FILE`, confirming its session header/workspace and opening user message. If the path is absent, use `pstack_sessions` to find the matching current-project session, never another project's directory. Follow Pi `id`/`parentId` ancestry to distinguish branches; check actual tool calls/results, not just summaries. If only a digest is available, report that limitation.

Walk every row against the transcript:

- Did the action actually happen, rather than remain planned?
- Does each evidence pointer resolve and prove the claim?
- Are forks, pivots, and abandoned approaches that shaped the result missing? Add them with their triggers.
- Is any padding or false outcome still presented as proof? Retract it with a correction row.

Fix the log's claims, not the story of the work. Retain original evidence; do not invent success to fit a row.

## Independent review and reply

Before handoff for every run producing a trail, not only committed or high-stakes trails, request a read-only `general-purpose` subagent with role `review`. Give the exact log and transcript paths, a bounded task, and a finite `timeoutMs`. It uses `read`, `grep`, `find`, and `ls`, never edits, accesses external systems, or delegates. The parent supplies any approved external evidence locally.

Use `pstack_config` model discovery and actual run identity to choose an available exact `provider/model-id` from a different model family than the model that did the work. A role pool alone does not guarantee this. Check the resolved reviewer identity, not just the requested selector. Self-review or a same-family model is not a substitute. If no different-family model or delegation is available, say so and mark independent review incomplete; a local audit may still flag issues but cannot satisfy this gate.

The reviewer reads both trail and transcript and flags weak/absent evidence, verification skipped or claimed without proof, premature or scope-expanding choices, symptom patches, missing pivots, and risks a casual skim would miss. This is a scan for risk, not a redo of the work.

Every reply for a run that produced a trail ends with an **Attention** section. Give the log path earlier in the reply. Lead Attention with `reviewed by <actual provider/model-id>` on its own line, then flags pointing to row numbers, timestamps, or transcript moments. `No flags` is valid; a model name alone is not a finding. If independent review did not run, lead with `independent review unavailable: <reason>` instead of inventing an identity, and label any local findings.

To review manually, read top to bottom and follow evidence. GitHub renders a committed TSV as a table; `column -s$'\t' -t decisions.tsv` renders it in a terminal.
