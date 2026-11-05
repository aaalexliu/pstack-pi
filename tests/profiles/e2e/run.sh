#!/usr/bin/env bash
# Manual end-to-end check of the auth profiles extension against real Pi and a loopback
# Anthropic stand-in. Uses a throwaway agent folder and fake keys; never reads ~/.pi/agent.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
root="$(mktemp -d "${TMPDIR:-/tmp}/pstack-profiles-e2e.XXXXXX")"
agent="$root/agent"
port="${PROFILES_E2E_PORT:-47811}"
mock=""
failures=0

cleanup() {
  [ -n "$mock" ] && kill "$mock" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

mkdir -p "$root/work/client-a/repo" "$root/work/nologin" "$root/work/other" "$agent/pstack-pi/profiles/client-a"
printf '{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:%s"}}}\n' "$port" > "$agent/models.json"
printf '{"profiles":{"client-a":{"dirs":["%s"],"providers":["anthropic"]},"nologin":{"dirs":["%s"],"providers":["anthropic"]}}}\n' \
  "$root/work/client-a" "$root/work/nologin" > "$agent/pstack-pi/profiles.json"
printf '{"extensions":["%s","%s"],"defaultProvider":"anthropic","defaultModel":"claude-haiku-5-5","defaultThinkingLevel":"off","quietStartup":true,"enableInstallTelemetry":false}\n' \
  "$repo/extensions/profiles/index.ts" "$repo/extensions/subagent/index.ts" > "$agent/settings.json"
printf '{"anthropic":{"type":"api_key","key":"sk-ant-api03-DEFAULT"}}\n' > "$agent/auth.json"
printf '{"anthropic":{"type":"api_key","key":"sk-ant-api03-CLIENT_A"}}\n' > "$agent/pstack-pi/profiles/client-a/auth.json"
chmod 600 "$agent/auth.json" "$agent/pstack-pi/profiles/client-a/auth.json"

: > "$root/requests.log"
CHILD_MODEL=anthropic/claude-haiku-5-5 node "$repo/tests/profiles/e2e/mock-anthropic.mjs" "$port" "$root/requests.log" &
mock=$!
sleep 1

# expect <cwd> <inherited profile or -> <prompt> <expected last line>
expect() {
  local cwd="$1" inherited="$2" prompt="$3" want="$4" got
  local env=(env -u PI_AUTH_PROFILE "PI_CODING_AGENT_DIR=$agent" PI_OFFLINE=1)
  [ "$inherited" != - ] && env+=("PI_AUTH_PROFILE=$inherited")
  got="$(cd "$cwd" && "${env[@]}" pi -p --no-session "$prompt" 2>&1 | tail -n 1)"
  if [ "$got" = "$want" ]; then
    printf 'pass  %-34s %-8s %s\n' "${cwd#"$root"/}" "$inherited" "$got"
  else
    printf 'FAIL  %-34s %-8s want %s, got %s\n' "${cwd#"$root"/}" "$inherited" "$want" "$got"
    failures=$((failures + 1))
  fi
}

expect "$root/work/client-a/repo" - hi key=client-a
expect "$root/work/other" - hi key=default
expect "$root/work/nologin" - hi key=default
expect /tmp client-a hi key=client-a
expect "$root/work/client-a/repo" default hi key=default
expect "$root/work/client-a/repo" - DELEGATE "parent-after-subagent key=client-a"
child="$(tail -n 2 "$root/requests.log" | head -n 1)"
case "$child" in
  *'"label":"client-a"'*) echo 'pass  subagent child in /tmp used client-a' ;;
  *) echo "FAIL  subagent child: $child"; failures=$((failures + 1)) ;;
esac

[ ! -e "$agent/pstack-pi/profiles/nologin" ] || { echo 'FAIL  created a profile file without a login'; failures=$((failures + 1)); }
echo "$failures failure(s)"
exit $((failures > 0))
