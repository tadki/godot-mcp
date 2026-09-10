#!/usr/bin/env bash
# SEE-1070 Stage 3 #1 — proxy default-port guard + 6550 literal structural scan.
#
# Two halves:
#
#   A) Behavioral: the proxy must REFUSE to start on the shared default port
#      (GODOT_PORT=6550) unless --allow-default is passed, and must still start
#      on a normal per-agent port. This makes a missing per-agent allocation
#      (agent-ports.json never applied) fail LOUD instead of silently colliding
#      on the bridge's single WS slot with every other default client.
#
#   B) Structural: scan the port-resolution code for hardcoded 6550 literals.
#      Full-line comments (# and //) are stripped first, so documentation
#      mentions never trip the guard; only live code is scanned. The only
#      allowed live-code reference is the proxy's own `DEFAULT_PORT = 6550`
#      guard constant. (SEE-1240 WS-1: agent-ports.json no longer holds a
#      default_port field — dead config removed; the addon hardcodes its own
#      DEFAULT_PORT=6550.)
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1070_proxy_default_port_guard.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROXY="$REPO_ROOT/launch/godot-mcp-proxy.mjs"

[[ -f "$PROXY" ]] || { echo "FATAL: $PROXY not found" >&2; exit 2; }

PASS=0; FAIL=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sep() { echo; echo "================================================================"; echo "$*"; echo "================================================================"; }

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# --- A) Behavioral port guard ----------------------------------------------
# Run the proxy for a bounded window; it either exits fast (guard rejected) or
# stays alive past the guard (we then kill it via timeout). A port that passes
# the guard logs the "starting; GODOT_HOST=..." line and keeps running.
run_proxy() { # $1=port  $2=extra-arg  $3=timeout  → prints rc, logs to $TMPDIR/run.err
    local port="$1" arg="$2" secs="$3"
    GODOT_PORT="$port" timeout "$secs" node "$PROXY" $arg </dev/null >"$TMPDIR/run.out" 2>"$TMPDIR/run.err"
    echo $?
}

sep "A) Behavioral: proxy default-port guard"

# A1 — GODOT_PORT=6550, no --allow-default → must exit non-zero with the guard error.
rc="$(run_proxy 6550 '' 5)"
if [[ "$rc" != "124" && "$rc" != "0" ]] && grep -q 'shared default port; refusing to start' "$TMPDIR/run.err"; then
    ok "A1: GODOT_PORT=6550 without --allow-default → rejected (rc=$rc) with guard error"
else
    ko "A1: GODOT_PORT=6550 should be rejected; rc=$rc, stderr=$(grep -m1 . "$TMPDIR/run.err")"
fi

# A2 — GODOT_PORT=6550 + --allow-default → passes the guard (keeps running past it).
rc="$(run_proxy 6550 '--allow-default' 3)"
if grep -q 'starting; GODOT_HOST=' "$TMPDIR/run.err" && ! grep -q 'refusing to start' "$TMPDIR/run.err"; then
    ok "A2: GODOT_PORT=6550 with --allow-default → guard bypassed, proxy started (rc=$rc)"
else
    ko "A2: --allow-default should bypass the guard; rc=$rc, stderr=$(grep -m1 . "$TMPDIR/run.err")"
fi

# A3 — GODOT_PORT unset → parses to 0, caught by the existing isValidPort check.
rc="$(run_proxy '' '' 5)"
if [[ "$rc" != "124" && "$rc" != "0" ]] && grep -q 'must be set to a valid port' "$TMPDIR/run.err"; then
    ok "A3: GODOT_PORT unset → rejected by isValidPort (rc=$rc)"
else
    ko "A3: unset GODOT_PORT should be rejected by isValidPort; rc=$rc, stderr=$(grep -m1 . "$TMPDIR/run.err")"
fi

# A4 — a normal per-agent port (e.g. 6556) → passes the guard.
rc="$(run_proxy 6556 '' 3)"
if grep -q 'starting; GODOT_HOST=' "$TMPDIR/run.err" && ! grep -q 'refusing to start' "$TMPDIR/run.err"; then
    ok "A4: GODOT_PORT=6556 (per-agent) → guard passed, proxy started (rc=$rc)"
else
    ko "A4: a per-agent port should pass the guard; rc=$rc, stderr=$(grep -m1 . "$TMPDIR/run.err")"
fi

# --- B) Structural: 6550 literal scan --------------------------------------
# Strip full-line comments (lines whose first non-space char is # or //) so
# prose references never trip the guard, then forbid any remaining 6550 in
# live code — except the proxy's intentional `DEFAULT_PORT = 6550` constant.
sep "B) Structural: 6550 literal scan (comments stripped)"

DENY_FILES=(
    "launch/godot-mcp-launcher.sh"
    "launch/configure-mcp-port.sh"
    "launch/start-godot-editor.sh"
    "launch/agent-ports.lib.sh"
    "launch/godot-mcp-proxy.mjs"
    ".dev/godot-mcp/tests/e2e/godot-mcp/mcp_client.mjs"
)

structural_fail=0
for rel in "${DENY_FILES[@]}"; do
    f="$REPO_ROOT/$rel"
    if [[ ! -f "$f" ]]; then
        echo "  [SKIP] $rel not present"
        continue
    fi
    # 1. drop full-line comments (first non-space char # or //)
    # 2. drop the proxy's intentional DEFAULT_PORT = 6550 guard constant
    # 3. anything left mentioning 6550 is a forbidden hardcoded literal
    offenders="$(grep -vE '^[[:space:]]*(#|//)' "$f" | grep -vE 'DEFAULT_PORT[[:space:]]*=[[:space:]]*6550' | grep -n '6550' || true)"
    if [[ -n "$offenders" ]]; then
        structural_fail=1
        echo "  [FAIL] $rel has hardcoded 6550 in live code:"
        echo "$offenders" | sed 's/^/         /'
    else
        echo "  [ ok ] $rel clean"
    fi
done
if [[ "$structural_fail" -eq 0 ]]; then
    ok "B1: no forbidden hardcoded 6550 literal in port-resolution code (comments stripped)"
else
    ko "B1: forbidden hardcoded 6550 literal(s) found (see above)"
fi

# B2 — sanity: the one place that legitimately holds 6550 is still there,
# proving the scan isn't a no-op that would pass an empty file.
# SEE-1240 WS-1: agent-ports.json no longer carries default_port (dead config
# removed — the addon hardcodes DEFAULT_PORT=6550 itself). The proxy guard
# constant is the single legitimate live-code reference.
if grep -qE 'DEFAULT_PORT[[:space:]]*=[[:space:]]*6550' "$PROXY"; then
    ok "B2: allowed reference intact (proxy DEFAULT_PORT guard; agent-ports.json default_port retired by SEE-1240 WS-1)"
else
    ko "B2: expected 6550 in the proxy DEFAULT_PORT guard — scan may be blind"
fi

echo
if [[ $FAIL -eq 0 ]]; then
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
else
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
