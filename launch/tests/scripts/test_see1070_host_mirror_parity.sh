#!/usr/bin/env bash
# SEE-1070 cleanup item 3: pin the mirror between the bash launcher's
# resolve_mcp_host() and mcp_client.mjs's detectWindowsHost(). Both resolve the
# endpoint the godot-mcp client connects to; if one side changes how it derives
# the host, the other must change with it or the launcher will probe a different
# host than the client dials.
#
# This is a consistency test (NO codegen): it runs the REAL source of both sides
# against identical controlled input (a mock `ip`), so any drift in either
# implementation trips a failure. detectWindowsHost() is not exported and the
# module pulls in @modelcontextprotocol/sdk, so we extract the function source
# and eval it with spawnSync injected rather than importing the module.
#
# Pinned, documented divergences (both resolve to loopback; not a bug):
#   - fallback string : bash -> "127.0.0.1" | mjs -> "localhost"
#   - gateway capture : bash sed [0-9.]+     | mjs regex \S+  (agree on IPv4)
# Both honor GODOT_HOST (bash inside resolve_mcp_host; mjs at the export site).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1070_host_mirror_parity.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCHER="$REPO_ROOT/launch/godot-mcp-launcher.sh"
MJS="$REPO_ROOT/.dev/godot-mcp/tests/e2e/godot-mcp/mcp_client.mjs"

PASS=0; FAIL=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sect() { echo; echo "===== $* ====="; }

[[ -f "$LAUNCHER" ]] || { echo "FATAL: $LAUNCHER not found" >&2; exit 2; }
[[ -f "$MJS" ]]      || { echo "FATAL: $MJS not found" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "FATAL: node not found" >&2; exit 2; }

TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# --- bash side: extract resolve_mcp_host() verbatim from the launcher ---------
# The function is self-contained (no log/die/external state), so sourcing the
# extracted body lets us call it under a controlled env + PATH.
BASH_FN="$TMPDIR/resolve_mcp_host.sh"
awk '/^resolve_mcp_host\(\) \{/ { in_fn=1 } in_fn { print } in_fn && /^\}/ { in_fn=0 }' \
    "$LAUNCHER" > "$BASH_FN"
grep -q '^resolve_mcp_host()' "$BASH_FN" || { echo "FATAL: could not extract resolve_mcp_host" >&2; exit 2; }

# $1 = PATH prefix dir (mock ip), $2 = "unset" or a GODOT_HOST value.
bash_resolve() {
    local path_prefix="$1" host="$2"
    if [[ "$host" == "unset" ]]; then
        env -u GODOT_HOST PATH="$path_prefix:$PATH" \
            bash -c 'source "$0"; resolve_mcp_host' "$BASH_FN"
    else
        env "GODOT_HOST=$host" PATH="$path_prefix:$PATH" \
            bash -c 'source "$0"; resolve_mcp_host' "$BASH_FN"
    fi
}

# --- mjs side: extract detectWindowsHost() source, eval with spawnSync ---------
MJS_HARNESS="$TMPDIR/run_detect.mjs"
cat > "$MJS_HARNESS" <<'NODE'
import { readFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");
const m = src.match(/^function detectWindowsHost\(\) \{[\s\S]*?^\}/m);
if (!m) { console.error("detectWindowsHost not found"); process.exit(2); }
// spawnSync is provided by the caller; the real function body runs unchanged.
const fn = new Function("spawnSync", m[0] + "\nreturn detectWindowsHost();");
process.stdout.write(fn((await import("node:child_process")).spawnSync) + "\n");
NODE

# detectWindowsHost() does not read GODOT_HOST (the override lives at the mjs
# export site, asserted structurally below); PATH carries the mock ip.
mjs_resolve() {
    env -u GODOT_HOST PATH="$1:$PATH" node "$MJS_HARNESS" "$MJS"
}

# --- mock ip: prints a controlled `ip route show default` line -----------------
make_mock_ip() {
    local dir="$1" line="$2"
    mkdir -p "$dir"
    cat > "$dir/ip" <<EOF
#!/usr/bin/env bash
printf '%s\n' "$line"
EOF
    chmod +x "$dir/ip"
}

# ---------------------------------------------------------------------------
# C1: gateway present => both resolve the via IP (the core mirror invariant)
# ---------------------------------------------------------------------------
sect "C1: gateway present => bash == mjs == via IP"
GW_DIR="$TMPDIR/gw"
make_mock_ip "$GW_DIR" "default via 172.20.0.1 dev eth0"
B1="$(bash_resolve "$GW_DIR" unset)"
M1="$(mjs_resolve "$GW_DIR")"
if [[ "$B1" == "172.20.0.1" ]]; then ok "bash resolved gateway 172.20.0.1"; else ko "bash gateway: expected 172.20.0.1, got '$B1'"; fi
if [[ "$M1" == "172.20.0.1" ]]; then ok "mjs resolved gateway 172.20.0.1"; else ko "mjs gateway: expected 172.20.0.1, got '$M1'"; fi
if [[ "$B1" == "$M1" ]]; then ok "C1 mirror holds: bash == mjs ('$B1')"; else ko "C1 mirror broken: bash='$B1' mjs='$M1'"; fi

# ---------------------------------------------------------------------------
# C2: no via in route output => pinned loopback divergence (127.0.0.1 vs localhost)
# ---------------------------------------------------------------------------
sect "C2: no gateway => pinned loopback divergence"
NOGW_DIR="$TMPDIR/nogw"
make_mock_ip "$NOGW_DIR" "default dev eth0"
B2="$(bash_resolve "$NOGW_DIR" unset)"
M2="$(mjs_resolve "$NOGW_DIR")"
if [[ "$B2" == "127.0.0.1" ]]; then ok "bash fallback is 127.0.0.1 (pinned)"; else ko "bash fallback drift: expected 127.0.0.1, got '$B2'"; fi
if [[ "$M2" == "localhost" ]]; then ok "mjs fallback is localhost (pinned)"; else ko "mjs fallback drift: expected localhost, got '$M2'"; fi

# ---------------------------------------------------------------------------
# C3: GODOT_HOST override => bash honors it inside resolve_mcp_host
# ---------------------------------------------------------------------------
sect "C3: GODOT_HOST override => bash honors it"
B3="$(bash_resolve "$GW_DIR" "10.0.0.5")"
if [[ "$B3" == "10.0.0.5" ]]; then ok "bash honors GODOT_HOST=10.0.0.5"; else ko "bash GODOT_HOST override: expected 10.0.0.5, got '$B3'"; fi

# ---------------------------------------------------------------------------
# C4: structural anchors => both sides implement the same 3-step algorithm
# ---------------------------------------------------------------------------
sect "C4: structural anchors present on both sides"
# bash: GODOT_HOST guard, ip route, via sed extraction, 127.0.0.1 fallback.
# 'via[[:space:]]' is matched as a fixed string (the literal sed fragment),
# not a regex bracket expression.
if grep -Fq '[[ -n "${GODOT_HOST:-}" ]]' "$LAUNCHER" \
   && grep -Fq 'ip route show default' "$LAUNCHER" \
   && grep -Fq 'via[[:space:]]' "$LAUNCHER" \
   && grep -Fq "printf '127.0.0.1" "$LAUNCHER"; then
    ok "launcher has GODOT_HOST/ip-route/via/127.0.0.1 anchors"
else
    ko "launcher missing a resolve_mcp_host anchor"
fi
# mjs: GODOT_HOST export, ip route spawn, via regex, localhost fallback, fn def.
if grep -q 'process.env.GODOT_HOST ?? detectWindowsHost()' "$MJS" \
   && grep -q '"ip", \["route", "show", "default"\]' "$MJS" \
   && grep -q 'via\\s+(\\S+)' "$MJS" \
   && grep -q 'return "localhost"' "$MJS" \
   && grep -q '^function detectWindowsHost()' "$MJS"; then
    ok "mjs has GODOT_HOST/ip-route/via/localhost anchors"
else
    ko "mjs missing a detectWindowsHost anchor"
fi
# Both honor GODOT_HOST (mirror at the env-override layer).
if grep -Fq '[[ -n "${GODOT_HOST:-}" ]]' "$LAUNCHER" \
   && grep -Fq 'process.env.GODOT_HOST ?? detectWindowsHost()' "$MJS"; then
    ok "both honor GODOT_HOST env override"
else
    ko "GODOT_HOST override mirror broken"
fi

# ---------------------------------------------------------------------------
# C5 (SEE-1152 目标3): proxy-side detectWindowsHost anchors — the proxy now
# auto-detects the WSL gateway when GODOT_HOST is unset (direct-spawn paths
# bypassing the launcher), mirroring resolve_mcp_host's ip-route/via/127.0.0.1
# algorithm. The env-override chain (GODOT_HOST || GODOT_HOSTNAME) must still
# take precedence.
# ---------------------------------------------------------------------------
sect "C5: proxy detectWindowsHost anchors (SEE-1152)"
PROXY="$REPO_ROOT/launch/godot-mcp-proxy.mjs"
if grep -q '^function detectWindowsHost()' "$PROXY" \
   && grep -q "execFileSync('ip', \['route', 'show', 'default'\]" "$PROXY" \
   && grep -q 'via\\s+(\\S+)' "$PROXY" \
   && grep -q "return '127.0.0.1'" "$PROXY" \
   && grep -q 'process.env.GODOT_HOST || process.env.GODOT_HOSTNAME || detectWindowsHost()' "$PROXY"; then
    ok "proxy has detectWindowsHost/ip-route/via/127.0.0.1 anchors + env override precedence"
else
    ko "proxy missing a detectWindowsHost anchor"
fi

# ---------------------------------------------------------------------------
echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL"
if [[ ${#FAILS[@]} -gt 0 ]]; then
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
echo "============================================================"

[[ $FAIL -eq 0 ]]
