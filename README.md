# pstack for Pi

`@aaalexliu/pstack-pi` provides eight reviewed skills from Lauren Tan's pstack.
It also provides one read-only bundled agent and a single-delegate tool.
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

The package ships nine generated skill files, one generated agent, six extension modules, and `LICENSE`, `README.md`, and `package.json`.
At root depth it registers one `subagent` tool and one `session_shutdown` cleanup hook, with no prompts, themes, or commands.
Parallel and chained requests, role-based model routing, usage totals, todos, and broader workflows remain deferred.
`/skill:how`, `/skill:poteto-mode`, and `/skill:setup-pstack` do not expand.

The package never installs a blanket command-approval gate, inspects unrelated shell strings, or requests package-wide confirmation for routine Git pushes or pull-request edits.
Those actions remain under host policy.
Its validation applies only to `subagent` requests.

## Single delegation

Call `subagent` with one agent and one task:

```json
{"agent":"general-purpose","task":"Read src/index.ts and explain its exports."}
```

The public fields are `agent`, `task`, optional `cwd`, and optional `limits`.
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
The config parser reserves `<Pi agent dir>/pstack-pi/models.json` for version-1 role assignments.
Runtime routing follows in the next change.

Names use lowercase letters, numbers, and single hyphens, with at most 64 characters.
Accepted tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`.
`tools: []` means no child tools, not Pi's default tools.
Missing tools, comma-delimited strings, unknown fields, duplicate YAML keys, duplicate names within one directory, and symlinks fail validation.
Any catalog diagnostic stops delegation rather than silently choosing a fallback.
Each directory allows at most 128 entries; each agent file allows at most 64 KiB.

Each request starts a child with the current Node executable and Pi entrypoint, resolved to absolute real paths.
The runner validates the entrypoint against the installed Pi `0.85.1` package and its declared CLI before spawn.
It does not search `PATH` for `pi` or use a shell to launch it.
An invalid or unsupported host invocation disables delegation.
The child uses the parent's provider-qualified model and available thinking level.
The child gets an explicit tools allowlist or `--no-tools`.
It loads no extensions, skills, prompt templates, context files, or saved session.
It receives a private `0600` system-prompt file and an empty append prompt, which prevents `APPEND_SYSTEM.md` discovery.
The task travels through stdin, so leading `@` and CLI-looking text stay task text.
Children expose no `subagent` tool.
The host permits delegation only at depth zero and sets the child to depth one, the leaf boundary.
It removes inherited `PSTACK_*` variables before setting the child depth.
Malformed depth values or depth one and above disable this extension's tool and hook.
Tool allowlists are not an OS sandbox. A user agent with `bash` can run arbitrary commands, including launching processes outside this delegation API.

The runner accepts LF-delimited JSON with strict UTF-8 decoding.
Its limits are 256 KiB per record, 4,096 events, 8 MiB stdout, and 64 KiB stderr.
It caps returned text at 32 KiB and does not return raw stderr.
A successful result requires a settled final assistant message with `stopReason: "stop"`, the requested model, exit code zero, and verified cleanup.
Truncation is explicit. Tool details include identity, agent provenance, canonical cwd, outcome, limits, cleanup, diagnostics, and `usage: null`.
Child failures throw from `execute`, so Pi marks the tool result as an error.

Each extension instance admits one delegation at a time, including preparation and cleanup.
A concurrent request fails rather than waiting in a queue.
The host starts its 120-second deadline at admission, not at child startup.
User cancellation, the deadline, and Pi's `session_shutdown` hook all request cleanup.
Shutdown rejects new work and awaits the active delegation.

The runner creates a detached process group and polls `/bin/ps` on macOS and Linux for descendants and process identities.
It sends `SIGTERM` through the live direct child handle even if process observation fails.
After a one-second grace period, it sends `SIGKILL` to the still-live child handle, its safe initial group, and observed owned processes and groups.
An observed group remains owned only while a current member matches a recorded identity in that group, or the live direct child proves the initial group.
A stale group ID alone cannot establish ownership.
The runner then allows two seconds to verify cleanup.
It does not return while the direct child handle remains live, so an OS refusal to terminate the child can extend cleanup beyond these timers.
The execution deadline starts cancellation; it is not a hard bound on tool return time.

Observation failures, unsafe identities, and unverified cleanup fail the request and quarantine further delegation in that extension instance.
The runner removes temporary prompt files and listeners after cleanup.
macOS and Linux polling cannot guarantee containment of an unseen fast double-fork or cleanup after host `SIGKILL`.
Process-table snapshots and signals are not atomic, and `ps` start times have only second-level precision.
These checks do not provide adversarial process isolation.
Delegation rejects unsupported operating systems, including Windows.

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
A fake ExtensionAPI checks the single `registerTool` call and the `session_shutdown` hook, with no command gate.
They preserve genuine protocol identifiers such as review author `cursor` and `CURSOR_AUTOMATION_ID`.

The real Pi tests pack and move the package into an isolated profile.
They inspect provider requests for all eight commands, exact skill bodies, arguments, relocated paths, and the single declared extension tool.
A scripted real parent delegates a fixture read to a real child, receives the result, and runs harmless bash containing literal `git push` and `gh pr edit` text.
Other runs deny project agents and cwd changes before any child request, and prove that an empty-tools user override has no tools.
Production child requests lack `subagent`; process checks reject surviving observed descendants and leftover prompt files.
The packed execution tests cover reduced deadlines, one-at-a-time admission, depth rejection, fake `pi` in `PATH`, and parent `SIGTERM` and `SIGHUP` cleanup.
They retain the controlled detached-work test, which keeps ancestry visible long enough for polling.
Focused process tests cover continuous observation failure with a real stalled child and deterministic group-ID reuse.
The unchanged Phase 6 recursion fixture is an unsafe positive control, not the production delegation path.
The main delegation test retains its tarball and `run.json` under the artifact path printed in test output.
Other test profiles are removed.
Runtime tests copy only the pinned `yaml` dependency into the relocated package. Pi supplies its own host modules.
`skipLibCheck` skips defective third-party declarations in Pi's dependency tree; project TypeScript still uses strict checking.
They check duplicate-name diagnostics through Pi's resource-loader SDK because print-mode JSONL does not emit those warnings.
The deterministic provider runs on loopback and needs no provider credentials.
These checks prove content loading and real tool execution, not model compliance with the skill instructions.
