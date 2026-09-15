### Orchestrate

**You own the program, never the code. Author briefs, drain the queue, keep the frontier green, decide.** For a whole project handed to one standing coordinator chat: multi-day, many stacked PRs, dozens to hundreds of subagents, the human checking in twice a day instead of every five minutes. One task driven to a predicate is Autonomous run. One ambitious run needing a bespoke workflow is figure-it-out. Route here when the work outlives any single agent. Work one agent could finish inside the session's budget is not a program.

Ceremony must scale with the program. On cheap near-identical units, collapse it as each section directs.

Three rules carry the rest.

- Completions are queue events, not interrupts.
- Every task and every replacement task carries the standing orders verbatim.
- The brief is the product. A vague brief fails quietly, because a worker cannot ask you a question.

#### Roles and placement

- **Coordinator (this chat).** Owns briefs, queue, judgment, review, integration, and human reports. Prefer delegation for code. With no delegation, explicitly absorb bounded units locally with separate review; do not pretend a child exists.
- **Tracks.** Logical groupings owned by the parent, not nested sub-coordinators. Keep one owner per shared artifact. Route coverage through `/skill:swarm`, contested decomposition through `/skill:arena`, and broad change risk through `/skill:blast-radius`.
- **Worker / verifier.** Local leaf tasks. Use write-capable `poteto-agent` for scoped implementation and read-only `general-purpose` for exploration or review. Read-only reviewers receive parent-run runtime receipts. Prefer a different configured model family for independent verification and disclose when unavailable. Give each writer its own worktree or output; a branch alone is not isolation.

Only one live `subagent` request, at most eight `tasks`, at most four active children. Drain between bounded requests and recompute ready work. This replaces rolling cloud windows and nesting, not coverage or accounting. Never promise persistent background work or child resumes.

#### Store layout

Create `orchestrate/<project-slug>/` under a named durable local task directory. Every file has exactly one writer. Owners publish facts, readers aggregate at read time. The parent owns bookkeeping in plain TSV and JSON. No `orch` runtime is required. Write durable tables at drain points and derive summaries from them.

- `preferences.md` is the standing-orders register: numbered lines, one constraint each (model policy, stack shape and count, verification bar, forbidden paths, escalation policy). Paste it verbatim into every task and every replacement task. Directives decay across resumes, and each dropped one costs a human turn. When you catch yourself restating an instruction, append the line before you act (principle-encode-lessons-in-structure).
- `overview.md` is the durable PR and issue DB. Append. Never rewrite wholesale per event.
- `units.tsv` has one row per unit: id, track, state, branch, PR, head SHA, brief path. Update rows in place.
- `frontier.json` is the computed merge frontier, per Stack safety.
- `ledger.tsv` is the verification ledger, per Verification.
- `inbox/` holds completion pointers. `gates.md` parks human gates (question, options, default on no answer).
- `decisions.tsv` is the trail via the show-me-your-work skill.
- `status.md` is derived from `units.tsv` and `ledger.tsv` at each drain, never hand-maintained. Regenerate it from the tables instead of narrating events into it.

#### The brief

Your prompts to agents are your only product, and a sloppy brief compounds into slop across the whole tree. Every spawn carries all of it. A field you cannot fill is a unit you have not scoped yet.

```
GOAL         one sentence, the outcome, executable by a stranger with no chat access
SCOPE        paths this unit may write; paths it may not; its exclusive worktree or branch
CONTEXT      pointers to files and PRs; upstream reports pasted in full when this unit
             depends on them, because workers cannot see siblings
ACCEPTANCE   checkable criteria, one per line
VERIFY       exact commands or the control-skill path, plus known gotchas
TIMEBOX      rough cap on runtime; on expiry, return partial findings and stop rather than run on
FORBIDDEN    no nesting, no publish or merge, no rebase, no force-push, no fixes outside scope, plus unit-specific bans
REPORT       status, branch, head SHA, PRs, verdict, what you actually ran, deviations,
             suggested follow-ups
STANDING     <preferences.md pasted verbatim>
```

Size the brief to the unit. A one-command unit gets the template collapsed to a paragraph that still names goal, scope, the verify command, and the report shape. A 4KB scaffold around a two-line edit costs more to write and obey than the edit. Every task receives the standing orders verbatim.

The parent holds track boundaries, unit lists, bounded task budgets, drain protocol, and rollup format (per child: name, status, PR, head SHA, verdict, one line, plus track status and frontier delta).

A dependency is a context relay, not just ordering. Undeclared upstream context makes the worker guess. Missing fields are a refuse-to-spawn condition. Audit one sampled worker brief per parent-owned track per bounded request, concurrently with the wave it samples, never as a gate in front of it. A failing brief stops that track and fixes the parent's instructions, not just the worker, because brief quality decays late in a run. Never resume-chain a brief. Respawn fresh with consolidated scope.

#### Steps

1. **Frame.** State the done predicate as something countable ("all 126 units merged, each ledger-verified `unit-test-verified` or better"). Quantify scope: units, rough effort, expected stacks, and the wall-clock budget. If one agent could finish inside that budget, stop here and run Autonomous run instead. Collapsing must not depend on another document being present. It means do the work directly in this session, plain workers where they help, verification inline, landing as you go, and none of the store, register, or pilot machinery below. Schedule landing against the budget. By roughly 70% of it, stop spawning and land what is verified. Name the tracks per project. A contested decomposition or one-way door goes through the arena skill before the pilot. Present the framing once. Reversible prep proceeds without waiting.
2. **Install the runtime.** Create the store and its tables. Open the trail via the show-me-your-work skill, write the standing orders before any spawn, and seed `frontier.json` from existing PRs from live local Git and forge evidence.
3. **Pilot.** Push one unit through the whole path: brief, worker, verification, stack entry, ledger row, merge. The pilot exists to falsify the brief template, the verify recipe, and the unit size while that costs one agent instead of fifty. Fix the contract from pilot evidence before any fan-out. Scale the pilot to the unit. On programs of near-identical cheap units, the first unit is the pilot, run as a normal unit with its verify command inline, and fan-out starts the moment it lands. The dedicated pilot pipeline (separate verifier agent, audit gate) is for expensive or novel unit shapes, not for clone-units where a serialized pilot has nothing to falsify.
4. **Scale.** Dispatch bounded requests up to eight tasks, at most four active. Recompute ready work after each drain. Relay upstream reports into downstream briefs. Keep sibling communication upward only. Audit sampled briefs before refilling. Preserve every planned unit even though Pi cannot refill a rolling background window.
5. **Drain.** Run the queue discipline below at every drain point.
6. **Land.** Landing is continuous, never a terminal phase. Integration starts with the first verified unit and runs alongside the remaining waves. The parent serializes integration from wave one, dispatching bounded conflict-fix tasks when needed. Publishing and landing require host policy and user authorization; otherwise preserve verified local artifacts and record the gate. Keep the frontier green before upper-stack work. Stack safety governs. Advance `frontier.json` only on merge or reported new head SHAs.
7. **Close.** Drain the final inbox, reconcile every spawned agent to a terminal row (done, abandoned, zombie-reconciled), confirm the predicate on the real artifact, confirm every landed PR has a verdict for its current head SHA, audit the trail per show-me-your-work including its cross-model review, encode recurring corrections into `preferences.md` or the brief template. Leave the store intact. It is the postmortem.

#### Queue and drain

- Record terminal task results as completion pointers in `inbox/`. Completions are queue events, not interrupts. Review-heavy results become separate verification units outside the drain.
- Drain after each bounded request, after a critical section, and before each human report. Critical sections include brief authoring, stack operations, conflict decisions, gates, ledger, and frontier writes. Snapshot the inbox; later arrivals wait for the next drain.
- Critical sections you finish first: authoring a brief, a stack operation, a conflict decision, writing a gate, updating ledger or frontier.
- Classify every pointer as landed, needs-verify, failed, zombie, or noise. Update unit rows and ledger, derive status, then dispatch ready work. Never deep-review a diff inside the drain.
- Account for every spawned child at its track's rollup: arrived, respawned, or its scope explicitly absorbed. Silently redoing a missing child's work hides both the wasted spend and the coverage gap its result existed to close.
- End a drain with three lines: counts by state, what changed, gates open. Details live in `status.md`. The full reply contract applies at checkpoints and close.

#### Stack safety

- Compute `frontier.json` from live Git and forge evidence after every merge or stack mutation. Record ordered PRs, branch names, head SHAs, generation, and lowest unmerged PR. Missing evidence blocks frontier advancement rather than inviting a guess.
- Exactly one parent-owned integration owner per stack. Serialize restacks and shared writes. Workers never rebase or run stack surgery. Status and review tasks are scoped to one immutable frontier generation and report conflicts to the parent.
- Workers never rebase or perform stack surgery. The parent owns Babysit, one lifecycle per stack scoped to one immutable frontier generation. Conflicts stop triage for parent repair outside Babysit.
- The parent alone handles authorized PR closes, retargets, and landing. Closing a base can orphan the chain above it. Each surgery has a scoped brief and verification.
- Check merged PRs for reverts, post-merge CI failures, and orphaned follow-ups at active-session checkpoints. No unattended watcher is promised.

#### Verification

Scale verification to the unit. When VERIFY is a single cheap command, the worker runs it and reports the output, and the coordinator spot-checks receipts. A dedicated verifier agent (on a different model family than the worker) is for units whose verification is expensive, judgment-laden, or high-blast-radius. A verifier agent whose entire product would be rerunning one command is ceremony, not verification.

Write ledger rows in the parent and check each against the current PR and head SHA from Git and the forge. `ledger.tsv`, one row per verdict, keyed by PR number plus head SHA: `live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed`. CI green is an input to a verdict, not a verdict. Behavioral work needs better than `type-check-only`. `verifier-blocked` is not a pass. Respawn when the environment heals. `verifier-failed` gets a fix unit, not a re-verify. A worker may self-report. A verifier overrides it on the same key. A new head SHA voids the row, so re-verify after restack. The ledger answers "was this verified", not memory and not the transcript.

A unit is not done until its output is externalized the moment it lands, never batched to the end of the run. The parent records the branch and head, persists receipts and verdicts, and pushes only when authorized. If remote publication is required but blocked, the unit stays gated rather than falsely landed. Work without durable artifacts was never done.

#### Liveness and failure

- Never resume an agent to check on it. A resume restarts an idle agent. Probe read-only: the ledger, `units.tsv`, `gh`, pushed branches, available host task status. Transcript mtime is not liveness.
- A silent death gets a synthetic postmortem row in the inbox (unit, failure mode, last evidence, options). Replan on evidence as it arrives. Never wait for full quiescence.
- Retry by mode: cap-hit or oom, respawn with smaller scope. Network-drop, retry as-is. Tool-error, retry on a different model. Unknown, retry once. Two retries, then abandon the unit and replan around it.
- A zombie that returns hours late reconciles against the current frontier and ledger before anything is accepted. Salvage unique findings through a fresh unit, never a blind merge.
- When continued spawning would produce garbage tree-wide (bad upstream output, broken acceptance, dead infra), write a stop line at the top of the standing orders, let in-flight work finish, fix the cause, clear it.
- Bound your own infra retries the same way you bound a child's. After a few consecutive tool aborts, stop retrying. Write a terminal handoff to durable state (what is done, where it lives, the exact command to resume) and end the run.
- After a session restart, assume local children are dead until proven otherwise. Read standing orders and units, recompute the frontier from live evidence, reconcile durable outputs by branch and head, record terminal child states, and dispatch fresh bounded tasks from consolidated briefs. Do not claim cloud reattachment or automatic lock recovery.

#### Escalation

Reaches the human, batched into the status page rather than per item: irreversible actions (force-push to shared branches, deploys, deletions, closing someone else's PR), genuine product or preference calls no experiment settles, a standing order that contradicts observed reality, a program-level dead end that survived a replan. Park each as a `gates.md` entry before asking, and route work around it.

Never reaches the human: frontier nudges, restack mechanics, retries, CI flake triage, review-thread triage, format fixes, scope the brief already forbids (refuse and continue), and "should I keep going". When in doubt, act and log.

Mid-run discoveries fix only what blocks the frontier. Everything else parks in follow-ups. At this fan-out a small scope leak multiplies into PRs nobody asked for.

A hold stops new dispatch and parent writes. Send live stop or cancellation only if exposed. Confirm exit and reconcile artifacts before reusing a child's writable scope. Without controls, wait for the bounded task and report uncertainty.

**Reply:** at checkpoints and close: the predicate and the count against it from `units.tsv` and `ledger.tsv`, tracks and what each landed, the frontier (PR list plus SHAs), verdicts summary, what was abandoned and why, gates awaiting the human (the only asks), the store path, and the trail path. Numbers from the tables, not narrative. Include PR links.
