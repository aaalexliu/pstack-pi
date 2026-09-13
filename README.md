# pstack for Pi

`@aaalexliu/pstack-pi` provides eight reviewed skills from Lauren Tan's pstack.
It also provides one read-only bundled agent and a bounded delegation tool.
It is not a full pstack port.

## Supported scope

Pi `0.85.1` exposes these manual commands:

- `/skill:bro`
- `/skill:tdd`
- `/skill:technical-writing`
- `/skill:typescript-best-practices`
- `/skill:unslop`
- `/skill:principle-boundary-discipline`
- `/skill:principle-encode-lessons-in-structure`
- `/skill:principle-type-system-discipline`

Each skill keeps upstream's `disable-model-invocation: true` flag.
Pi hides these skills from model discovery but expands explicit commands with their arguments.
The TypeScript skill includes `references/patterns.md`.

The package ships nine generated skill files, one generated agent, ten extension modules, and `LICENSE`, `README.md`, and `package.json`.
At root depth it registers one `subagent` tool, a `session_shutdown` cleanup hook, and a `tool_result` hook limited to its own failed delegations.
It registers no prompts, themes, or commands.
Chained requests, a usage command, todos, and broader workflows remain deferred.
`/skill:how`, `/skill:poteto-mode`, and `/skill:setup-pstack` do not expand.

The package never installs a blanket command-approval gate, inspects unrelated shell strings, or requests package-wide confirmation for routine Git pushes or pull-request edits.
Those actions remain under host policy.
Its validation applies only to `subagent` requests.

## Delegation

Call `subagent` with one agent and one task:

```json
{"agent":"general-purpose","task":"Read src/index.ts and explain its exports."}
```

The public fields are `agent`, `task`, optional `cwd`, `limits`, `model`, and `role`.
Unknown fields, unknown roles, and non-exact model values reject before spawn.
`limits.timeoutMs` and `limits.outputBytes` accept positive integers that lower the host's 120,000 ms deadline and 32,768-byte output cap.
Larger values clamp to the host limits and produce diagnostics.
There is no trust or approval argument.
An omitted `cwd` uses the current Pi working directory.
A supplied path must name that same real directory.
Different directories, missing paths, symlinks in the supplied path, and non-directories fail before spawn.

`general-purpose` has exactly `read`, `grep`, `find`, and `ls`.
Its prompt forbids delegation and file changes.
The catalog reads bundled agents first, then Markdown files directly under `getAgentDir()/agents`.
This normally means `~/.pi/agent/agents`.
A user definition overrides a bundled definition with the same name.
The catalog records both definitions and their path and SHA-256 provenance.
It never discovers project agents, including in trusted projects.
Headless requests cannot approve them.

User agents require a name, description, explicit YAML tools array, and nonempty prompt:

```markdown
---
name: reader
description: Read files and answer a focused question.
tools: [read, grep, find, ls]
---
Answer from file evidence. Do not delegate.
```

An optional `model` field accepts `inherit-parent` or one exact `provider/model-id`, never a pool.

Names use lowercase letters, numbers, and single hyphens, with at most 64 characters.
Accepted tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`.
`tools: []` means no child tools, not Pi's default tools.
Missing tools, comma-delimited strings, unknown fields, duplicate YAML keys, duplicate names within one directory, and symlinks fail validation.
Any catalog diagnostic stops delegation rather than silently choosing a fallback.
Each directory allows at most 128 entries; each agent file allows at most 64 KiB.

Each child uses the current Node executable and Pi entrypoint, resolved to absolute real paths.
The runner validates the entrypoint against the installed Pi `0.85.1` package and its declared CLI before spawn.
It does not search `PATH` for `pi` or use a shell to launch it.
An invalid or unsupported host invocation disables delegation.
The child uses separate exact `--provider` and `--model` arguments.
Inherited choices preserve the captured parent thinking level. Pinned choices use `--thinking off`.
The child gets an explicit tools allowlist or `--no-tools`.
It loads no extensions, skills, prompt templates, context files, or saved session.
It receives a private `0600` system-prompt file and an empty append prompt, which prevents `APPEND_SYSTEM.md` discovery.
The task travels through stdin, so leading `@` and CLI-looking text stay task text.
Children expose no `subagent` tool.
The host permits delegation only at depth zero and sets the child to depth one, the leaf boundary.
It removes inherited `PSTACK_*` variables before setting the child depth.
Malformed depth values or depth one and above disable this extension's tool and both hooks.
Tool allowlists are not an OS sandbox. A user agent with `bash` can run arbitrary commands, including launching processes outside this delegation API.

The runner accepts LF-delimited JSON with strict UTF-8 decoding.
Its limits are 256 KiB per record, 4,096 events, 8 MiB stdout, and 64 KiB stderr.
It caps returned text at 32 KiB and does not return raw stderr.
A successful result requires a settled final assistant message with `stopReason: "stop"`, the requested model, exit code zero, and verified cleanup.
Every authoritative child assistant message must match the resolved model identity.
Truncation is explicit. Tool details include identity, bounded agent provenance and cwd, outcome, limits, cleanup, diagnostics, requested/resolved/observed model identity, and a usage report.
Child failures throw from `execute`, so a missed result hook still leaves a real error.

A parallel request has this shape:

```json
{"tasks":[{"agent":"general-purpose","task":"Read the API.","role":"feature"},{"agent":"general-purpose","task":"Read the tests.","model":"inherit-parent"}],"limits":{"outputBytes":8193}}
```

The host accepts 1-8 tasks and runs at most four children. These are separate limits.
Task entries accept only `agent`, `task`, `model`, and `role`. Optional `cwd` and `limits` belong to the request.
Each task allows 32 KiB of UTF-8 text. All task text together allows 128 KiB, and serialized request JSON allows 160 KiB.
The host validates every task, qualifies every model, and pins the Pi invocation before admitting the immutable batch.
A rejected or cancelled preparation starts no children and consumes no pool slots.

Each extension instance reserves one request at a time, including preparation and cleanup.
An overlapping call fails rather than waiting in a second request queue.
The 120-second request deadline starts at reservation. Preparation and queue time count.
The scheduler dispatches tasks in input order and holds each slot through prompt removal and verified process cleanup.
Results keep input order. Ordinary task failure does not stop siblings.
The retained-output budget splits by input index, with one extra byte for each leading index covered by the remainder.
Quotas never move between tasks. Small budgets can give later tasks zero bytes.
Successful calls return bounded ordered output, task metadata, and one aggregate top-level Pi `usage` value.
Any failed, cancelled, or skipped task makes the tool throw one bounded ordered summary.
Request cancellation also fails the call if every child has already finished.
The 32,768-byte result-text cap includes summary labels and notices. A 64 KiB serialized envelope cap can shorten text further.
`details.resultOutput` reports the pre-truncation byte count and whether the envelope shortened the text.
Pi 0.85.1 discards details and usage attached to thrown errors. The owned-result hook restores those fields after cleanup.
User cancellation, the deadline, and `session_shutdown` stop dispatch and cancel every active lease before awaiting them together.
Queued tasks become skipped. Shutdown rejects new work and waits for request cleanup.

The runner creates a detached process group and polls `/bin/ps` on macOS and Linux for descendants and process identities.
It sends `SIGTERM` through the live direct child handle even if process observation fails.
After a one-second grace period, it sends `SIGKILL` to the still-live child handle, its safe initial group, and observed owned processes and groups.
An observed group remains owned only while a current member matches a recorded identity in that group, or the live direct child proves the initial group.
A stale group ID alone cannot establish ownership.
The runner then allows two seconds to verify cleanup.
If cleanup cannot prove that the child exited within those timers, it returns an unverified report and quarantines the extension instance.
A deadline starts cancellation rather than guaranteeing termination by that instant. Process-table commands can each take up to 250 ms, and OS scheduling or filesystem stalls can delay timer callbacks.

Observation failures, unsafe identities, and unverified cleanup immediately stop dispatch and broadcast cancellation to active siblings.
This signal is sticky even if a later process-table read succeeds. Finished siblings cannot release new queued work after trust is lost.
The request waits for all active cleanup, marks queued tasks skipped, and quarantines further delegation in that extension instance.
Prompt removal gets at most another two seconds, including any pending prompt write.
If filesystem work outlives that wait, the request returns an unverified cleanup failure and quarantines the session.
Late filesystem completion still attempts prompt removal but cannot start a child or restore trust.
The runner removes listeners after cleanup.
macOS and Linux polling cannot guarantee containment of an unseen fast double-fork or cleanup after host `SIGKILL`.
Process-table snapshots and signals are not atomic, and `ps` start times have only second-level precision.
These checks do not provide adversarial process isolation.
Delegation rejects unsupported operating systems, including Windows.

## Usage and failed results

`protocol.ts` owns bounded UTF-8/LF JSONL parsing and message lifecycle state. `usage.ts` owns validation, arithmetic, and reports.
The parser uses Pi 0.85.1's JSON-mode projection. Assistant `message_start` opens a provisional snapshot, `message_update.usage` replaces it, and `message_end` commits it once.
It counts charged failed assistant attempts before retries and completed `compaction_end.result.usage` once.
Retry events control execution but add no usage. Repeated `turn_end`, `agent_end`, entry copies, and tool-execution events add nothing.
The parser rejects malformed consumed fields, unknown event names, duplicate or unmatched ends, events after settlement, unsafe numbers, overflow, and protocol bounds.
Only a final `stop` can succeed. Recognized terminal `length`, `toolUse`, `error`, `aborted`, and `deferred` outcomes remain failures.

Every task has `details.usage.scope: "pi-reported"` with `direct` and `descendant` reports.
Each report has `kind: "complete"` or `kind: "partial"` and a known `usage` value.
Partial reports add bounded reason codes and a `provisional` snapshot, or `null` when no assistant remains open.
The direct known amount includes that provisional snapshot once. Never add `provisional` to it again.
Later stream failure, cancellation, and cleanup uncertainty preserve earlier valid usage.
A never-started queued task has complete zero usage. An unexpected runner failure has partial usage, not a claim of zero work.

The primary token fields are `input`, `output`, `cacheRead`, `cacheWrite`, and `totalTokens`.
All tokens must be nonnegative safe integers; all five cost fields must be finite and nonnegative.
Optional `reasoning` and `cacheWrite1h` remain reported subsets. They do not increase the primary fields.
The extension neither prices tokens nor forces `totalTokens` to equal the other fields.
Pi stores `totalTokens`, but Pi 0.85.1 computes its displayed session token total from input, output, cache reads, and cache writes.
Batch aggregation follows input order. If an aggregate cannot represent another charge safely, the request fails and retains the representable known amounts with an overflow diagnostic.

Supported children are leaves, so their descendant report is complete known-zero.
Unexpected top-level usage on a child's final tool-result message counts once as descendant evidence, makes that report partial, and fails the leaf contract.
The production tool has no flag that enables nested delegates.
These reports describe Pi-emitted usage, not provider invoice proof. Missing provider charges, failed summarization attempts with no completion usage, and arbitrary processes launched by a user agent remain outside that evidence.

The synchronous `tool_result` hook first rejects every tool name except `subagent` without inspecting other fields.
A private WeakMap associates the original validated request object with a fresh Symbol and a bounded record. Matching also requires the exact tool-call ID.
The hook patches only a retained failed record whose input identity, native error text and shape, empty details, absent usage, and `isError: true` remain unchanged.
It discards changed owned results instead of overwriting another handler. Copied JSON, duplicate IDs alone, matching text, foreign same-name tools, and preflight-rejected calls cannot match.
The hook erases the record before returning ordered details, bounded content, and one aggregate usage value with `isError: true`.
Pi counts and persists that final tool result once. Reload reads the persisted result; the extension does not replay charges.

There are at most 32 correlation records and 64 KiB of serialized result data per retained envelope.
Tool-call IDs above 1,024 UTF-8 bytes reject before correlation reservation, rather than retaining an unbounded host-supplied ID.
Running records never expire or get evicted. Failed records expire 30 seconds after cleanup through one lazy timer.
Success, preflight failure, hook consumption, expiry, and shutdown erase records. Shutdown closes the state before awaiting scheduler cleanup, so late completion cannot restore it.
A full record table rejects new work. An expired, changed, or missed hook leaves Pi's native error intact but cannot restore its discarded accounting.
Hostile in-process extensions are outside this boundary. They share process privileges and can replace tools or alter results after this hook.
There are no `tool_call`, `user_bash`, or command interception hooks.

## Model routing

The only routing config is `getAgentDir()/pstack-pi/models.json`.
A missing file means no configured roles. The extension never writes config or reads project or donor routing config.
The format has exactly `version` and `roles`:

```json
{"version":1,"roles":{"feature":["inherit-parent","openai/gpt-4o","openai/gpt-4o"],"review":"inherit-parent"}}
```

A choice is exactly `inherit-parent` or `provider/model-id`.
Providers use 1-64 lowercase ASCII letters, digits, dots, or hyphens, starting with a letter or digit.
Model IDs use 1-256 ASCII letters, digits, `_`, `.`, `:`, `@`, `/`, `+`, or `-`, starting with a letter, digit, or `@`.
Only the first slash separates provider and model. Spaces, wildcards, bare names, aliases, and thinking suffix syntax are not routing options.
A colon can belong to an exact catalog ID.
Pools contain 1-64 choices. They retain duplicates and `inherit-parent` entries.
Pool length controls neither task count nor concurrency.

The closed role IDs are:

- `feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment`, `prose`, `hardest`
- `how-explorer`, `how-explainer`, `how-critics`, `why-investigator`, `why-synthesizer`
- `reflect-tooling`, `reflect-judgment`, `reflect-divergent`, `reflect-synthesizer`
- `arena-runner`, `arena-cross-judge`, `swarm-worker`, `architect-runner`, `interrogate-reviewer`
- `no-comments`, `review`, `test`, `verify`

These IDs reserve routing for planned workflows. They do not enable those workflows.
Resolution uses the explicit task `model`, the requested configured `role`, the agent's `model`, then the parent.
An unknown role always rejects, even with an explicit model. A known but unconfigured role falls through.
Each role has an in-memory round-robin counter. Explicit models consume no pool slot.
The scheduler plans all choices in input order against copied counters, then commits the batch and counters together.
Rejected or cancelled preparation consumes no slot. Every admitted task consumes its assigned slot, even if queued or later cancelled.
Counters reset only when that role's parsed assignment changes, or when Pi creates a new extension instance.
Config formatting and role-key order do not reset them. Nothing persists counters to disk.

The routing file has a 64 KiB cap and a 32-level JSON nesting cap.
The loader rejects malformed UTF-8, BOMs, invalid JSON, duplicate keys, trailing data, unknown properties, and unknown roles.
No-follow descriptor reads reject symlinks and non-regular files. The file and package-specific directory must belong to the current user.
Group/other write bits and special mode bits reject. The loader checks file size and metadata before and after bounded reads, and checks directory identity.

Qualification uses a new Pi `ModelRuntime`, not the parent's extension registry or runtime credentials.
It loads only standard stored, config, and environment auth, with model network refresh disabled.
No credential enters argv, tool details, or a copied config file.
The parent model and thinking level are captured before the first await.
Inheritance rejects parent providers registered by extensions and any difference in standalone model metadata.
Pinned choices may select another standalone provider without inheriting parent overrides.

Pi 0.85.1 imposes narrower rules:

- `ModelRuntime.create()` creates a missing `auth.json`. Delegation instead requires the existing file that Pi creates at startup, so qualification does not create config files.
- Its public registry has no command-disabled auth mode. Delegation preflights the standard `auth.json`, `models.json`, and `models-store.json` with safe bounded reads. Each has a 1 MiB cap. Any leading-`!` string anywhere in those files rejects, even on unused providers. References to child-filtered `PSTACK_*` variables also reject.
- `getAvailable()` proves configured auth, not token validity or server access. The adapter never calls `getAuth()` or runs credential commands. The child resolves its own standard credentials and may refresh standard OAuth tokens.
- Bedrock and Vertex external credential chains are unsupported. Supported APIs are `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `mistral-conversations`, and `pi-messages`.
- The CLI matches IDs case-insensitively and strips a repeated provider prefix. After exact lookup, a CLI round-trip check rejects choices that would select another identity or parse thinking syntax. It never accepts a fuzzy substitute.
- Models that cannot use `off` reject pinned choices. Inheritance requires a supported captured thinking level.

Standard files and environment must remain stable during preparation and child startup. Pi reopens them in the child; its public APIs cannot bind both processes to one immutable config snapshot without copying credentials.
The file checks do not provide isolation against a hostile process running as the same user.

## Local installation

Run `npm ci` in the checkout, then register it with `pi install /absolute/path/to/pstack-pi`.
Pi records it in the user profile by default.
Add `-l` to register it in the current project's settings instead.
These instructions do not assume an npm release exists.

The declared host is Pi `0.85.1`, with Node.js `>=22.19.0`.
`engines.pi` records the tested version but npm does not enforce it.
The package starts at version `0.1.0` and follows independent SemVer, not Cursor plugin versions.

## Upstream provenance

The sole source for shared content is [Lauren Tan's pstack in cursor/plugins](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack).
The [MIT license](LICENSE) preserves Lauren Tan's notice unchanged.

The pinned source commit is `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`.
Its `pstack` tree is `6d4e9d1140f70c483e5617c405baa5bb5654e211`.
`vendor/cursor-pstack/` contains that immutable snapshot.
`sync/upstream.lock.json` records source blobs, modes, and generated hashes.

`sync/manifest.json` is the only authored classification of the 158 source files.
It copies seven files, transforms two, and explicitly omits 149.
The transformations replace `/technical-writing` with `/skill:technical-writing` once and remove the unsupported TypeScript `paths` frontmatter line once.
Each transformation requires its locked source blob and exact match count.
All other generated upstream bytes match their source.

The manifest and lock use strict version 2 with required `additions` arrays.
`sync/additions/agents/general-purpose.md` is a Pi-owned source, separate from the 158 upstream paths.
Its manifest entry records `source`, `destination`, `mode`, and `reason`.
Its lock entry records `source` and `output` with `destination`, `sha256`, and `mode`.
Additions copy raw bytes from strictly below `sync/additions/` into managed roots.
The same evaluator checks all output collisions and stages both upstream and authored content.
Missing, extra, symlinked, special, and native-colliding addition inputs stop sync.

Cursor distribution metadata, guides, branding assets, Cloud Automations, `make-bot-ui`, and unsupported scripts remain omitted.
Upstream agents and runtime-dependent workflows remain omitted.
Other principles remain outside the reviewed dependency closure.

[0xrsydn/pstack-pi](https://github.com/0xrsydn/pstack-pi) and [kkgogogo17/pi-pstack](https://github.com/kkgogogo17/pi-pstack) are implementation references, not sources for shared content.
The [aaalexliu/pstack-pi project](https://github.com/aaalexliu/pstack-pi) owns the Pi adaptations and package code.

## Regeneration and checks

Never edit generated `skills/`, generated `agents/`, or the pinned snapshot by hand.
Edit Pi-owned agent sources under `sync/additions/`.
For a reviewed manifest change against the existing snapshot, run:

```sh
npm ci
npm run sync:relock
npm run sync
npm run check
```

Relock verifies the existing snapshot before updating adaptation and addition hashes.
Sync writes only managed content.
Neither command changes package metadata or documentation.

`npm run check` runs type checking, `sync:check`, `check:content`, and tests in that order.
CI runs the same command in the checkout and in a clean Git archive with no `.git` directory.
`npm run sync:check` and `npm run check:content` also run on their own.

`check:content` validates exact membership, YAML frontmatter, dependency closure, local links, file modes, explicit package exposure, and the dry-run pack inventory.
The fixture tests reject duplicate YAML keys, unresolved dependencies, Cursor-only mechanics, undeclared agents, and unexpected runtime registration.
A fake ExtensionAPI checks the single `registerTool` call and exactly the `session_shutdown` and scoped `tool_result` hooks, with no command gate.
They preserve genuine protocol identifiers such as review author `cursor` and `CURSOR_AUTOMATION_ID`.

The real Pi tests pack and move the package into an isolated profile.
They inspect provider requests for all eight commands, exact skill bodies, arguments, relocated paths, and the single declared extension tool.
A scripted real parent delegates a fixture read to a real child, receives the result, and runs harmless bash containing literal `git push` and `gh pr edit` text.
Other runs deny project agents and cwd changes before any child request, and prove that an empty-tools user override has no tools.
Production child requests lack `subagent`; process checks reject surviving observed descendants and leftover prompt files.
The packed execution tests cover reduced deadlines, one-at-a-time admission, depth rejection, fake `pi` in `PATH`, and parent `SIGTERM` and `SIGHUP` cleanup.
They retain the controlled detached-work test, which keeps ancestry visible long enough for polling.
Focused process tests cover continuous observation failure with a real stalled child and deterministic group-ID reuse.
The packed routing tests use a separate exact-model fixture without changing the Phase 6 provider.
Seven real children prove cross-provider explicit choices, mixed pools, duplicate entries, agent defaults, and inherited thinking.
Provider request bodies and authoritative child observations must match the expected sequence.
Other real runs reject unknown roles, fuzzy names, unavailable pool entries, duplicate config keys, and unused credential commands before a child request.
The parallel tests use a separate concurrent provider keyed by the exact final user marker, never global request order.
Four real leaf children complete in reverse while their assignments and results retain input order. Eight tasks prove FIFO replacement after cleanup.
The tests cover independent role counters across requests, duplicate and inherited pool entries, explicit overrides, fixed UTF-8 output quotas, and overlapping request rejection.
A request-wide deadline cancels four active children and skips four queued tasks without refunding their model assignments.
Parent `SIGTERM` and `SIGHUP` clean all four children without harming an unrelated sibling. Ordinary failure leaves siblings running.
Each production observer verifies process and prompt cleanup before test rescue. Existing observers still default to one child.
Focused tests cover user abort with four real child processes, early cleanup uncertainty, and bounded cleanup when prompt writes or removal stall.
The concurrent fixture allows twelve seconds for a check that spans several serial child replacements; this does not raise any production deadline.
The unchanged Phase 6 recursion fixture is an unsafe positive control, not the production delegation path.
The accounting tests verify installed Pi's returned-error, thrown-error, and patched-error behavior through provider requests, JSONL events, persisted session totals, and reload.
Packed child reads, charged length failures, cumulative updates, truncation, and cancellation use exact known provider tokens and costs.
An injected child JSONL control tests unsupported descendant evidence without enabling production nesting.
The main delegation, model-routing, and accounting tests retain their tarballs and `run.json` under the artifact paths printed in test output.
Other test profiles are removed.
Runtime tests copy only the pinned `yaml` dependency into the relocated package. Pi supplies its own host modules.
`skipLibCheck` skips defective third-party declarations in Pi's dependency tree; project TypeScript still uses strict checking.
They check duplicate-name diagnostics through Pi's resource-loader SDK because print-mode JSONL does not emit those warnings.
The deterministic provider runs on loopback and needs no provider credentials.
These checks prove content loading and real tool execution, not model compliance with the skill instructions.
