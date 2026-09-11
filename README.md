# pstack for Pi

## Package identity

`@aaalexliu/pstack-pi` lives at [aaalexliu/pstack-pi](https://github.com/aaalexliu/pstack-pi).
Its version starts at `0.1.0` and follows independent SemVer, not Cursor plugin versions.

This phase contains package metadata and provenance only.
There are no extensions, skills, prompts, themes, agents, runtime tools, or sync commands.
The package declares empty Pi resource arrays and ships only `package.json`, `README.md`, and `LICENSE`.

The declared host is Pi `0.85.1`, with Node.js `>=22.19.0`.
`engines.pi` records that version but does not enforce it through npm.
This phase does not establish runtime compatibility.

## Installation scope

A local checkout can be registered with `pi install /absolute/path/to/pstack-pi`.
Pi records it in the user profile by default.
Adding `-l` records it in the current project's settings instead.
Neither scope loads any resources from this empty package.
These instructions do not assume an npm release exists.

## Upstream provenance

[Lauren Tan's pstack in cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack)
is the sole upstream source for shared workflow content in the planned port.
The [MIT license](LICENSE) preserves Lauren Tan's notice without changes.
No workflow source snapshot has been imported or pinned in this phase.

[0xrsydn/pstack-pi](https://github.com/0xrsydn/pstack-pi) and
[kkgogogo17/pi-pstack](https://github.com/kkgogogo17/pi-pstack) are implementation references,
not upstream sources for shared content.

The ownership model separates Cursor workflow content from Pi-specific adaptations and runtime code.
The `aaalexliu/pstack-pi` project owns the package metadata and any future Pi-specific code.
Those adaptations and runtime code do not exist yet.
