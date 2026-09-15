### Multi-phase or multi-PR plan

**You own the plan, not the code. The plan is a checklist an owner runs box by box and the operator audits from the evidence.** The plan is the deliverable. Do not implement.

1. When the change is one or two files with an obvious approach, skip the plan. Say so and stop.
2. Settle open questions by prototype before you write. Run [Prototype](prototype.md) for each. Keep the branch, the SHA, and the screenshots for Appendix A. Ask the operator only about a product or preference call that no run can settle. Give options (the **never-block-on-the-human** principle skill).
3. Explore in bounded read-only `general-purpose` leaf tasks with configured role models per the Subagents section (the **guard-the-context-window** principle skill). Each returns file pointers, conventions, test commands, and entry points. No inlined dumps.
4. Copy the skeleton below into the plan file and fill every placeholder. Unless the operator names a path, write the file under a named local task directory's `docs/`. Keep every heading and every sub-block in the order shown. One section per PR. One PR is one change with its own evidence (the **sequence-verifiable-units** principle skill). Name the execution playbook in **How to read this**. Name upstream Autopilot-full for independent PRs whose parent owns authorized landing, or upstream Autopilot-stack for a linear stack that stops at merge-ready for operator landing. Neither upstream workflow is bundled. Fill the plan with explicit local lifecycle steps and the parent skill's Local Babysit and Local Shipping gates, not an absent execution path. A standing program takes [Orchestrate](orchestrate.md).
5. Write under `/skill:technical-writing` in full, then `/skill:unslop`. The body is one Diátaxis mode, how-to. Appendices hold explanation and reference. Each heading states the task or the finding. No long dashes. No mid-sentence colons.
6. The upstream check-plan script is not bundled. If the repository supplies a reviewed equivalent, record its real path, run it on the plan, and fix every finding. Otherwise manually check every heading, placeholder, dependency, evidence box, and gate listed in Pi plan constraints and report the missing automated check (the **encode-lessons-in-structure** principle skill).
7. Hand back. Post the plan path and the actual checker output or labeled manual-check results and automation gap, then stop. Execution starts on the operator's explicit go, under the execution playbook the plan names.

**Verification.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked (the **prove-it-works** principle skill). That sentence is the verification rule. Every verification block opens with it. The live block is mandatory. Ten logical scenarios in bounded local requests of at most eight tasks, using the configured `swarm-worker` role, at the PR head drive the real surface through its control skill, per the **swarm** skill. Each lane is one box with a concrete scenario, the screenshot it saves, and its pass predicate. One lane is the **Regression lane against trunk.** It runs the same load-bearing scenario on trunk and head. If trunk does not have the feature, the lane records that fact and gates the behavior the diff adds plus the end state the user waits for instead of inventing a trunk result. The perf gate is dual-sided. Trunk and head must both produce the named metric. If trunk lacks the feature, also isolate the work the diff adds and set an absolute budget for that work plus the end-to-end state the user waits for. Do not claim a ratio between unlike scenarios. The perf block names the metric, the interleaved probe, the trunk baseline measured first, and the rule with the number that fails. A PR that changes an interaction is review-gated. The operator reviews it in chat with screenshots and a video before merge. A PR that changes no interaction writes `**Review gate.** None. <PR id> is not review-gated.` and no boxes under it.

**Control skill.** Pick it by surface. Browser, Electron, and web UIs use available browser-driving tools. CLIs and TUIs use available terminal-driving tools. Native mobile uses whatever simulator-driving skill the repo has. A PR that touches two surfaces gets lanes on both. A surface with no control skill is a risk in Appendix C, and its live block still names how each lane drives it.

````markdown
# <Program> plan

<Under ten lines. What changes, for whom, the rule the program enforces, and the PR ids in order.>

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program follows <named upstream workflow, availability, and the explicit local execution steps and limitations>. <Who merges, and which PR ids are the operator's items that stop at merge-ready.> The parent skill's Local Babysit and Local Shipping gates apply.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, record the local goal with this exact text. "<The plan path, the PR ids in order, the verification rule, who merges, and the done condition.>"
- [ ] Resolve and read the reviewed local instructions at program start and every tick. Record package version or repository SHA. Do not assume the consuming repository stores this package on trunk.
  - [ ] <Available execution instructions, or the named omitted upstream workflow and this plan's explicit local fallback.>
  - [ ] <Resolved installed swarm skill.>
  - [ ] <Available surface-control instructions, or the access limitation and runnable local probe.>
  - [ ] <Parent skill's local Opening a PR, Babysit, and Shipping gates.>
  - [ ] <Resolved path for every other installed leaf skill used.>
- [ ] Record a 30-minute audit checkpoint while the session is active. Check it between bounded requests. If no timer tool exists, state that no unattended wake is armed and leave a durable resume command when stopping.
- [ ] Use this tick prompt, verbatim. "Re-read the resolved local execution instructions, this plan's fallback gates, and the recorded local goal. Audit the operation against them and fix drift in this tick. Probe every active lane through supported host status and durable side effects. Request stand-down only if the host supports messaging or cancellation. Do not reassign a writable scope until the prior task's exit is confirmed. Record uncertain in-flight writes and defer conflicting work. Then post a status message to the operator in chat, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, stop new dispatch and parent writes at once. Send a zero-writes order only if live messaging exists; cancel only if the host supports it. A request is not proof of exit. Without those controls, let the bounded request return, report possible in-flight writes, and keep its scope reserved until confirmed exit. Inspect its final artifacts before any later reassignment.

### Spawn owners

- [ ] Assign one parent-owned lifecycle per PR. Dispatch only bounded leaf tasks for its current stage; no child merges or nests.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] <PR id> and <PR id> are independent and first. Both branch from `main`.
  - [ ] <PR id> after <PR id>.
- [ ] Hold the file boundaries. <PR id or class> touches only `<glob>`.
- [ ] Hold the review gate. <PR ids> change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, with `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Inspect the diff for slop before each commit and run `/skill:no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per the skeptical fix / dismiss / ask rule, with evidence for each disposition.
- [ ] Outside Babysit, the parent prepares the authorized branch against its intended base. Independent PRs use current trunk; stack children keep their parent base. Conflicts or stale bases found during Babysit stop for the parent, not topology changes inside triage. Recheck verdict validity and current-head checks after any base or head change.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten logical live scenarios from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head during build or review gets a fresh swarm and verdict. At landing, a rebase or retarget may retain the code verdict only under the Local Shipping stable patch-id rule; current-head CI and mergeability still run.
- [ ] <The explicit local merge or append rule. Record reviewer verdict, base SHA, head SHA, and stable base-to-head patch-id. Apply the parent skill's Local Shipping gates, including unchanged-patch current-head CI and mergeability, bottom-only retarget and arming, and confirmed merge plus trunk presence before advancement.>

### Boot recipe, for every live lane

Each live scenario runs in an isolated local environment at the PR head. The parent drives available UI or CLI controls. Read-only children audit receipts; write-capable bounded workers may run scoped checks. Split the ten scenarios across requests of at most eight tasks without dropping coverage.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] <Start the backend and the surface. Wait for ready.>
- [ ] <Deliver input only through the control skill's commands. Name the read-only diagnostics.>
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## <Task as a verb phrase> (<PR id>)

**Depends on.** <PR id, or None.>

**Files.**

- [ ] Edit `<path>`.
- [ ] Create `<path>`.
- [ ] Delete `<path>`.

**Build.**

- [ ] <One change. Name the symbol and the file.>

**You see.**

- [ ] <One observable result, with the exact log line or screen state.>

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] <Test file and the case it gains.> Run `<command>`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten logical scenarios in bounded local requests of at most eight tasks, using the configured `swarm-worker` role, at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run <the same load-bearing scenario> at trunk and head. If trunk lacks the feature, record that and gate <the behavior the diff adds plus the end state the user waits for>. Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 2. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 3. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 4. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 5. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 6. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 7. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 8. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 9. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 10. <Scenario.> Save `<slug>.png`. Pass when <predicate>.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. <What is measured at both trunk and head. If trunk lacks the feature, also name the diff-added work and the end-to-end state the user waits for.>
- [ ] Probe. <The command or procedure, run at trunk and at the head, interleaved. Both sides must produce the metric.>
- [ ] Baseline. Record the trunk <value> first.
- [ ] Rule. <Head against trunk, with the number that fails. If the scenarios differ, add absolute budgets for the diff-added work and the user-visible end state instead of an invalid ratio.>

**Review gate.** The operator reviews before merge.

- [ ] Copy lane <n> screenshots into `<media path>/<pr-id>-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane environment. Save it as `<media path>/<pr-id>-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] For authorized independent landing or the current stack bottom only, fetch trunk and rebase if needed. Compare stable base-to-head patch-id with the recorded verdict base/head SHAs. Re-verify changed patches independently; unchanged patches still need current-head CI and mergeability. Stack descendants stay on their parent until they become bottom.
- [ ] Only the current bottom may be retargeted, armed, or landed. Confirm the forge reports merged and fetch trunk to confirm its merged SHA before advancing. A queued or ready state is not a merge.
- [ ] <The authorized parent squash-merges the PR, or the root appends it to the base-branch stack and the operator lands it bottom-up.>

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

<Each open question a prototype answered, with the branch, the SHA, and the artifact links. Each question that stays unproven.>

## Appendix B. Alternatives rejected

<Each approach weighed and why it lost.>

## Appendix C. Risks

<Each risk with the PR it lands in and what the owner watches.>

## Appendix D. Links and reading list

<Docs to read before editing. Which PRs get `skills/how/SKILL.md` and `skills/interrogate/SKILL.md`. The trail per `skills/show-me-your-work/SKILL.md`.>
````

**Reply:** the plan path, the PR ids with their dependencies and the review-gated set, what the prototypes proved and what stays unproven, and actual checker output or labeled manual-check results with the automation gap.

## Pi plan constraints

This remains plan-only. Prototype evidence may come from isolated scratch probes; no production implementation starts without explicit go. The parent owns orchestration, review, integration, and authorized forge actions. Children are local leaves. Preserve all ten live scenarios, the gates lane, perf lane, and independent audit lane across bounded requests, not ten simultaneous children. Never count unavailable live driving as PASS.

Resolve every skill and script path against the installed package or repository. Refer to the reviewed Pi replacement, not unsupported upstream execution instructions. If the execution playbook or `check-plan.mjs` is not installed, record that limitation. Do not invent checker output. Check every placeholder, heading, dependency, file boundary, evidence box, live scenario, dual-sided perf rule, review gate, and appendix locally and report the manual check separately. Select parent-owned independent landing or a linear stack for operator landing as appropriate; keep that policy explicit even if the named upstream playbook is absent. Use a local goal file, task checklist, status table, and handoff instead of cloud, nesting, or persistent wake claims. Host authorization still governs all future PR actions.
