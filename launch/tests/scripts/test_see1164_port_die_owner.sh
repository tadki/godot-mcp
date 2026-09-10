#!/usr/bin/env bash
# test_see1164_port_die_owner.sh
#
# SEE-1164 改进 2 — when start-godot-editor.sh's port_in_use check fires, the
# die message must carry the Windows-side owner of the bound port
# (Get-NetTCPConnection OwningProcess PID + process name + start time), so a
# post-mortem investigator can distinguish "another live runtime holds the
# port" from "orphan Listen socket left over from a reboot".
#
# Test seam: the script resolves POWERSHELL via `command -v powershell.exe` —
# we drop a mock `powershell.exe` shim on PATH that
#   (a) returns success (exit 0) for the `port_in_use` probe (simulating a
#       Listen socket on the port), and
#   (b) prints a fabricated "pid=4242 name=Godot start=..." line for the
#       forensic `Get-NetTCPConnection | Select-Object OwningProcess` call.
# Then we run start-godot-editor.sh against a real free port and a mock editor
# binary; the die should fire and stderr should contain the PID + name.
#
# Assertions:
#   B1  script exits non-zero (port_in_use triggered the die).
#   B2  stderr contains "Port <N> is already in use".
#   B3  stderr contains the OwningProcess PID ("pid=4242").
#   B4  stderr contains the owning process name ("name=Godot").
#   B5  port_in_use() semantics are unchanged — a free port + the SAME mock
#       PowerShell (returning no Listen rows for the probe) must NOT die.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1164_port_die_owner.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
START_SH="$REPO_ROOT/launch/start-godot-editor.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
PASS=0; FAIL=0; FAILS=()
ok()  { echo -e "  ${GREEN}[PASS]${NC} $*"; PASS=$((PASS+1)); }
ko()  { echo -e "  ${RED}[FAIL]${NC} $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sep() { echo; echo -e "${CYAN}--- $* ---${NC}"; }

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# --- Mock powershell.exe ---------------------------------------------------
# $1 = mode: "hit" (probe says port is bound) or "miss" (probe says free).
# The forensic Get-NetTCPConnection call (with Select-Object) prints a
# fabricated owner row regardless of mode; the die branch only invokes it
# after port_in_use has already returned true, so a "miss" run never reaches
# the forensic call.
MOCK_BIN="$TMPDIR_TEST/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/powershell.exe" <<'EOF'
#!/usr/bin/env bash
# Read the full -Command payload from args.
cmd=""
prev=""
for a in "$@"; do
    if [[ "$prev" == "-Command" ]]; then cmd="$a"; break; fi
    prev="$a"
done
# Forensic call: contains Select-Object. Print a fabricated owner row.
if [[ "$cmd" == *"Select-Object"* ]]; then
    echo "pid=4242 name=Godot start=2026-08-20T10:00:00+00:00"
    exit 0
fi
# Probe call: simulate "port is in use" iff MOCK_MODE=hit.
if [[ "${MOCK_MODE:-miss}" == "hit" ]]; then
    exit 0   # Get-NetTCPConnection returned a row → port_in_use true
else
    exit 1   # no rows → port_in_use false
fi
EOF
chmod +x "$MOCK_BIN/powershell.exe"

# --- Mock godot editor binary (must exist; the port die fires before launch).
MOCK_EDITOR="$TMPDIR_TEST/Godot.exe"
cat > "$MOCK_EDITOR" <<'EOF'
#!/usr/bin/env bash
echo "mock godot ran"
EOF
chmod +x "$MOCK_EDITOR"

# --- Mock worktree with project.godot.
MOCK_WT="$TMPDIR_TEST/wt"
mkdir -p "$MOCK_WT"
cat > "$MOCK_WT/project.godot" <<'EOF'
config_version=5

[godot_mcp]

port_override_enabled=false
port_override=6550
EOF

PORT=17878   # arbitrary; we never actually bind it — the mock PS fabricates the answer

sep "SEE-1164 B1-B4: port_in_use die carries OwningProcess PID + name + start"
set +e
OUT=$(env \
    "PATH=$MOCK_BIN:/usr/bin:/bin" \
    "MOCK_MODE=hit" \
    "HOME=$TMPDIR_TEST/home" \
    "KOL_RUNTIME_ID=bachi-test1164" \
    bash "$START_SH" Bachi --port "$PORT" --worktree "$MOCK_WT" --editor "$MOCK_EDITOR" --foreground 2>&1)
RC=$?
set -e

if (( RC != 0 )); then
    ok "B1: start-godot-editor.sh exited non-zero on port_in_use (rc=$RC)"
else
    ko "B1: expected non-zero exit on port_in_use; got rc=$RC; out=$OUT"
fi

if grep -q "Port ${PORT} is already in use" <<<"$OUT"; then
    ok "B2: die message names the port"
else
    ko "B2: die message missing port; out=$OUT"
fi

if grep -q "pid=4242" <<<"$OUT"; then
    ok "B3: die message carries OwningProcess PID (pid=4242)"
else
    ko "B3: OwningProcess PID missing from die; out=$OUT"
fi

if grep -q "name=Godot" <<<"$OUT"; then
    ok "B4: die message carries owning process name (name=Godot)"
else
    ko "B4: process name missing from die; out=$OUT"
fi

sep "SEE-1164 B5: port_in_use semantics unchanged — free port does NOT die"
# Mock PS now says "no Listen rows" → port_in_use returns false → script must
# NOT die at the port check. It will then try to spawn; the mock editor exits
# immediately, which is fine (we only care that the die at L430 did NOT fire).
set +e
OUT2=$(env \
    "PATH=$MOCK_BIN:/usr/bin:/bin" \
    "MOCK_MODE=miss" \
    "HOME=$TMPDIR_TEST/home" \
    "KOL_RUNTIME_ID=bachi-test1164-miss" \
    timeout 5 bash "$START_SH" Bachi --port "$PORT" --worktree "$MOCK_WT" --editor "$MOCK_EDITOR" --foreground 2>&1)
RC2=$?
set -e

if grep -q "Port ${PORT} is already in use" <<<"$OUT2"; then
    ko "B5: free-port run unexpectedly hit port_in_use die (semantics regressed); out=$OUT2"
else
    ok "B5: free-port run did NOT die at port_in_use (semantics preserved)"
fi

sep "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
if (( FAIL == 0 )); then
    echo -e "${GREEN}RESULT: ALL GREEN.${NC} SEE-1164 改进 2 behaves per spec."
    exit 0
else
    echo -e "${RED}RESULT: RED.${NC} ${FAIL} assertion(s) failing:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
