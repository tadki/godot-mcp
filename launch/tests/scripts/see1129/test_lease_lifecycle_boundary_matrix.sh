#!/usr/bin/env bash
# SEE-1129 lease lifecycle boundary matrix — the 9-case sweep.
#
# Exercises the release/lifecycle layer (stop-godot-editor.sh + reap-stale-leases.sh
# + restore-godot-original.sh + mcp-sidecar.lib.sh) against every case in the
# boundary matrix, WITHOUT spawning a real Godot editor or proxy. A fake
# workspace root is built with synthetic mcp-lease.json sidecars + pidfiles +
# worktrees; the reaper's behavior on each is asserted.
#
# The 9 cases (per Atlas's boundary matrix in SEE-1129):
#   1. task normal exit    → lease released, editor killed, port freed
#   2. task abnormal exit  → startup reaper detects stale lease, reaps orphan
#   3. same-agent multi-task concurrent → both leases active, same port (the
#      predicate layer handles reuse; here we only assert the reaper does NOT
#      reap a lease whose owner PID is STILL ALIVE — false-positive guard)
#   4. same-agent multi-task sequential → A released, B fresh; no stale residue
#   5. cross-agent grabbing same editor → predicate refuses (covered in
#      test_multi_slot_reuse_predicate.sh); here assert reaper never reaps a
#      live foreign-agent lease either
#   6. daemon restart       → old lease table reaped (owner PIDs all dead)
#   7. port occupied by non-godot process → reaper does NOT reap a live-owner
#      lease just because the port is busy with a foreign listener
#   8. lease file corrupt/half-written/missing fields → quarantined, not crashed
#   9. the observed stale leases → startup sweep cleans them all
#
# Layer contract: addon + proxy upstream protocol untouched. This test only
# exercises the release-layer shell scripts.

set -u
cd "$(dirname "$0")/../../../.." || exit 1

LAUNCH="./launch"
REAPER="$LAUNCH/reap-stale-leases.sh"
STOP="$LAUNCH/stop-godot-editor.sh"
SIDECAR_LIB="$LAUNCH/mcp-sidecar.lib.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

# A unique fake workspace root with NO underscores in paths (the marker
# encoding is lossy, though this test doesn't exercise markers — still safe).
SUF="$(date +%s%N 2>/dev/null || echo $$)"
BASE="/tmp/kol-see1129-${SUF}"
rm -rf "$BASE"; mkdir -p "$BASE"

# Fake MULTICA_DIR (~/.multica) so stop-godot-editor.sh reads synthetic pidfiles.
export HOME="$BASE/home"; mkdir -p "$HOME/.multica"
export TMPDIR="$BASE/tmp"; mkdir -p "$TMPDIR"

# SEE-1242 A-2 (Revy 终裁): hermetic 套件统一禁用 reaper 的 Windows pwsh 探测。
# 生产路径的 Get-Process 只认 Windows PID，对 WSL shell/interop PID 一律误判为死
# —— 这是 C3/C5/C7 假释放的根因；hermetic 模式强制 /proc kill -0 fallback，
# 与 T14 / p3_reclaim 的既有出口完全一致（reaper 生产逻辑零改动）。
export KOL_REAP_DISABLE_PWSH=1

# source the sidecar lib helpers (need die())
# shellcheck source=/dev/null
source_once() { . "$1"; }
SIDECAR_PATH_FOR() { node -e 'process.stdout.write(require("path").join(require("path").dirname(process.argv[1]),".godot","mcp-lease.json"))' "$1"; }

# write_lease <worktree> <port> <agent> <state> <cfg_pid>
write_lease() {
    local wt="$1" port="$2" agent="$3" state="$4" cfgpid="$5"
    mkdir -p "$wt/.godot"
    # A minimal project.godot anchor so restore-godot-original.sh /
    # stop-godot-editor.sh can resolve the worktree root from project.godot.
    [[ -f "$wt/project.godot" ]] || printf 'config_version=5\n' > "$wt/project.godot"
    local lf="$wt/.godot/mcp-lease.json"
    SIDE_WORKTREE="$wt" SIDE_PORT="$port" SIDE_AGENT="$agent" SIDE_PID="$cfgpid" \
    node -e '
        const crypto=require("crypto"),env=process.env;
        const state=process.argv[1],released=state==="released";
        process.stdout.write(JSON.stringify({
            schema_version:1, port:Number(env.SIDE_PORT), agent:env.SIDE_AGENT||"",
            label:(env.SIDE_AGENT||"").toLowerCase(), state,
            lease_id:crypto.randomUUID(), worktree:env.SIDE_WORKTREE||"",
            configured_at:new Date(0).toISOString(), configured_by_pid:Number(env.SIDE_PID)||null,
            released_at:released?new Date(0).toISOString():null, notes:"mock"
        },null,2)+"\n");
    ' "$state" > "$lf"
}

# write_pidfile <label> <pid>   — synthesize ~/.multica/godot-editor-<label>.pid
write_pidfile() { mkdir -p "$HOME/.multica"; printf '%s\n' "$2" > "$HOME/.multica/godot-editor-$1.pid"; }
rm_pidfile()   { rm -f "$HOME/.multica/godot-editor-$1.pid"; }
# reset_multica_dir — wipe the fake MULTICA_DIR between cases so a LIVE pidfile
# written by an earlier case (e.g. C3/C5 write bachi/archi = $$) cannot leak
# into a later case and supply a live editor_pid that masks a stale lease
# (the real root cause of the C6/C9 false-"ACTIVE-but-live" — the reaper reads
# editor_pid from the label's pidfile BEFORE checking staleness).
reset_multica_dir() { rm -rf "$HOME/.multica"; mkdir -p "$HOME/.multica"; }

# A "live" PID for the reaper's owner-liveness probe. The test shell's own PID
# ($$) is always alive under kill -0; it is safe for the REAPER (which only
# probes liveness, never Stop-Process). The STOP companion (case 1) is separate
# — it would Stop-Process the recorded editor PID, so case 1 uses DEAD_PID for
# the editor and asserts only the lease-release path.
#
# SEE-1242 A-2 (Revy 终裁): hermetic 模式（本套件顶部 export KOL_REAP_DISABLE_PWSH=1）
# 下 pid_alive 走 /proc kill -0，$$ 恒活 → C3/C4/C5/C7 断言成立。显式挑选一个
# Windows 可探测进程作为 LIVE_PID 的备选形态不可行：WSL interop 进程在 Windows
# PID 空间中另有编号（/proc/<pid>/winpid 不可用），且 pid_alive 的 LOW-4 校验
# 要求进程名为 godot*——任何真实 Windows 进程都会因名字不匹配被误判"PID 重用"。
LIVE_PID=$$
# A "dead" PID = guaranteed not to exist.
DEAD_PID=999999

lease_state() { node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state||"")}catch(e){process.stdout.write("ABSENT")}' "$1"; }

# ============================================================ Case 1: normal exit
echo "--- Case 1: task normal exit ---"
WT1="$BASE/c1/workdir/KingOfLikes-Godot"
write_lease "$WT1" 6553 Bachi active "$DEAD_PID"
LF1="$WT1/.godot/mcp-lease.json"
write_pidfile bachi "$DEAD_PID"
# stop-godot-editor.sh resolves the holder worktree via the MULTICA_DIR
# .worktree sidecar (same convention as start-godot-editor.sh writes). Seed it
# so the stop companion can locate + release THIS lease.
printf '%s\n' "$WT1" > "$HOME/.multica/godot-editor-bachi.worktree"
# Normal exit → stop-godot-editor.sh: release the lease + (no-op) kill the dead
# editor + clean the pid/worktree sidecars. Assert the lease transitions to
# released (the deterministic, deterministic part — kill on a dead PID is a
# no-op by construction).
KOL_AGENT_NAME=Bachi bash "$STOP" >/dev/null 2>&1 || true
st="$(lease_state "$LF1")"
[[ "$st" == "released" ]] && ok "C1 normal exit: lease released" || bad "C1: lease state=$st want=released"

# ============================================================ Case 2: abnormal exit (startup reaper)
echo "--- Case 2: task abnormal exit (startup reaper) ---"
reset_multica_dir
WT2="$BASE/c2/workdir/KingOfLikes-Godot"
write_lease "$WT2" 6553 Bachi active "$DEAD_PID"   # owner dead → stale
LF2="$WT2/.godot/mcp-lease.json"
write_pidfile bachi "$DEAD_PID"                     # editor pidfile also dead
bash "$REAPER" --root "$BASE/c2" >/dev/null 2>&1 || true
st="$(lease_state "$LF2")"
[[ "$st" == "released" ]] && ok "C2 abnormal exit: stale lease reaped on startup" || bad "C2: lease state=$st want=released"
# pidfile for the dead editor must be cleaned
[[ ! -f "$HOME/.multica/godot-editor-bachi.pid" ]] && ok "C2: dead editor pidfile removed" || bad "C2: pidfile lingered"

# ============================================================ Case 3: same-agent concurrent (LIVE owner NOT reaped)
echo "--- Case 3: same-agent concurrent (false-positive guard) ---"
reset_multica_dir
WT3="$BASE/c3/workdir/KingOfLikes-Godot"
write_lease "$WT3" 6553 Bachi active "$LIVE_PID"    # owner ALIVE
LF3="$WT3/.godot/mcp-lease.json"
write_pidfile bachi "$LIVE_PID"
bash "$REAPER" --root "$BASE/c3" >/dev/null 2>&1 || true
st="$(lease_state "$LF3")"
[[ "$st" == "active" ]] && ok "C3 concurrent: LIVE same-agent lease NOT reaped (no false positive)" || bad "C3: lease state=$st want=active"

# ============================================================ Case 4: sequential (A released, B fresh)
echo "--- Case 4: same-agent sequential (no residue) ---"
reset_multica_dir
mkdir -p "$BASE/c4a/workdir/KingOfLikes-Godot/.godot" "$BASE/c4b/workdir/KingOfLikes-Godot/.godot"
write_lease "$BASE/c4a/workdir/KingOfLikes-Godot" 6553 Bachi released "$DEAD_PID"   # A already released
write_lease "$BASE/c4b/workdir/KingOfLikes-Godot" 6553 Bachi active   "$LIVE_PID"   # B fresh, live
bash "$REAPER" --root "$BASE/c4" >/dev/null 2>&1 || true
sta="$(lease_state "$BASE/c4a/workdir/KingOfLikes-Godot/.godot/mcp-lease.json")"
stb="$(lease_state "$BASE/c4b/workdir/KingOfLikes-Godot/.godot/mcp-lease.json")"
[[ "$sta" == "released" ]] && ok "C4: A stays released (idempotent)" || bad "C4: A state=$sta"
[[ "$stb" == "active" ]]   && ok "C4: B (live) NOT reaped — fresh instance preserved" || bad "C4: B state=$stb"

# ============================================================ Case 5: cross-agent live lease NOT reaped
echo "--- Case 5: cross-agent live lease (reaper doesn't touch live foreign) ---"
reset_multica_dir
WT5="$BASE/c5/workdir/KingOfLikes-Godot"
write_lease "$WT5" 6552 Archi active "$LIVE_PID"   # Archi, live
LF5="$WT5/.godot/mcp-lease.json"
bash "$REAPER" --root "$BASE/c5" >/dev/null 2>&1 || true
st="$(lease_state "$LF5")"
[[ "$st" == "active" ]] && ok "C5: live cross-agent lease NOT reaped (reaper is liveness-based, not agent-based)" || bad "C5: state=$st want=active"

# ============================================================ Case 6: daemon restart (all leases stale)
echo "--- Case 6: daemon restart (all owner PIDs dead) ---"
reset_multica_dir
for h in r1 r2 r3; do
    write_lease "$BASE/c6/$h/workdir/KingOfLikes-Godot" 6553 Bachi active "$DEAD_PID"
done
bash "$REAPER" --root "$BASE/c6" >/dev/null 2>&1 || true
all_released=1
for h in r1 r2 r3; do
    st="$(lease_state "$BASE/c6/$h/workdir/KingOfLikes-Godot/.godot/mcp-lease.json")"
    [[ "$st" == "released" ]] || { all_released=0; break; }
done
(( all_released )) && ok "C6 daemon restart: all 3 stale leases reaped" || bad "C6: a lease not reaped (state=$st)"

# ============================================================ Case 7: port busy with non-godot (live owner NOT reaped)
echo "--- Case 7: port busy with foreign non-godot listener ---"
reset_multica_dir
# Simulate: lease active with LIVE owner; the port happens to be busy but NOT
# by this agent's editor. The reaper must NOT reap a live-owner lease based on
# port-cold logic alone. (We can't easily bind a fake port here without a
# listener; instead assert the live-owner guard takes precedence.)
WT7="$BASE/c7/workdir/KingOfLikes-Godot"
write_lease "$WT7" 6553 Bachi active "$LIVE_PID"
LF7="$WT7/.godot/mcp-lease.json"
bash "$REAPER" --root "$BASE/c7" >/dev/null 2>&1 || true
st="$(lease_state "$LF7")"
[[ "$st" == "active" ]] && ok "C7: live-owner lease NOT reaped even if port logic ambiguous" || bad "C7: state=$st want=active"

# ============================================================ Case 8: corrupt/half-written sidecar
echo "--- Case 8: corrupt sidecar quarantined ---"
reset_multica_dir
WT8="$BASE/c8/workdir/KingOfLikes-Godot"
mkdir -p "$WT8/.godot"
# half-written JSON (truncated)
printf '{"schema_version":1,"port":6553,"agent":"Bachi","state":"acti' > "$WT8/.godot/mcp-lease.json"
# missing required field
mkdir -p "$BASE/c8b/workdir/KingOfLikes-Godot/.godot"
printf '{"schema_version":1,"port":6553,"state":"active"}' > "$BASE/c8b/workdir/KingOfLikes-Godot/.godot/mcp-lease.json"
bash "$REAPER" --root "$BASE/c8"  >/dev/null 2>&1 || true
bash "$REAPER" --root "$BASE/c8b" >/dev/null 2>&1 || true
# Both should be quarantined (renamed to .corrupt-*) — reaper must not crash.
quarantined=0
ls "$WT8/.godot/"*.corrupt-* >/dev/null 2>&1 && quarantined=1
[[ -f "$WT8/.godot/mcp-lease.json" ]] && quarantined=0   # original must be gone
(( quarantined )) && ok "C8a: corrupt half-written sidecar quarantined" || bad "C8a: corrupt sidecar not quarantined"
quarantined2=0
ls "$BASE/c8b/workdir/KingOfLikes-Godot/.godot/"*.corrupt-* >/dev/null 2>&1 && quarantined2=1
[[ -f "$BASE/c8b/workdir/KingOfLikes-Godot/.godot/mcp-lease.json" ]] && quarantined2=0
(( quarantined2 )) && ok "C8b: missing-field sidecar quarantined" || bad "C8b: missing-field sidecar not quarantined"

# ============================================================ Case 9: the observed stale leases (sweep)
echo "--- Case 9: observed-stale-leases sweep (all dead, mixed agents) ---"
reset_multica_dir
# Model the real observed state: 11 active leases across 4 agents, all with
# dead owner PIDs (what was actually on disk before the fix).
agents_pids=( "Atlas:6551:1001" "Atlas:6551:1002" "Bachi:6553:1003" "Bachi:6553:1004" "Bachi:6553:1005" "Archi:6552:1006" "Archi:6552:1007" "Revy:6555:1008" "Revy:6555:1009" "Fronti:6554:1010" "Refacty:6556:1011" )
idx=0
for ap in "${agents_pids[@]}"; do
    agent="${ap%%:*}"; rest="${ap#*:}"; port="${rest%%:*}"; pid="${rest#*:}"
    write_lease "$BASE/c9/slot${idx}/workdir/KingOfLikes-Godot" "$port" "$agent" active "$pid"
    idx=$((idx+1))
done
# Also 3 released leases (must be left untouched)
for r in ra rb rc; do
    write_lease "$BASE/c9/$r/workdir/KingOfLikes-Godot" 6553 Bachi released "$DEAD_PID"
done
bash "$REAPER" --root "$BASE/c9" >/dev/null 2>&1 || true
all_active_released=1
for ap in "${agents_pids[@]}"; do :; done   # noop
idx=0
for ap in "${agents_pids[@]}"; do
    st="$(lease_state "$BASE/c9/slot${idx}/workdir/KingOfLikes-Godot/.godot/mcp-lease.json")"
    [[ "$st" == "released" ]] || { all_active_released=0; echo "  slot${idx} state=$st"; }
    idx=$((idx+1))
done
(( all_active_released )) && ok "C9: all 11 stale active leases reaped" || bad "C9: some stale lease not reaped"
# released ones stay released (idempotent — not quarantined, not touched)
for r in ra rb rc; do
    st="$(lease_state "$BASE/c9/$r/workdir/KingOfLikes-Godot/.godot/mcp-lease.json")"
    [[ "$st" == "released" ]] || bad "C9: released lease $r disturbed (state=$st)"
done
ok "C9: pre-released leases left untouched (idempotent)"

# ============================================================ Cleanup
rm -rf "$BASE"

echo
echo "pass=$PASS fail=$FAIL"
[[ "$FAIL" -eq 0 ]]
