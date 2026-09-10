#!/usr/bin/env bash
# QA test for SEE-976 MCP multi-port scripts + doc.
#
# Rewritten under SEE-1242 batch A-3 (per Archi's per-item verdict table):
# configure-mcp-port.sh has migrated to the sidecar lease (SEE-1117 Direction
# 3 — it no longer edits project.godot), PID resolution is asynchronous
# (schtasks background resolver writes "pending" then the real Windows PID),
# and same-runtime relaunch on a bound port is legitimate reuse under the
# SEE-1129 decision tree. The former Phase-1 assertions grepping project.godot
# for port_override / expecting hard relaunch rejection / asserting a
# origin/master..HEAD feature-branch diff scope are retired or re-pointed.
#
# Oracle: mcp-sidecar.lib.sh sidecar_get (state/port/lease_id/runtime_id).
# mcp-marker-section.lib.sh marker functions are dead code and are NOT used.
#
# Covers (each block producing PASS/FAIL verdicts):
#   1. launch/configure-mcp-port.sh  -- sidecar lease write
#      (agent table / --port / KOL_* env / precedence / idempotency), errors,
#      --help, and the project.godot byte-identical invariant
#   2. launch/start-godot-editor.sh  -- port parse, errors,
#      *real* launch, async pid resolution, log listening, SEE-1129 relaunch
#      semantics (same agent -> reuse rc=0)
#   3. .dev/godot-mcp/docs/mcp-multi-port-usage.md -- 6 sections, 6-row owner
#      checklist, lowercase-label detail, consistency with script behavior
#   4. regression -- the SEE-976 file set still exists at HEAD; existing
#      scripts untouched
#
# The pure-logic tests (blocks 1, parts of 2) run against throwaway copies of
# project.godot so the real worktree is never polluted. The E2E launch test
# (block 2) uses the real worktree with the Revy port (6555); the Godot editor
# it launches is taskkill'd before the script exits via trap. project.godot is
# never written (configure is sidecar-only), but the trap still restores it to
# HEAD as a safety net.
#
# Run:  bash .dev/godot-mcp/tests/scripts/test_see976_mcp_multi_port.sh
#        SEE976_SKIP_E2E=1 bash ...   # skip the real-launch E2E on envs w/o interop

set -uo pipefail

# Locate repo root (this script lives in .dev/godot-mcp/tests/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/launch"
DOC_FILE="$REPO_ROOT/.dev/godot-mcp/docs/mcp-multi-port-usage.md"
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"
STARTER="$LAUNCH_DIR/start-godot-editor.sh"
REAL_PROJECT_GODOT="$REPO_ROOT/project.godot"

POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
TASKKILL="/mnt/c/Windows/System32/taskkill.exe"
[[ -x "$POWERSHELL" ]] || POWERSHELL=""
[[ -x "$TASKKILL" ]] || TASKKILL=""

# Counters.
PASS=0
FAIL=0
SKIP=0
FAILS=()

ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko()   { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sk()   { echo "  [SKIP] $*"; SKIP=$((SKIP+1)); }
sect() { echo; echo "===== $* ====="; }

# Used to clean up a launched editor across the whole script.
LAUNCHED_PID=""
cleanup() {
    if [[ -n "$LAUNCHED_PID" ]]; then
        echo "[cleanup] killing launched editor PID $LAUNCHED_PID"
        if [[ -n "$TASKKILL" ]]; then
            "$TASKKILL" /PID "$LAUNCHED_PID" /F >/dev/null 2>&1 || true
        fi
    fi
    # Always restore the real project.godot so we never leave the branch dirty.
    git -C "$REPO_ROOT" checkout -- project.godot >/dev/null 2>&1 || true
}
trap cleanup EXIT

require() {
    local f="$1"
    if [[ ! -f "$f" ]]; then
        echo "FATAL: required file missing: $f" >&2
        exit 2
    fi
}

require "$CONFIGURE"
require "$STARTER"
require "$DOC_FILE"
require "$REAL_PROJECT_GODOT"

# Sidecar oracle (SEE-1242 A-3 unified oracle: mcp-sidecar.lib.sh sidecar_get).
# Caller must define die() for the sidecar lib.
die() { echo "FATAL: $*" >&2; exit 2; }
# shellcheck source=../../../launch/mcp-sidecar.lib.sh
source "$LAUNCH_DIR/mcp-sidecar.lib.sh"

# Read a sidecar field through the unified oracle. Empty string on missing
# file / field / malformed JSON.
sc_get() { sidecar_get "$1" "$2"; }

# Make a throwaway project.godot from the real one for logic tests.
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"; cleanup' EXIT
TEST_PG="$TMPDIR_T/project.godot"
cp "$REAL_PROJECT_GODOT" "$TEST_PG"

echo "repo:        $REPO_ROOT"
echo "HEAD:        $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
echo "test pg:     $TEST_PG"
echo "powershell:  ${POWERSHELL:-<none>}"

#############################################################################
# BLOCK 1: configure-mcp-port.sh
#############################################################################
sect "BLOCK 1: configure-mcp-port.sh"

# 1.1 --help
if bash "$CONFIGURE" --help >/dev/null 2>&1; then
    if bash "$CONFIGURE" --help 2>&1 | grep -qi "Usage:"; then ok "--help exits 0 and shows Usage"
    else ko "--help output missing 'Usage:'"; fi
else ko "--help did not exit 0"; fi

# 1.2 positional agent name -> sidecar lease with correct port, project.godot
# untouched (byte-identical) and bind keys preserved.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
TEST_SC="$(sidecar_path_for "$TEST_PG")"
rm -f "$TEST_SC"
# Byte-snapshot project.godot so we can prove configure never edits it.
pg_snapshot="$TMPDIR_T/pg-before-1.2"
cp "$TEST_PG" "$pg_snapshot"
input_section_before=$(awk '/^\[input\]/{p=1} p' "$TEST_PG")
if KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" Bachi >/dev/null 2>&1; then
    sc_state=$(sc_get "$TEST_SC" state)
    sc_port=$(sc_get "$TEST_SC" port)
    sc_lid=$(sc_get "$TEST_SC" lease_id)
    if [[ "$sc_state" == "active" && "$sc_port" == "6553" ]]; then ok "Bachi -> sidecar state=active port=6553"
    else ko "Bachi: expected sidecar active/6553, got state=$sc_state port=$sc_port"; fi
    [[ -n "$sc_lid" ]] && ok "sidecar lease_id non-empty" || ko "sidecar lease_id empty"
    # project.godot byte-identical invariant (A-3 ruling: this is the only
    # project.godot assertion see976 carries — the always-clean invariant
    # itself lives in the test_see1070 stop-hook suite).
    diff -q "$pg_snapshot" "$TEST_PG" >/dev/null 2>&1 \
        && ok "project.godot byte-identical after configure" \
        || ko "configure modified project.godot (sidecar-only contract violated)"
    # bind keys still present and untouched (they live in project.godot's
    # static [godot_mcp] section — deployment-topology constants).
    grep -qE '^bind_mode=' "$TEST_PG" && ok "bind_mode still present" || ko "bind_mode missing after configure"
    grep -qE '^custom_bind_ip=' "$TEST_PG" && ok "custom_bind_ip still present" || ko "custom_bind_ip missing after configure"
    # [input] section untouched.
    input_section_after=$(awk '/^\[input\]/{p=1} p' "$TEST_PG")
    [[ "$input_section_before" == "$input_section_after" ]] && ok "[input] section untouched" || ko "[input] section changed"
else ko "configure Bachi failed (non-zero exit)"; fi

# 1.3 all 6 agents resolve to their table port (sidecar oracle).
declare -A EXPECT=( [Atlas]=6551 [Archi]=6552 [Bachi]=6553 [Fronti]=6554 [Revy]=6555 [Refacty]=6556 )
for a in Atlas Archi Bachi Fronti Revy Refacty; do
    cp "$REAL_PROJECT_GODOT" "$TEST_PG"
    sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
    if KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" "$a" >/dev/null 2>&1; then
        got=$(sc_get "$sc" port)
        got_state=$(sc_get "$sc" state)
        [[ "$got" == "${EXPECT[$a]}" && "$got_state" == "active" ]] \
            && ok "agent table: $a -> sidecar ${EXPECT[$a]}" \
            || ko "agent table: $a -> expected sidecar ${EXPECT[$a]}/active, got port=$got state=$got_state"
    else ko "agent table: $a configure failed"; fi
done

# 1.4 explicit --port.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
if KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" --port 6551 >/dev/null 2>&1; then
    got=$(sc_get "$sc" port)
    [[ "$got" == "6551" ]] && ok "--port 6551 -> sidecar port=6551" || ko "--port 6551 got sidecar port '$got'"
else ko "--port 6551 failed"; fi

# 1.5 sidecar absent -> configure creates a complete lease record. Use a
# throwaway worktree dir (a copy of the real project.godot) with NO .godot/
# sidecar, and prove configure writes a full-v2 record there. (--port-only
# runs legitimately leave agent/label "" per the sidecar schema.)
WT_NOSEC="$TMPDIR_T/nosec-wt"
mkdir -p "$WT_NOSEC"
cp "$REAL_PROJECT_GODOT" "$WT_NOSEC/project.godot"
SC_NOSEC="$WT_NOSEC/.godot/mcp-lease.json"
rm -f "$SC_NOSEC"
if [[ -e "$SC_NOSEC" ]]; then
    ko "fixture bug: sidecar still present in no-sidecar fixture"
else
    if KOL_PROJECT_GODOT="$WT_NOSEC/project.godot" bash "$CONFIGURE" --port 6500 >/dev/null 2>&1; then
        st=$(sc_get "$SC_NOSEC" state); pt=$(sc_get "$SC_NOSEC" port)
        lid=$(sc_get "$SC_NOSEC" lease_id); wtf=$(sc_get "$SC_NOSEC" worktree)
        # --port without an agent name legitimately leaves agent/label "" (the
        # sidecar schema allows it: "may be "" when configure used --port only").
        if [[ "$st" == "active" && "$pt" == "6500" && -n "$lid" && "$wtf" == "$WT_NOSEC" ]]; then
            ok "sidecar absent -> configure creates complete lease (state/port/lease_id/worktree)"
        else ko "sidecar creation incomplete (state=$st port=$pt lease_id=${lid:+set} worktree=$wtf)"; fi
    else ko "sidecar creation: configure failed"; fi
fi

# 1.6 unknown agent -> non-zero exit.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
if KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" Chekky >/dev/null 2>&1; then
    ko "unknown agent 'Chekky' should fail"
else ok "unknown agent 'Chekky' rejected"; fi

# 1.7 port out of range -> non-zero exit.
for bad in 5999 65536 abc 0 -1; do
    cp "$REAL_PROJECT_GODOT" "$TEST_PG"
    if KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" --port "$bad" >/dev/null 2>&1; then
        ko "invalid port '$bad' should fail"
    else ok "invalid port '$bad' rejected"; fi
done

# 1.8 missing file -> non-zero exit.
if KOL_PROJECT_GODOT="$TMPDIR_T/does_not_exist.godot" bash "$CONFIGURE" --port 6551 >/dev/null 2>&1; then
    ko "missing file should fail"
else ok "missing project.godot rejected"; fi

# 1.9 KOL_MCP_PORT env.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
if KOL_PROJECT_GODOT="$TEST_PG" KOL_MCP_PORT=6600 bash "$CONFIGURE" >/dev/null 2>&1; then
    got=$(sc_get "$sc" port)
    [[ "$got" == "6600" ]] && ok "KOL_MCP_PORT=6600 honored (sidecar port=6600)" || ko "KOL_MCP_PORT got sidecar port '$got'"
else ko "KOL_MCP_PORT configure failed"; fi

# 1.10 KOL_AGENT_NAME env.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
if KOL_PROJECT_GODOT="$TEST_PG" KOL_AGENT_NAME=Revy bash "$CONFIGURE" >/dev/null 2>&1; then
    got=$(sc_get "$sc" port)
    [[ "$got" == "6555" ]] && ok "KOL_AGENT_NAME=Revy -> sidecar 6555" || ko "KOL_AGENT_NAME got sidecar port '$got'"
else ko "KOL_AGENT_NAME configure failed"; fi

# 1.11 precedence: --port > KOL_MCP_PORT > KOL_AGENT_NAME.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
KOL_PROJECT_GODOT="$TEST_PG" KOL_MCP_PORT=6600 KOL_AGENT_NAME=Revy bash "$CONFIGURE" --port 6611 >/dev/null 2>&1
got=$(sc_get "$sc" port)
[[ "$got" == "6611" ]] && ok "precedence: --port wins over env" || ko "precedence --port got sidecar port '$got'"
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
KOL_PROJECT_GODOT="$TEST_PG" KOL_MCP_PORT=6622 KOL_AGENT_NAME=Revy bash "$CONFIGURE" >/dev/null 2>&1
got=$(sc_get "$sc" port)
[[ "$got" == "6622" ]] && ok "precedence: KOL_MCP_PORT wins over KOL_AGENT_NAME" || ko "precedence env got sidecar port '$got'"

# 1.12 idempotency: run twice, same result, exactly one active lease with the
# same lease_id (fast path must NOT regenerate the lease id — Archi Suite A2
# oracle), and project.godot still byte-identical to HEAD.
cp "$REAL_PROJECT_GODOT" "$TEST_PG"
sc="$(sidecar_path_for "$TEST_PG")"; rm -f "$sc"
pg_snapshot_idem="$TMPDIR_T/pg-before-idem"
cp "$TEST_PG" "$pg_snapshot_idem"
KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" Bachi >/dev/null 2>&1
lid1=$(sc_get "$sc" lease_id)
KOL_PROJECT_GODOT="$TEST_PG" bash "$CONFIGURE" Bachi >/dev/null 2>&1
lid2=$(sc_get "$sc" lease_id)
st=$(sc_get "$sc" state); pt=$(sc_get "$sc" port)
if [[ "$st" == "active" && "$pt" == "6553" && -n "$lid1" && "$lid1" == "$lid2" ]]; then
    ok "idempotent: 2 runs -> one active lease on 6553, lease_id stable"
else ko "idempotent: state=$st port=$pt lease_id1=${lid1:+set} lease_id2=${lid2:+set}"; fi
diff -q "$pg_snapshot_idem" "$TEST_PG" >/dev/null 2>&1 \
    && ok "idempotent: project.godot still byte-identical to HEAD" \
    || ko "idempotent: configure modified project.godot"
# Sidecar file schema: exactly one lease record (single JSON object).
if [[ "$(grep -c '"lease_id"' "$sc" 2>/dev/null)" -eq 1 ]]; then
    ok "idempotent: single lease record in sidecar"
else ko "idempotent: sidecar has $(grep -c '"lease_id"' "$sc" 2>/dev/null) lease records"; fi

#############################################################################
# BLOCK 2 (logic): start-godot-editor.sh argument + error paths
#############################################################################
sect "BLOCK 2a: start-godot-editor.sh argument/error paths"

# 2a.1 --help
if bash "$STARTER" --help >/dev/null 2>&1; then
    if bash "$STARTER" --help 2>&1 | grep -qi "Usage:"; then ok "--help exits 0 and shows Usage"
    else ko "--help missing 'Usage:'"; fi
else ko "--help did not exit 0"; fi

# 2a.2 unknown agent
if bash "$STARTER" Chekky >/dev/null 2>&1; then ko "unknown agent 'Chekky' should fail"
else ok "unknown agent 'Chekky' rejected"; fi

# 2a.3 port out of range
for bad in 5999 65536 abc; do
    if bash "$STARTER" --port "$bad" --worktree "$REPO_ROOT" --editor /bin/true >/dev/null 2>&1; then
        ko "invalid port '$bad' should fail"
    else ok "invalid port '$bad' rejected"; fi
done

# 2a.4 missing project.godot in worktree
NOTPROJ="$TMPDIR_T/notproj"; mkdir -p "$NOTPROJ"
if bash "$STARTER" --port 6555 --worktree "$NOTPROJ" --editor /bin/true >/dev/null 2>&1; then
    ko "worktree without project.godot should fail"
else ok "worktree without project.godot rejected"; fi

# 2a.5 nonexistent worktree dir
if bash "$STARTER" --port 6555 --worktree "$TMPDIR_T/nope" --editor /bin/true >/dev/null 2>&1; then
    ko "nonexistent worktree should fail"
else ok "nonexistent worktree rejected"; fi

# 2a.6 editor binary not found
if bash "$STARTER" --port 6555 --worktree "$REPO_ROOT" --editor "$TMPDIR_T/no-such-exe" >/dev/null 2>&1; then
    ko "missing editor binary should fail"
else ok "missing editor binary rejected"; fi

# 2a.7 RETIRED (SEE-1242 A-3 ruling): the "/bin/true fake editor foreground
# launch" assertion is gone. start-godot-editor.sh now PORT_PROBEs the real
# port before launch (an in-use port dies regardless of the editor binary),
# and a mocked editor launch conflicts with the Owner's no-editor-mock hard
# constraint. Port resolution itself is covered by 1.3/1.10 against the
# sidecar oracle, so no information is lost.

# 2a.8 agent_label_for_port lowercase label + port-<n> fallback (source-level
# structural check on the shared lib; runtime filenames verified in E2E).
if grep -q "tr '\[:upper:\]' '\[:lower:\]'" "$LAUNCH_DIR/agent-ports.lib.sh"; then ok "source: agent_label_for_port lowercases agent name"
else ko "source: lowercase transform missing"; fi
if grep -q 'echo "port-${p}"' "$LAUNCH_DIR/agent-ports.lib.sh"; then ok "source: label fallback is port-<n> for off-table ports"
else ko "source: port-<n> fallback missing"; fi

#############################################################################
# BLOCK 2 (E2E): real launch via Revy/6555 -- only if interop is available
#############################################################################
sect "BLOCK 2b: start-godot-editor.sh REAL launch (Revy / 6555)"

if [[ -z "${SEE976_SKIP_E2E:-}" && -n "$POWERSHELL" && -n "$TASKKILL" ]]; then
    EDITOR_BIN="/mnt/d/Godot/Godot_v4.6.2-stable_win64.exe"
    if [[ ! -e "$EDITOR_BIN" ]]; then
        sk "E2E: Godot editor binary not found at $EDITOR_BIN"
    else
        E2E_PORT=6555
        E2E_LABEL="revy"
        LOG_FILE="$HOME/.multica/godot-editor-${E2E_LABEL}.log"
        PID_FILE="$HOME/.multica/godot-editor-${E2E_LABEL}.pid"

        # Pre-clean: if something still holds 6555, try to free it.
        pre_pid=$("$POWERSHELL" -NoProfile -Command \
            "(Get-NetTCPConnection -LocalPort ${E2E_PORT} -ErrorAction SilentlyContinue).OwningProcess" \
            2>/dev/null | tr -d '\r' | tail -n 1)
        if [[ -n "${pre_pid:-}" ]]; then
            echo "[e2e] pre-clean: port ${E2E_PORT} held by PID $pre_pid, killing"
            "$TASKKILL" /PID "$pre_pid" /F >/dev/null 2>&1 || true
            sleep 2
        fi

        # SEE-1242 LOW-2 (fixture hygiene): the previous E2E round's taskkill
        # leaves a stale `released_at` timestamp in the sidecar; a fresh
        # configure in the same worktree then lets the editor refuse the
        # takeover (it falls back to port 6550 — the SEE-1152 goal-4 known
        # race). The main configure below runs BEFORE this point on a
        # first-round-clean sidecar but NOT after a prior round's release, so
        # re-run it here to clear stale release traces before the launch.
        bash "$CONFIGURE" Revy >/dev/null 2>&1 || true

        # Configure the real worktree to the Revy port (sidecar lease —
        # project.godot must remain byte-identical to HEAD).
        pg_head_snapshot="$TMPDIR_T/pg-head-snapshot"
        git -C "$REPO_ROOT" show HEAD:project.godot > "$pg_head_snapshot" 2>/dev/null || cp "$REAL_PROJECT_GODOT" "$pg_head_snapshot"
        if bash "$CONFIGURE" Revy >/dev/null 2>&1; then ok "E2E: configure-mcp-port.sh Revy (real worktree)"
        else ko "E2E: configure Revy failed"; fi
        E2E_SC="$REPO_ROOT/.godot/mcp-lease.json"
        sc_state=$(sc_get "$E2E_SC" state); sc_port=$(sc_get "$E2E_SC" port)
        if [[ "$sc_state" == "active" && "$sc_port" == "$E2E_PORT" ]]; then
            ok "E2E: sidecar state=active port=$E2E_PORT"
        else ko "E2E: sidecar wrong (state=$sc_state port=$sc_port)"; fi
        diff -q "$pg_head_snapshot" "$REAL_PROJECT_GODOT" >/dev/null 2>&1 \
            && ok "E2E: project.godot byte-identical to git HEAD after configure" \
            || ko "E2E: configure modified project.godot (sidecar-only contract violated)"

        # Launch.
        rm -f "$LOG_FILE" "$PID_FILE"
        launch_out=$(bash "$STARTER" Revy 2>&1) || true
        echo "$launch_out" | sed 's/^/    [starter] /'

        # PID resolution is ASYNCHRONOUS (schtasks background resolver): the
        # pid file initially carries the "pending" marker and the resolver
        # overwrites it with the real Windows PID within ~30s. Wait for that
        # instead of asserting on the immediate value.
        pid_resolved=0
        for i in $(seq 1 30); do
            if [[ -f "$PID_FILE" ]]; then
                pval=$(tr -d '\r\n ' < "$PID_FILE")
                if [[ "$pval" =~ ^[0-9]+$ ]]; then pid_resolved=1; break; fi
            fi
            sleep 1
        done
        if [[ $pid_resolved -eq 1 ]]; then
            LAUNCHED_PID=$(tr -d '\r\n ' < "$PID_FILE")
            ok "E2E: async resolver wrote a real PID to ~/.multica/godot-editor-${E2E_LABEL}.pid = $LAUNCHED_PID"
            # lowercase-label detail: file MUST be godot-editor-revy.{log,pid}, not Revy.
            [[ "$PID_FILE" == *"/godot-editor-revy.pid" ]] && ok "E2E: pid filename uses LOWERCASE label 'revy'" || ko "E2E: pid filename not lowercase ($PID_FILE)"
        else
            ko "E2E: pid file never resolved to a real Windows PID within 30s (value: $(tr -d '\r\n ' < "$PID_FILE" 2>/dev/null || echo '<absent>'))"
        fi

        # Wait for the addon to bind the WebSocket server. SEE-1134 idle gate:
        # cold start waits for the editor scan/import to settle before binding
        # (default 30s gate, binding anyway after it) — so the budget is the
        # idle gate + import time. SEE-1242 LOW-3 (Owner directive): align the
        # window with the production cold-warmup cap — the proxy's
        # COLD_WARMUP_TIMEOUT_MS is 300s (godot-mcp-proxy.mjs:112), so a cold
        # worktree that legitimately takes ~210s on a UNC path must not fail
        # here. 300 iterations = the same 300s budget the production layer
        # already grants.
        listened=0
        for i in $(seq 1 300); do
            if [[ -f "$LOG_FILE" ]] && grep -qE '\[godot-mcp\].*[Ss]erver.*[Ll]istening|listening on' "$LOG_FILE"; then
                listened=1; break
            fi
            sleep 1
        done
        if [[ $listened -eq 1 ]]; then
            ok "E2E: editor log shows MCP server listening"
            # Show the listening line for evidence.
            grep -E '\[godot-mcp\].*[Ss]erver.*[Ll]istening|listening on' "$LOG_FILE" | head -1 | sed 's/^/    [log] /'
            # Confirm the port appears in the log.
            if grep -q ":${E2E_PORT}" "$LOG_FILE"; then ok "E2E: log references port ${E2E_PORT}"
            else ko "E2E: log does not reference port ${E2E_PORT}"; fi
        else
            ko "E2E: MCP server did not log 'listening' within 300s (= proxy COLD_WARMUP_TIMEOUT_MS; idle gate 30s + import)"
            echo "    [log tail] $(tail -n 5 "$LOG_FILE" 2>/dev/null | tr '\n' '|')"
        fi

        # Confirm the PID is a real Windows Godot process.
        if [[ -n "${LAUNCHED_PID:-}" ]]; then
            pname=$("$POWERSHELL" -NoProfile -Command \
                "(Get-Process -Id ${LAUNCHED_PID} -ErrorAction SilentlyContinue).Name" \
                2>/dev/null | tr -d '\r' | tail -n 1)
            if [[ "$pname" == "Godot"* ]]; then
                ok "E2E: PID $LAUNCHED_PID is a real Windows Godot process ($pname)"
            else
                ko "E2E: PID $LAUNCHED_PID is NOT a Godot process (got '${pname:-<gone>}')"
            fi
        fi

        # Same-runtime relaunch semantics: start-godot-editor.sh is a raw
        # primitive whose port guard ("Port N is already in use") stays a
        # fail-fast by design — the SEE-1129 reuse decision tree (same
        # runtime → hot takeover / respawn wait, foreign → editor_busy
        # retryable) lives in the PROXY's ensureEditor (port-arbiter
        # verdicts), above this script. A relaunch while the editor still
        # holds the port must therefore surface the structured guard die —
        # with the SEE-1164 owner forensics — and NOT any other failure;
        # once the editor is stopped, relaunch succeeds. (Archi A-3 ruling
        # #4 read together with the runbook tree: the retired contract was
        # the WRAPPER-level hard error with no reuse layer; the starter's
        # guard remains the backstop under it.)
        relaunch_err=$(bash "$STARTER" Revy 2>&1 >/dev/null); rc=$?
        if [[ $rc -ne 0 ]] && echo "$relaunch_err" | grep -q "already in use"; then
            ok "E2E: relaunch onto editor-held port hits the starter's structured port guard (proxy reuse layer owns SEE-1129 semantics)"
        else
            ko "E2E: relaunch onto editor-held port neither guarded nor cleanly reused (rc=$rc)"
            echo "    [relaunch] $relaunch_err"
        fi

        # Stop the launched instance now (also exercised by trap).
        if [[ -n "${LAUNCHED_PID:-}" ]]; then
            "$TASKKILL" /PID "$LAUNCHED_PID" /F >/dev/null 2>&1 && ok "E2E: taskkill /PID $LAUNCHED_PID /F executed"
            # SEE-1242 LOW-3 follow-up: /F teardown of a long-lived editor can
            # lag past a fixed 2s on Windows (driver/dll unload). Poll up to
            # 10s instead of one-shot asserting on a 2s snapshot.
            gone=""
            for i in $(seq 1 10); do
                sleep 1
                gone=$("$POWERSHELL" -NoProfile -Command \
                    "if (Get-Process -Id ${LAUNCHED_PID} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }" \
                    2>/dev/null | tr -d '\r' | tail -n 1)
                [[ "$gone" == "gone" ]] && break
            done
            [[ "$gone" == "gone" ]] && ok "E2E: editor process confirmed gone after taskkill" || ko "E2E: process still '$gone' after taskkill"
            LAUNCHED_PID=""
        fi
    fi
else
    sk "E2E real-launch skipped (no powershell/taskkill interop or SEE976_SKIP_E2E set)"
fi

#############################################################################
# BLOCK 3: documentation completeness + consistency
#############################################################################
sect "BLOCK 3: mcp-multi-port-usage.md"

# 3.1 six required sections (background / port table / flow / owner checklist / troubleshooting / separation of duty).
sections_ok=1
grep -qE '^##.*背景'            "$DOC_FILE" || { ko "section missing: 背景";           sections_ok=0; }
grep -qE '^##.*端口分配'        "$DOC_FILE" || { ko "section missing: 端口分配";       sections_ok=0; }
grep -qE '^##.*主流程|wrapper|开箱即用' "$DOC_FILE" || { ko "section missing: 主流程/wrapper 流程"; sections_ok=0; }
grep -qE '^##.*Owner.*配置|配置清单' "$DOC_FILE" || { ko "section missing: Owner 配置清单"; sections_ok=0; }
grep -qE '^##.*排错'            "$DOC_FILE" || { ko "section missing: 排错";           sections_ok=0; }
grep -qE '^##.*何时需要 Owner|职责分离' "$DOC_FILE" || { ko "section missing: 职责分离"; sections_ok=0; }
[[ $sections_ok -eq 1 ]] && ok "all 6 required sections present"

# 3.2 port allocation table has all 6 agents.
table_ok=1
for a in Atlas Archi Bachi Fronti Revy Refacty; do
    grep -qE "\| *${a} *\|" "$DOC_FILE" || { ko "port table missing row: $a"; table_ok=0; }
done
[[ $table_ok -eq 1 ]] && ok "port table: all 6 agents present"

# 3.3 owner checklist is a 6-row table pointing at the wrapper command (post-3f7ed72
# the main flow is the wrapper; configure/start are demoted to section 6).
owner_ok=1
for a in Atlas Archi Bachi Fronti Revy Refacty; do
    grep -qE "\|.*${a}.*godot-mcp-launcher\.sh" "$DOC_FILE" || { ko "owner checklist missing/incorrect wrapper row: $a"; owner_ok=0; }
done
wrapper_rows=$(grep -cE 'godot-mcp-launcher\.sh' "$DOC_FILE")
[[ "$wrapper_rows" -ge 6 ]] && ok "owner checklist: $wrapper_rows wrapper rows (>=6)" || ko "owner checklist: only $wrapper_rows wrapper rows (need 6)"
[[ $owner_ok -eq 1 ]] && ok "owner checklist: every agent row points at wrapper command"

# 3.4 args / env consistent with .mcp.json (npx -y @satelliteoflove/godot-mcp).
grep -q '@satelliteoflove/godot-mcp' "$DOC_FILE" && ok "doc references @satelliteoflove/godot-mcp (matches .mcp.json)" || ko "doc missing package reference"
# 3.4 wrapper-specific docs.
grep -qE 'godot-mcp-launcher\.sh' "$DOC_FILE" && ok "doc documents the wrapper launcher" || ko "doc missing wrapper launcher reference"
grep -qE 'stdout|stderr' "$DOC_FILE" && ok "doc documents stdout/stderr separation" || ko "doc missing stdout/stderr separation"
grep -qE '60s|60秒|MCP_TIMEOUT_SEC' "$DOC_FILE" && ok "doc documents 60s timeout" || ko "doc missing 60s timeout"
grep -qE '幂等|idempotent|跳过|跳过环境' "$DOC_FILE" && ok "doc documents wrapper idempotency" || ko "doc missing wrapper idempotency"
# SEE-1148 two-segment wording: legacy reserved 6551-6556 + dynamic 6560-6609.
grep -qE 'GODOT_PORT' "$DOC_FILE" && ok "doc references GODOT_PORT env" || ko "doc missing GODOT_PORT reference"
grep -qE 'legacy.{0,12}6551-6556' "$DOC_FILE" && ok "doc lists legacy reserved 6551-6556" || ko "doc missing legacy 6551-6556 segment"
grep -qE '6560-6609' "$DOC_FILE" && ok "doc lists dynamic segment 6560-6609" || ko "doc missing dynamic 6560-6609 segment"

# 3.5 the LOWERCASE label detail (godot-editor-bachi.log/.pid) -- Atlas explicitly flagged this.
if grep -qiE 'godot-editor-bachi\.(log|pid)' "$DOC_FILE"; then
    ok "doc documents lowercase label filenames (godot-editor-bachi.log/.pid)"
else
    ko "doc does NOT spell out lowercase-label filenames"
fi
if grep -qiE '小写|lowercase|tr .*lower' "$DOC_FILE"; then ok "doc explains the lowercase transform"
else ko "doc does not explain lowercase transform"; fi

# 3.6 doc matches script behavior: port range 6000-65535, KOL_* env, --foreground flag.
grep -qE '6000-65535|6000.*65535' "$DOC_FILE" && ok "doc states port range 6000-65535 (matches script)" || ko "doc port range mismatch"
grep -qE 'KOL_AGENT_NAME' "$DOC_FILE" && ok "doc lists KOL_AGENT_NAME" || ko "doc missing KOL_AGENT_NAME"
grep -qE 'KOL_MCP_PORT'   "$DOC_FILE" && ok "doc lists KOL_MCP_PORT"   || ko "doc missing KOL_MCP_PORT"
grep -qE 'KOL_WORKTREE'   "$DOC_FILE" && ok "doc lists KOL_WORKTREE"   || ko "doc missing KOL_WORKTREE"
grep -qE '\-\-foreground' "$DOC_FILE" && ok "doc documents --foreground" || ko "doc missing --foreground"

# 3.7 stop instructions: taskkill /PID + pid file location.
grep -qiE 'taskkill.exe /PID' "$DOC_FILE" && ok "doc documents taskkill.exe /PID /F stop" || ko "doc missing taskkill stop"
grep -qiE '~/.multica/godot-editor-.*\.pid|godot-editor-<label>.pid' "$DOC_FILE" && ok "doc documents pid file location" || ko "doc missing pid file location"

# 3.8 single-client limit + 4001 documented.
grep -qiE '4001|Another client is already connected' "$DOC_FILE" && ok "doc documents 4001 single-client limit" || ko "doc missing 4001 detail"

#############################################################################
# BLOCK 4: regression -- only new files added, existing scripts untouched
#############################################################################
sect "BLOCK 4: regression"

# 4.1 syntax check both new scripts.
if bash -n "$CONFIGURE"; then ok "configure-mcp-port.sh: bash -n syntax OK"; else ko "configure-mcp-port.sh: syntax error"; fi
if bash -n "$STARTER";   then ok "start-godot-editor.sh: bash -n syntax OK";   else ko "start-godot-editor.sh: syntax error"; fi

# 4.2 scripts are executable.
[[ -x "$CONFIGURE" ]] && ok "configure-mcp-port.sh is executable" || ko "configure-mcp-port.sh not executable"
[[ -x "$STARTER" ]]   && ok "start-godot-editor.sh is executable"   || ko "start-godot-editor.sh not executable"

# 4.3 kingoflikes-start.sh NOT modified by this branch.
ks_diff=$(git -C "$REPO_ROOT" diff --name-only origin/master..HEAD -- .dev/launch/kingoflikes-start.sh 2>/dev/null)
if [[ -z "$ks_diff" ]]; then ok "kingoflikes-start.sh untouched by feature/SEE-976"
else ko "kingoflikes-start.sh was modified: $ks_diff"; fi

# 4.4 other existing scripts untouched.
other_touched=0
for s in .dev/launch/upgrade-multica-selfhost.sh .dev/tests/run_tests.sh .dev/tests/run_tests.bat; do
    d=$(git -C "$REPO_ROOT" diff --name-only origin/master..HEAD -- "$s" 2>/dev/null)
    if [[ -n "$d" ]]; then ko "existing script modified: $s"; other_touched=1; fi
done
[[ $other_touched -eq 0 ]] && ok "no other existing launch/test scripts modified"

# 4.5 RETIRED (SEE-1242 A-3 ruling): the "origin/master..HEAD diff must
# contain exactly the SEE-976 six files" block is gone. It assumed a single
# linear feature branch; under the shared-branch model (shared/SEE-*) the
# diff domain is co-owned by multiple agents/batches, so "exactly these
# files" is unassertable. Replacement: the SEE-976 file set exists at HEAD
# (presence, not diff membership); diff hygiene is enforced by push-guard /
# stop-hook suites instead.
expected_files=(
    .dev/docs/multica/README.md
    .dev/godot-mcp/docs/mcp-multi-port-usage.md
    launch/configure-mcp-port.sh
    launch/start-godot-editor.sh
    launch/godot-mcp-launcher.sh
    .dev/godot-mcp/tests/scripts/test_see976_mcp_multi_port.sh
)
presence_ok=1
for f in "${expected_files[@]}"; do
    if ! git -C "$REPO_ROOT" cat-file -e "HEAD:$f" 2>/dev/null; then
        ko "expected SEE-976 file missing at HEAD: $f"; presence_ok=0
    fi
done
[[ $presence_ok -eq 1 ]] && ok "SEE-976 file set present at HEAD (scripts/doc/wrapper/test)"

# 4.6 README index updated.
if grep -q 'mcp-multi-port-usage.md' "$REPO_ROOT/.dev/docs/multica/README.md"; then ok "README.md indexes the new doc"
else ko "README.md does not index the new doc"; fi

# 4.7 kingoflikes-start.sh still parses (not broken by anything).
if bash -n "$REPO_ROOT/.dev/launch/kingoflikes-start.sh"; then ok "kingoflikes-start.sh still parses (bash -n)"
else ko "kingoflikes-start.sh syntax broken"; fi

#############################################################################
# Summary
#############################################################################
echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [[ ${#FAILS[@]} -gt 0 ]]; then
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
echo "============================================================"

# Exit non-zero if any hard failure (skips are acceptable for env reasons).
[[ $FAIL -eq 0 ]]
