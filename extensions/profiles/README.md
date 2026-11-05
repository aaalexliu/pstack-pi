# Auth profiles (prototype)

Two prototypes that pick provider logins by folder, so chats under one folder use a second account. Neither is in the package manifest or the pack, so Pi loads them only when you pass one with `-e` or list it in `extensions` in `settings.json`. Load one, not both.

| File | How a profile changes the login | Model names |
| --- | --- | --- |
| `store-swap.ts` | Owned providers read `<agent dir>/pstack-pi/profiles/<name>/auth.json` before `auth.json` | Unchanged: `anthropic/claude-opus-5-5` |
| `virtual.ts` | `virtual/<id>` routes each request to `<provider>-<name>`, a second login of the same provider | `virtual/claude-opus-5-5`, plus `anthropic-<name>/...` |

## Config

`<agent dir>/pstack-pi/profiles.json`:

```json
{
  "profiles": {
    "radiance": { "dirs": ["~/dev/jxp/radiance"], "providers": ["anthropic"] }
  }
}
```

Without this file both prototypes do nothing. A malformed file disables every profile and says why at session start.

## How a session picks its profile

1. `PI_AUTH_PROFILE`, when a parent Pi started this process. The prototypes read it once per process.
2. The deepest `dirs` entry that contains the session folder, compared as real paths.
3. Otherwise no profile: the default logins.

Each session start, including `/new`, `/resume`, `/fork` and `/reload`, picks again and writes the result to `PI_AUTH_PROFILE`. The bash tool, `!` commands and pstack subagents inherit it, wherever they run.

A profile without its own login uses the default login, and the footer says so: `profile: radiance (default login: anthropic)`.

## store-swap.ts

- Log in with `/login anthropic` inside the profile folder. The login lands in the profile file, never in `auth.json`.
- Token refreshes write back to the file the login came from. `/logout` inside the profile removes only the profile login.
- It replaces the credential store on Pi's private `modelRegistry.runtime.credentials.store`, and puts the original back on `session_shutdown`. A Pi release that renames that field turns the prototype off with a warning; it does not break requests.

## virtual.ts

- Registers `virtual/<id>` for every built-in model of each profile provider when it loads, so `--model virtual/...` works in subagents.
- At each session start, registers `<provider>-<profile>` for every profile. It copies the composed provider, so pi-anthropic-auth's request shaping carries over. Log in with `/login anthropic-radiance`. Its API-key login uses only its own stored key, never `ANTHROPIC_API_KEY`.
- Uses only public Pi APIs (`registerVirtualModel`, `registerProvider`), and unregisters both on `session_shutdown`.
- Aliases appear only after session start, so `pi --list-models anthropic-radiance` and `--model anthropic-radiance/...` at startup do not find them.
- The quota footer and the `(sub)` tag do not show while a `virtual/*` model is selected.

## Verify

`tests/profiles/e2e/run.sh` runs both prototypes against real Pi and a loopback Anthropic stand-in that replies with the login it received. It uses throwaway agent folders and fake keys. It covers the profile folder, another folder, a profile with no login, an inherited profile in `/tmp`, an inherited `default`, and a pstack subagent run in `/tmp`.
