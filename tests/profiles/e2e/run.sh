#!/usr/bin/env bash
# Manual end-to-end check of both auth profile prototypes against real Pi (1.x, which has
# virtual models) and a loopback Anthropic stand-in. Uses throwaway agent folders and
# fake keys; never reads ~/.pi/agent.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
root="$(mktemp -d "${TMPDIR:-/tmp}/pstack-profiles-e2e.XXXXXX")"
port="${PROFILES_E2E_PORT:-47811}"
mock=""
failures=0

cleanup() {
  [ -n "$mock" ] && kill "$mock" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

mkdir -p "$root/work/radiance/repo" "$root/work/nologin" "$root/work/other"

start_mock() {
  [ -n "$mock" ] && kill "$mock" 2>/dev/null || true
  : > "$root/requests.log"
  CHILD_MODEL="$1" node "$repo/tests/profiles/e2e/mock-anthropic.mjs" "$port" "$root/requests.log" &
  mock=$!
  sleep 1
}

agent() {
  local proto="$1" provider="$2" dir="$root/agent-$1"
  mkdir -p "$dir/pstack-pi"
  printf '{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:%s"}}}\n' "$port" > "$dir/models.json"
  printf '{"profiles":{"radiance":{"dirs":["%s"],"providers":["anthropic"]},"nologin":{"dirs":["%s"],"providers":["anthropic"]}}}\n' \
    "$root/work/radiance" "$root/work/nologin" > "$dir/pstack-pi/profiles.json"
  printf '{"extensions":["%s","%s"],"defaultProvider":"%s","defaultModel":"claude-haiku-5-5","defaultThinkingLevel":"off","quietStartup":true,"enableInstallTelemetry":false}\n' \
    "$repo/extensions/profiles/$proto.ts" "$repo/extensions/subagent/index.ts" "$provider" > "$dir/settings.json"
}

agent store-swap anthropic
printf '{"anthropic":{"type":"api_key","key":"sk-ant-api03-DEFAULT"}}\n' > "$root/agent-store-swap/auth.json"
mkdir -p "$root/agent-store-swap/pstack-pi/profiles/radiance"
printf '{"anthropic":{"type":"api_key","key":"sk-ant-api03-RADIANCE"}}\n' > "$root/agent-store-swap/pstack-pi/profiles/radiance/auth.json"

agent virtual virtual
printf '{"anthropic":{"type":"api_key","key":"sk-ant-api03-DEFAULT"},"anthropic-radiance":{"type":"api_key","key":"sk-ant-api03-RADIANCE"}}\n' > "$root/agent-virtual/auth.json"

chmod 600 "$root"/agent-*/auth.json "$root/agent-store-swap/pstack-pi/profiles/radiance/auth.json"

# expect <proto> <cwd> <inherited profile or -> <prompt> <expected last line>
expect() {
  local proto="$1" cwd="$2" inherited="$3" prompt="$4" want="$5" got
  local env=(env -u PI_AUTH_PROFILE "PI_CODING_AGENT_DIR=$root/agent-$proto" PI_OFFLINE=1)
  [ "$inherited" != - ] && env+=("PI_AUTH_PROFILE=$inherited")
  got="$(cd "$cwd" && "${env[@]}" pi -p --no-session "$prompt" 2>&1 | tail -n 1)"
  if [ "$got" = "$want" ]; then
    printf 'pass  %-10s %-34s %-8s %s\n' "$proto" "${cwd#"$root"/}" "$inherited" "$got"
  else
    printf 'FAIL  %-10s %-34s %-8s want %s, got %s\n' "$proto" "${cwd#"$root"/}" "$inherited" "$want" "$got"
    failures=$((failures + 1))
  fi
}

for proto in store-swap virtual; do
  if [ "$proto" = virtual ]; then start_mock virtual/claude-haiku-5-5; else start_mock anthropic/claude-haiku-5-5; fi
  expect "$proto" "$root/work/radiance/repo" - hi key=radiance
  expect "$proto" "$root/work/other" - hi key=default
  expect "$proto" "$root/work/nologin" - hi key=default
  expect "$proto" /tmp radiance hi key=radiance
  expect "$proto" "$root/work/radiance/repo" default hi key=default
  expect "$proto" "$root/work/radiance/repo" - DELEGATE "parent-after-subagent key=radiance"
  child="$(tail -n 2 "$root/requests.log" | head -n 1)"
  case "$child" in
    *'"label":"radiance"'*) printf 'pass  %-10s subagent child in /tmp used radiance\n' "$proto" ;;
    *) printf 'FAIL  %-10s subagent child: %s\n' "$proto" "$child"; failures=$((failures + 1)) ;;
  esac
done

[ ! -e "$root/agent-store-swap/pstack-pi/profiles/nologin" ] || { echo 'FAIL  store-swap created a profile file without a login'; failures=$((failures + 1)); }
echo "$failures failure(s)"
exit $((failures > 0))
