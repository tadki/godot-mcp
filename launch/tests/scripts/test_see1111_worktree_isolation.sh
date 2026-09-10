#!/usr/bin/env bash
# test_see1111_worktree_isolation.sh
#
# Rewritten under SEE-1117 Direction 3 — original asserted project.godot
# [godot_mcp] section; current asserts sidecar at <worktree>/.godot/mcp-lease.json.
# See Bachi's evidence report in issue SEE-1117 thread 643309c3.
#
# SEE-1111 regression — per-agent worktree isolation in the launcher/configure
# and multi-agent cold-start freedom.
#
# SEE-1111 root cause: the MCP server process cwd is the agent's OWN task workdir
# root (`<workdir>/`), which contains the checked-out repo ONE level down
# (`<workdir>/KingOfLikes-Godot/`). The platform spawns the launcher via an
# absolute D-drive path, so the launcher's old resolve_worktree_root walked up
# from $(pwd) (no project.godot there), then fell back to walking up from
# $SCRIPT_DIR — landing on the SHARED D-drive master checkout. All agents'
# configure rewrote the same shared project.godot (last-writer-wins) + addon
# single-WS-slot collisions.
#
# Fix under test (Option 3 + 防线 3, Archi acceptance 03772528):
#   * launcher resolve_worktree_root() searches DOWN from cwd for a subdir with
#     BOTH project.godot AND launch before the SCRIPT_DIR fallback
#   * proxy resolveWorktreeForSpawn() does the same
#   * configure-mcp-port.sh guard_write_target() fails fast on the shared D-drive
#     master checkout / any branch=master checkout
#   * proxy ensureEditor() refuses to spawn against the shared master worktree
#     (worktree_shared_master) and skips hot-reuse re-pin on it
#
# Assertions:
#   1. launcher resolves the PRIVATE worktree (down-search) instead of the shared
#      D-drive master when spawned from an agent workdir root
#   2. same for a second agent workdir root via cwd inference (tier 2). Per
#      SEE-1128 / Owner, KOL_PROJECT_GODOT is honored by the launcher CALLER,
#      not resolve_worktree_root, so it is no longer exercised here.
#   3. configure guard: refuses shared D-drive master path (rc!=0, diagnostic)
#   4. configure guard: refuses any branch=master checkout (rc!=0)
#   5. configure guard: passes on a feature-branch private worktree (rc=0), and
#      the resulting sidecar at <wt>/.godot/mcp-lease.json has state=active +
#      port=<pinned>
#   6. proxy-style down-search resolves the private worktree from two
#      independent agent workdir roots (isolation)
#   7. proxy: spawn against a shared-master-resolved worktree fails fast with
#      the worktree_shared_master diagnostic (Channel A error), helper mocks
#      never fire. SEE-1111 hold-to-warm (目标1/目标3): id=2 (the spawn trigger)
#      is HELD, then drained by the async worktree_shared_master failure with the
#      REAL diagnostic — the one-shot latch re-arms so id=3 also carries it.
#   8. proxy: hot-reuse path (port already listening) skips the shared-master
#      re-pin non-fatally. SEE-1111 hold-to-warm: id=2 is held and flushed to
#      npx after WARM (mock-ok success lands on id=2).
#   9. two-agent cold-start: 2 independent proxies on distinct ports + distinct
#      private worktrees cold-spawn without cross-collision, each usable
#      (id=2 held → flushed mock-ok after WARM, no hint)
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_worktree_isolation.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

LAUNCHER="$REPO_ROOT/launch/godot-mcp-launcher.sh"
CONFIGURE="$REPO_ROOT/launch/configure-mcp-port.sh"

# Known shared D-drive master checkout (guard hardcode). The test must not
# require it to exist — the path guard is lexical, so absence is fine.
KNOWN_SHARED="/mnt/d/GodotProjects/king-of-likes"

# Two independent private agent worktrees, each a real Godot-project-shaped
# checkout carrying the launch toolchain (down-search discriminator). Direction 3:
# project.godot carries no port state — only the sidecar does.
WORKTREE_A="$TMPDIR/agentA/KingOfLikes-Godot"
WORKTREE_B="$TMPDIR/agentB/KingOfLikes-Godot"
for wt in "$WORKTREE_A" "$WORKTREE_B"; do
    mkdir -p "$wt/launch"
    printf 'config_version=5\n\n[godot_mcp]\n\nbind_mode=1\ncustom_bind_ip=""\n' > "$wt/project.godot"
    touch "$wt/launch/.marker"
done

# Read a sidecar field via node (no jq dependency — matches the toolchain and the
# SEE-1117 Suite A reference). Returns '' on missing file/field/malformed JSON.
sidecar_field() {
    local sc="$1" f="$2"
    [ -f "$sc" ] || { echo ''; return; }
    SIDE_FIELD="$f" node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                const v = o[process.env.SIDE_FIELD];
                process.stdout.write(v === null || v === undefined ? "" : String(v));
            } catch (e) { process.stdout.write(""); }
        });
    ' < "$sc" 2>/dev/null
}

# A branch=master checkout elsewhere (guard test 4): real git repo on master.
MASTER_WT="$TMPDIR/masterwt/king-of-likes"
mkdir -p "$MASTER_WT"
git -C "$MASTER_WT" init -q 2>/dev/null
git -C "$MASTER_WT" config user.email "test@example.com" >/dev/null 2>&1
git -C "$MASTER_WT" config user.name "Test" >/dev/null 2>&1
git -C "$MASTER_WT" checkout -qb master 2>/dev/null || git -C "$MASTER_WT" branch -m master 2>/dev/null || true
printf 'config_version=5\n' > "$MASTER_WT/project.godot"
git -C "$MASTER_WT" add project.godot >/dev/null 2>&1
git -C "$MASTER_WT" commit -qm "baseline" 2>/dev/null || true

# Extract the launcher's resolver block verbatim (a runnable probe of the
# shipped code, no copy-paste drift). The launcher itself cannot be sourced
# (it execs at the end), so we pull the whole resolver section out of the
# file: the SHARED_MASTER_WORKTREE const, the _is_shared_master /
# _search_root_for_worktree / _encode_workdir_marker /
# _resolve_via_runtime_registry helpers, and resolve_worktree_root itself
# (SEE-1128 refactored the function to call these helpers, so extracting only
# resolve_worktree_root would leave the probe with undefined function calls).
# The block runs from the SHARED_MASTER_WORKTREE= assignment line through the
# closing brace of resolve_worktree_root. log() is stubbed by the caller
# (the resolver only logs on a shared-master rejection, which these isolation
# probes never trigger, but the stub keeps `set -u` safe).
extract_resolver() {
    local start close
    start=$(grep -n '^SHARED_MASTER_WORKTREE=' "$LAUNCHER" | cut -d: -f1)
    # closing brace of resolve_worktree_root: first ^}-only line at/after its def
    close=$(awk '/^resolve_worktree_root\(\) \{/{f=1} f && /^}/{print NR; exit}' "$LAUNCHER")
    sed -n "${start},${close}p" "$LAUNCHER" > "$TMPDIR/resolver.sh"
    printf 'log() { :; }\n' >> "$TMPDIR/resolver.sh"
}

sep "SEE-1111: per-agent worktree isolation"

# --- 1. launcher down-search from agent workdir root ---
# The MCP server is spawned with cwd = the agent workdir ROOT (contains the
# checkout one level down). No env override → resolve_worktree_root must find
# WORKTREE_A via the down-search, NOT the shared D-drive master fallback.
extract_resolver

# SEE-1128: resolve_worktree_root is now two-tier — tier 1 (runtime registry)
# is cwd-INDEPENDENT and, under a live daemon, would resolve THIS task's real
# runtime before these probes ever reach cwd inference. These assertions target
# the cwd-inference tier (tier 2) in isolation, so they strip MULTICA_* and
# point TMPDIR/HOME at empty dirs to disable tier 1 without touching the
# resolver code. The registry tier itself is covered by the smoke matrix.
T1_ENV=(env -u MULTICA_WORKSPACE_ID -u MULTICA_AGENT_ID -u MULTICA_TASK_ID -u MULTICA_TASK_SLOT TMPDIR="$TMPDIR/no-marker" HOME="$TMPDIR/no-home")
mkdir -p "$TMPDIR/no-marker" "$TMPDIR/no-home"

RESOLVED1="$(
    cd "$TMPDIR/agentA" && "${T1_ENV[@]}" bash -c '
        source "$1"
        resolve_worktree_root
    ' _ "$TMPDIR/resolver.sh"
)"
if [[ "$RESOLVED1" == "$WORKTREE_A" ]]; then
    ok "1.1 launcher down-search resolves the agent private worktree ($WORKTREE_A)"
else
    ko "1.1 launcher down-search: expected $WORKTREE_A, got '${RESOLVED1:-<empty>}'"
fi

# --- 2. launcher resolves a second agent's private worktree via cwd ---
# SEE-1128 / Owner tightened the resolver to two tiers (runtime registry ->
# cwd); KOL_PROJECT_GODOT is honored by the CALLER, not resolve_worktree_root.
# So this probe asserts cwd-resolution of agentB (cwd inference, tier 2).
RESOLVED2="$(
    cd "$TMPDIR/agentB" && "${T1_ENV[@]}" bash -c '
        source "$1"
        resolve_worktree_root
    ' _ "$TMPDIR/resolver.sh"
)"
if [[ "$RESOLVED2" == "$WORKTREE_B" ]]; then
    ok "2.1 cwd resolution resolves the second agent private worktree ($WORKTREE_B)"
else
    ko "2.1 cwd resolution: expected $WORKTREE_B, got '${RESOLVED2:-<empty>}'"
fi

# --- 3. configure guard: shared D-drive master path refused ---
sep "3. configure write-target guard (shared D-drive master)"
# Capture output + rc separately: under pipefail, `configure | grep` reports
# configure's rc=1 even when grep matched, so a pipeline `if` would misfire.
GUARD_OUT="$(KOL_PROJECT_GODOT="$KNOWN_SHARED/project.godot" bash "$CONFIGURE" --port 6553 2>&1)"
GUARD_RC=$?
if [[ "$GUARD_RC" -ne 0 ]]; then
    ok "3.1 configure refuses shared D-drive master target (rc!=0)"
else
    ko "3.1 configure should REFUSE the shared D-drive master target"
fi
if printf '%s' "$GUARD_OUT" | grep -q 'write-target guard'; then
    ok "3.2 configure diagnostic names the write-target guard"
else
    ko "3.2 configure diagnostic missing 'write-target guard'"
fi

# --- 4. configure guard: any branch=master checkout refused ---
sep "4. configure write-target guard (branch=master checkout)"
if KOL_PROJECT_GODOT="$MASTER_WT/project.godot" bash "$CONFIGURE" --port 6553 >/dev/null 2>&1; then
    ko "4.1 configure should REFUSE the branch=master checkout"
else
    ok "4.1 configure refuses branch=master checkout (rc!=0)"
fi

# --- 5. configure guard: private feature-branch worktree passes ---
sep "5. configure passes on a private worktree"
if KOL_PROJECT_GODOT="$WORKTREE_A/project.godot" bash "$CONFIGURE" --port 6553 >/dev/null 2>&1; then
    ok "5.1 configure writes the private worktree sidecar (rc=0)"
else
    ko "5.1 configure failed on the private worktree"
fi
# Direction 3: the lease lives at <wt>/.godot/mcp-lease.json (state=active, port=6553).
SC5="$WORKTREE_A/.godot/mcp-lease.json"
SC5_STATE="$(sidecar_field "$SC5" state)"
SC5_PORT="$(sidecar_field "$SC5" port)"
SC5_LID="$(sidecar_field "$SC5" lease_id)"
if [[ "$SC5_STATE" == "active" && "$SC5_PORT" == "6553" && -n "$SC5_LID" ]]; then
    ok "5.2 private worktree sidecar state=active port=6553"
else
    ko "5.2 private worktree sidecar not active@6553 (state=${SC5_STATE:-<empty>} port=${SC5_PORT:-<empty>} lease_id=${SC5_LID:-<empty>})"
fi

# --- 6. proxy-style down-search resolves the private worktree (isolation) ---
sep "6. proxy resolveWorktreeForSpawn down-search (isolation)"
# Re-implement the exact resolver discriminator (project.godot AND launch
# toolchain) from two independent workdir roots — proves each agent resolves its
# OWN checkout, not a shared one.
PROBE_NODE='
const fs = require("fs"); const path = require("path");
const cwd = process.cwd();
for (const entry of fs.readdirSync(cwd)) {
    if (entry.startsWith(".")) continue;
    const sub = path.join(cwd, entry);
    let st; try { st = fs.statSync(sub); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (fs.existsSync(path.join(sub, "project.godot")) &&
        fs.existsSync(path.join(sub, ".dev", "godot-mcp", "launch"))) {
        process.stdout.write(sub); process.exit(0);
    }
}
process.exit(1);
'
RESOLVED6A="$(cd "$TMPDIR/agentA" && node -e "$PROBE_NODE")"
if [[ "$RESOLVED6A" == "$WORKTREE_A" ]]; then
    ok "6.1 down-search resolves worktree A from its workdir root"
else
    ko "6.1 down-search: expected $WORKTREE_A, got '${RESOLVED6A:-<empty>}'"
fi
RESOLVED6B="$(cd "$TMPDIR/agentB" && node -e "$PROBE_NODE")"
if [[ "$RESOLVED6B" == "$WORKTREE_B" ]]; then
    ok "6.2 down-search resolves worktree B from its workdir root (isolation)"
else
    ko "6.2 down-search: expected $WORKTREE_B, got '${RESOLVED6B:-<empty>}'"
fi

# --- 7. proxy refuses to spawn against a shared-master-resolved worktree ---
sep "7. proxy worktree_shared_master fail-fast (Channel A)"
# Force the resolver to land on the shared D-drive master path via KOL_WORKTREE
# (what the pre-fix fallback produced). The cold path must fail fast BEFORE any
# configure/start helper runs (mock helpers assert they never fire).
CFG7="$TMPDIR/cfg7.count"; : > "$CFG7"
CFG7_SH=$(make_configure_mock "$CFG7" 0)
START7="$TMPDIR/start7.count"; : > "$START7"
START7_SH=$(make_start_mock "$START7" 0 0)
PORT7=$(find_free_port)
start_proxy \
    "GODOT_PORT=$PORT7" \
    "KOL_AGENT_NAME=agent7" \
    "KOL_WORKTREE=$KNOWN_SHARED" \
    "KOL_PROJECT_GODOT=$KNOWN_SHARED/project.godot" \
    "KOL_CONFIGURE_SH=$CFG7_SH" \
    "KOL_START_SH=$START7_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG7" \
    "KOL_START_COUNTER=$START7" \
    "KOL_WARMUP_TIMEOUT_MS=8000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=4000" \
    "KOL_PROBE_INTERVAL_MS=100" \
    "MOCK_NPX_LOG=$TMPDIR/e7_npx.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "7.0 initialize not answered"
# SEE-1111 hold-to-warm (目标1/目标3): the first tools/call (id=2) triggers the
# spawn and is HELD in the FIFO. The async worktree_shared_master failure lands
# while it is held, so handleSpawnFailure's rejectQueue drains id=2 with the
# REAL spawn_failed diagnostic (bucket=worktree_shared_master) — never a hint.
# The one-shot latch then re-arms, so id=3 also carries the same diagnostic.
send_line "$(call_line 2)"
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "7.1a first call id=2 answered (held call drained by the spawn failure)"
else
    ko "7.1a no id=2 response"
fi
if grep -q '"id":2.*worktree_shared_master' "$PROXY_OUT"; then
    ok "7.1b id=2 carries the real worktree_shared_master diagnostic (目标3 — not a hint)"
else
    ko "7.1b id=2 lacks the worktree_shared_master diagnostic"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "7.1h: warmup-hint text appeared (spawn failure must surface the real error, not a hint)"
else
    ok "7.1h: no warmup-hint text (real spawn_failed diagnostic, not a hint)"
fi
# The spawn failure lands asynchronously; give it a beat, then the retry call
# surfaces the one-shot diagnostic.
wait_for "$PROXY_ERR" 'editor spawn failed' 8000 || note "7: spawn failure not yet logged (timing)"
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 6000; then
    ok "7.1c retry call id=3 answered (carries the one-shot diagnostic)"
else
    ko "7.1c no id=3 response"
fi
SNAP7="$TMPDIR/e7_snap.out"; cp "$PROXY_OUT" "$SNAP7"
if grep -q '"id":3.*worktree_shared_master' "$SNAP7"; then
    ok "7.1d id=3 carries the worktree_shared_master diagnostic (one-shot on the retry)"
else
    ko "7.1d id=3 missing worktree_shared_master diagnostic"
fi
if wait_for "$PROXY_ERR" 'worktree_shared_master' 6000; then
    ok "7.2 proxy log names the shared master refusal"
else
    ko "7.2 proxy log missing worktree_shared_master"
fi
if [[ "$(count_lines "$CFG7")" == "0" ]]; then
    ok "7.3 configure mock NEVER ran (fail-fast before rewrite)"
else
    ko "7.3 configure mock ran $(count_lines "$CFG7") times (guard bypassed the write target!)"
fi
if [[ "$(count_lines "$START7")" == "0" ]]; then
    ok "7.4 start mock NEVER ran (no spawn against shared master)"
else
    ko "7.4 start mock ran $(count_lines "$START7") times (spawned against shared master!)"
fi
stop_proxy

# --- 8. proxy hot-reuse skips the shared-master re-pin non-fatally ---
sep "8. proxy hot-reuse skips shared-master re-pin"
CFG8="$TMPDIR/cfg8.count"; : > "$CFG8"
CFG8_SH=$(make_configure_mock "$CFG8" 0)
START8="$TMPDIR/start8.count"; : > "$START8"
START8_SH=$(make_start_mock "$START8" 0 0)
PORT8=$(find_free_port)
start_listener "$PORT8"   # port already listening → hot path, no spawn
start_proxy \
    "GODOT_PORT=$PORT8" \
    "KOL_AGENT_NAME=agent8" \
    "KOL_WORKTREE=$KNOWN_SHARED" \
    "KOL_PROJECT_GODOT=$KNOWN_SHARED/project.godot" \
    "KOL_CONFIGURE_SH=$CFG8_SH" \
    "KOL_START_SH=$START8_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG8" \
    "KOL_START_COUNTER=$START8" \
    "KOL_WARMUP_TIMEOUT_MS=8000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=4000" \
    "KOL_PROBE_INTERVAL_MS=100" \
    "MOCK_NPX_LOG=$TMPDIR/e8_npx.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "8.0 initialize not answered"
# SEE-1111 hold-to-warm (目标1): the first tools/call (id=2) triggers the
# hot-reuse probe and is HELD in the FIFO until the warmup gate opens, then
# flushed to npx and answered (defect #9 transport gate) — no warmup hint. The
# hot-reuse success therefore lands on id=2 itself.
send_line "$(call_line 2)"
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "8.1a first call id=2 answered (held → flushed after WARM)"
else
    ko "8.1a no id=2 response"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "8.1b warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "8.1b no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$PROXY_ERR" 'warm detected' 8000; then
    ok "8.1c proxy reached WARM via hot reuse (port already listening)"
else
    ko "8.1c proxy never reached WARM"
fi
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 6000; then
    ok "8.1d first POST-WARM call id=3 responded"
else
    ko "8.1d no id=3 response"
fi
SNAP8="$TMPDIR/e8_snap.out"; cp "$PROXY_OUT" "$SNAP8"
if grep -q '"id":3.*"result"' "$SNAP8" && grep -q '"id":3.*mock-ok' "$SNAP8"; then
    ok "8.2 hot-reuse response is a success (mock-ok on first POST-WARM call)"
else
    ko "8.2 hot-reuse response missing success/mock-ok"
fi
if wait_for "$PROXY_ERR" 'SHARED master checkout' 4000; then
    ok "8.3 proxy logged the shared-master re-pin skip"
else
    ko "8.3 proxy log missing the re-pin skip warning"
fi
if [[ "$(count_lines "$CFG8")" == "0" ]]; then
    ok "8.4 configure mock NEVER ran on hot-reuse shared-master (skip honored)"
else
    ko "8.4 configure mock ran $(count_lines "$CFG8") times on shared-master hot-reuse"
fi
stop_proxy

# --- 9. two-agent cold-start on distinct private worktrees ---
sep "9. two-agent cold-start (distinct ports + private worktrees)"
AGG9_OK=0
for i in A B; do
    if [[ "$i" == "A" ]]; then
        WT="$WORKTREE_A"; TAG=1
    else
        WT="$WORKTREE_B"; TAG=2
    fi
    PORT=$(find_free_port)
    CFG_C="$TMPDIR/cfg9$i.count"; : > "$CFG_C"
    START_C="$TMPDIR/start9$i.count"; : > "$START_C"
    CFG_SH=$(make_configure_mock "$CFG_C" 0)
    START_SH=$(make_start_mock "$START_C" 0 1)   # spawn=1 → listener on GODOT_PORT
    start_proxy \
        "GODOT_PORT=$PORT" \
        "KOL_AGENT_NAME=agent9$i" \
        "KOL_WORKTREE=$WT" \
        "KOL_PROJECT_GODOT=$WT/project.godot" \
        "KOL_CONFIGURE_SH=$CFG_SH" \
        "KOL_START_SH=$START_SH" \
        "KOL_CONFIGURE_COUNTER=$CFG_C" \
        "KOL_START_COUNTER=$START_C" \
        "KOL_WARMUP_TIMEOUT_MS=10000" \
        "KOL_HOT_WARMUP_TIMEOUT_MS=4000" \
        "KOL_PROBE_INTERVAL_MS=100" \
        "MOCK_NPX_LOG=$TMPDIR/e9_${i}_npx.log"
    send_line "$INIT_LINE"
    if wait_for "$PROXY_OUT" '"id":1' 3000; then ok "9.$TAG.0 agent$i initialize answered"; else ko "9.$TAG.0 agent$i initialize not answered"; fi
    # SEE-1111 hold-to-warm (目标1): id=2 (the call that TRIGGERED the cold
    # spawn) is HELD in the FIFO until the warmup gate opens, then flushed to npx
    # and answered — no warmup hint. The mock-ok success lands on id=2 itself
    # after WARM.
    send_line "$(call_line 2)"
    if wait_for "$PROXY_OUT" '"id":2' 10000; then ok "9.$TAG.1 agent$i first call id=2 responded"; else ko "9.$TAG.1 agent$i no response id=2"; fi
    if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
        ko "9.$TAG.1h agent$i warmup-hint text appeared (default hint must be gone under 90s timeout)"
    else
        ok "9.$TAG.1h agent$i no warmup-hint text anywhere (hold-to-warm, no default hint)"
    fi
    if wait_for "$TMPDIR/e9_${i}_npx.log" '"id":2' 4000; then
        ok "9.$TAG.1i agent$i held id=2 flushed to npx after WARM (hold → flush, not a hint)"
    else
        ko "9.$TAG.1i agent$i id=2 never reached npx (hold broke the flush)"
    fi
    if wait_for "$PROXY_ERR" 'warm detected' 10000; then
        ok "9.$TAG.1w agent$i proxy reached WARM (spawn completed)"
    else
        ko "9.$TAG.1w agent$i proxy never reached WARM"
    fi
    send_line "$(call_line 3)"
    if wait_for "$PROXY_OUT" '"id":3' 6000; then ok "9.$TAG.1b agent$i first POST-WARM call id=3 responded"; else ko "9.$TAG.1b agent$i no response id=3"; fi
    SNAP9="$TMPDIR/e9_${i}_snap.out"; cp "$PROXY_OUT" "$SNAP9"
    if grep -q '"id":3.*"result"' "$SNAP9" && grep -q '"id":3.*mock-ok' "$SNAP9"; then
        ok "9.$TAG.2 agent$i cold-spawn success (mock-ok on first POST-WARM call)"; AGG9_OK=$((AGG9_OK+1))
    else
        ko "9.$TAG.2 agent$i cold-spawn failed"
    fi
    if [[ "$(count_lines "$CFG_C")" == "1" ]]; then ok "9.$TAG.3 agent$i configure exactly once"; else ko "9.$TAG.3 agent$i configure count=$(count_lines "$CFG_C") (expected 1)"; fi
    if [[ "$(count_lines "$START_C")" == "1" ]]; then ok "9.$TAG.4 agent$i start exactly once"; else ko "9.$TAG.4 agent$i start count=$(count_lines "$START_C") (expected 1)"; fi
    stop_proxy
done
if [[ "$AGG9_OK" == "2" ]]; then
    ok "9.5 BOTH agents cold-started independently (no cross-collision)"
else
    ko "9.5 only $AGG9_OK/2 agents cold-started independently"
fi

summary
