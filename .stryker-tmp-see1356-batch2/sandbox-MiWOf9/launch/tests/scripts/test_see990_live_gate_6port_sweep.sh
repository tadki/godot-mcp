#!/usr/bin/env bash
# SEE-990 LIVE regression: 6-port wrapper gate sweep against REAL godot_mcp editors.
#
# Runs the shipped wrapper (godot-mcp-launcher.sh) with a mock npx on PATH against
# each per-agent port and verifies the gate reaches exec npx on every healthy
# editor. Captures the MCP/WS readiness gate timing logs (WS_DEADLINE /
# READY_TIMEOUT / phase2 probe count / phase2 final verdict) per port so the
# single-client fix (b5f8b43) can be proven end-to-end: the gate must reach
# exec instead of dying with the addon's 4001 single-client rejection.
#
# Per-agent port table: Atlas=6551 Archi=6552 Bachi=6553 Fronti=6554 Revy=6555 Refacty=6556
#
# Verdict per port: wrapper rc=0 AND mock npx saw GODOT_PORT  ->  PASS (reached exec)
# Also asserts: no KOL/godot schtasks residue after the sweep.
#
# Run:  bash .dev/godot-mcp/tests/scripts/test_see990_live_gate_6port_sweep.sh [outdir]
#        SEE990_SKIP_LIVE=1 bash ...   # skip when no live editors are available
#
# Requires: live godot_mcp editors listening on the 6 per-agent ports (the
# editors run on Windows; the wrapper resolves the WSL gateway IP itself).

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
LAUNCH_DIR="$REPO_ROOT/launch"
WRAPPER="$LAUNCH_DIR/godot-mcp-launcher.sh"

PASS=0; FAIL=0; SKIP=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sk() { echo "  [SKIP] $*"; SKIP=$((SKIP+1)); }

PORT_LABEL=( [6551]="Atlas" [6552]="Archi" [6553]="Bachi" [6554]="Fronti" [6555]="Revy" [6556]="Refacty" )
PORTS=(6551 6552 6553 6554 6555 6556)

OUTDIR="${1:-/tmp/see990_6port_sweep}"
mkdir -p "$OUTDIR"

if [[ "${SEE990_SKIP_LIVE:-0}" == "1" ]]; then
    echo "SEE990_SKIP_LIVE=1; 6-port live sweep bypassed"
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL SKIP=1"; exit 0
fi

[[ -f "$WRAPPER" ]] || { echo "FATAL: $WRAPPER not found" >&2; exit 2; }

TMPDIR="$(mktemp -d)"; trap 'rm -rf "$TMPDIR"' EXIT
MOCK_NPX_DIR="$TMPDIR/mock_npx"; mkdir -p "$MOCK_NPX_DIR"
cat > "$MOCK_NPX_DIR/npx" <<'MOCK'
#!/usr/bin/env bash
echo "MOCK_NPX_GODOT_PORT=${GODOT_PORT:-unset}"
MOCK
chmod +x "$MOCK_NPX_DIR/npx"

check_schtasks() {
    /mnt/c/Windows/System32/schtasks.exe /query /fo CSV /v 2>/dev/null | tr -d '\r' | grep -i 'KOL\|godot' | wc -l
}
overall_schtasks_before=$(check_schtasks)

# Per-port editor-presence pre-check (Windows side). The proxy bypasses a PATH
# mock via npx-cache direct resolution, so a port with NO live editor must be
# SKIPPED explicitly rather than misclassified as a wrapper FAIL. We ask Windows
# for a LISTENING socket on the MCP port; the editor is a Windows process.
POWERSHELL=""
if command -v powershell.exe >/dev/null 2>&1; then
    POWERSHELL="powershell.exe"
elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then
    POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
fi
port_listening_win() {
    local p="$1"
    [[ -n "${POWERSHELL:-}" ]] || return 2
    "$POWERSHELL" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null
}

for PORT in "${PORTS[@]}"; do
    LABEL="${PORT_LABEL[$PORT]}"
    WP="$OUTDIR/wrapper_${PORT}_${LABEL}"
    echo
    echo "===== $LABEL port $PORT ====="
    # Skip ports with no live editor; otherwise the wrapper's proxy spins on
    # warmup and the verdict is meaningless (not a wrapper defect).
    if ! port_listening_win "$PORT"; then
        sk "no live editor on port $PORT (skipped; not a wrapper defect)"
        continue
    fi
    # Force the proxy to spawn the PATH mock (KOL_GODOT_MCP_CMD=npx) and to NOT
    # auto-resolve the real cached package (KOL_DIRECT_GODOT_MCP=0). Otherwise
    # the launcher's npx-cache direct path bypasses the mock entirely and the
    # reached-exec probe can never fire.
    PATH="$MOCK_NPX_DIR:$PATH" KOL_GODOT_MCP_CMD=npx KOL_DIRECT_GODOT_MCP=0 \
        timeout 100 "$WRAPPER" --port "$PORT" >"${WP}.out" 2>"${WP}.err"
    WRC=$?
    grep -q "MOCK_NPX_GODOT_PORT" "${WP}.out" && REACHED=1 || REACHED=0
    READY_DEADLINE=$(grep -oE "ready deadline [0-9]+s" "${WP}.err" | head -1)
    WS_DEADLINE=$(grep -oE "ws deadline [0-9]+s" "${WP}.err" | head -1)
    SWAP_RESIZE=$(grep -oE "swap_chain_resize count=[0-9]+" "${WP}.err" | tail -1)
    PROBE_COUNT=$(grep -cE "^\[mcp-ready-probe\]" "${WP}.err" 2>/dev/null || echo 0)
    PHASE1=$(grep -E "MCP/WS responsive|MCP/WS not responsive" "${WP}.err" | tail -1)
    PHASE2=$(grep -E "MCP/WS editor ready|MCP/WS became unresponsive|editor/project not ready" "${WP}.err" | tail -1)
    echo "  rc=$WRC reached_exec=$REACHED  ($WS_DEADLINE ; $READY_DEADLINE ; probe_lines=$PROBE_COUNT)"
    echo "  $SWAP_RESIZE"
    echo "  phase1: $PHASE1"
    echo "  phase2: $PHASE2"
    if (( WRC == 0 && REACHED == 1 )); then
        ok "$LABEL:$PORT wrapper reached exec npx (rc=0)"
    else
        ko "$LABEL:$PORT wrapper did NOT reach exec npx (rc=$WRC)"
    fi
done

overall_schtasks_after=$(check_schtasks)
echo
if (( overall_schtasks_after == 0 )); then
    ok "No KOL/godot schtasks residue (before=$overall_schtasks_before, after=$overall_schtasks_after)"
else
    ko "KOL/godot schtasks residue detected (before=$overall_schtasks_before, after=$overall_schtasks_after)"
fi

echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ ${#FAILS[@]} -gt 0 ]] && { echo "FAILURES:"; for f in "${FAILS[@]}"; do echo "  - $f"; done; }
echo "Per-port logs saved in: $OUTDIR"
echo "============================================================"
[[ $FAIL -eq 0 ]]
