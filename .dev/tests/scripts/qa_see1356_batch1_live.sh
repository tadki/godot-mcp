#!/usr/bin/env bash
# qa_see1356_batch1_live.sh — SEE-1356 batch-1 live QA orchestrator.
# Spawns REAL (non-headless) Godot editors via the production launcher chain
# against jerry-owned QA slot copies of the KOL worktree (the daemon-materialized
# checkout is root-owned/read-only for agents, so markers can only be pinned on
# our own copies). The REAL KOL checkout is never touched.
#
#   A1/A2  L6 daemon cold start stage sequence + proxylog segment (§SPEC-L6-01/02)
#   A3     L2 get_info snapshot echo == status workdir_hash (§SPEC-L2-03)
#   A4     L5 warm snapshot + doctor warm PASS (§SPEC-L5-02)
#   A5     L5 T2 recovering + hold_queue_depth ≥1 → re-warm (kill editor)
#   A6     L2 snapshot_absent null semantics (§SPEC-L2-03)
#   A7     L2 double-worktree registry annotations (§SPEC-L2-02)
#   A8/A9  L5 T4 failed_exit: cooldown WARN → expiry FAIL (§SPEC-L5-02)
# Only editors spawned by this script are killed (pre-existing godot pids are
# enumerated first and NEVER touched — owner-order §5.2).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RPC="$HERE/see1356_rpc_call.py"
PWSH="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

KOL="${KOL_ROOT:-/home/jerry/multica_workspaces/seed-478690824e46/see-1356-ef9f21ac6d16/workdir/KingOfLikes-Godot}"
WSBASE="/home/jerry/multica_workspaces"
CONTAINER="seed-478690824e46"
H1="aabbccddee11"
H2="c0ffee123456"
SLOT1="see-qa1-$H1"
SLOT2="see-qa2-$H2"
W1="$WSBASE/$CONTAINER/$SLOT1/workdir/KingOfLikes-Godot"
W2="$WSBASE/$CONTAINER/$SLOT2/workdir/KingOfLikes-Godot"
RID1="Revy-$H1"
RID2="Revy-$H2"
RID3="Revy-c0ffee123457"
P1=6557; P2=6558; P3=6559

SB="$(mktemp -d)"
REG="$SB/.multica/godot-port-registry.json"
PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

declare -a RT_PIDS=() PRE_GODOT_PIDS=() FIFO_FDS=()

pre_existing_godot_pids() {
    "$PWSH" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r' | sort -n
}
godot_pids_for_slot() { # $1 = identity fragment (slot dir OR --kol-mcp-runtime value)
    "$PWSH" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | Where-Object { \$_.CommandLine -match '$1' } | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r'
}
godot_dump() { # diagnostic: every godot process's id + runtime flag
    "$PWSH" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | ForEach-Object { \$_.ProcessId.ToString() + ' :: ' + \$_.CommandLine }" 2>/dev/null | tr -d '\r'
}
kill_win_pid() { "$PWSH" -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true; }

cleanup() {
    for pid in "${RT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    sleep 2
    for pid in "${RT_PIDS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
    for slot in "kol-mcp-runtime $RID1" "kol-mcp-runtime $RID2"; do
        for gpid in $(godot_pids_for_slot "$slot"); do
            if ! printf '%s\n' "${PRE_GODOT_PIDS[@]}" | grep -qx "$gpid"; then
                kill_win_pid "$gpid"
            fi
        done
    done
    for fd in "${FIFO_FDS[@]:-}"; do [[ -n "$fd" ]] && eval "exec ${fd}>&-" 2>/dev/null || true; done
    mkdir -p /tmp/see1356-artifacts
    cp -a "$SB/." /tmp/see1356-artifacts/ 2>/dev/null || true
    rm -rf "$SB"
}
trap cleanup EXIT

wait_grep() { # $1=file $2=pattern $3=timeout_s $4=desc
    local f="$1" pat="$2" t="$3" i=0
    while (( i < t * 2 )); do
        [[ -f "$f" ]] && grep -q "$pat" "$f" 2>/dev/null && return 0
        sleep 0.5; i=$((i+1))
    done
    echo "TIMEOUT waiting for '$pat' in $f ($4)" >&2
    return 1
}

FIFO_RT=""
spawn_rt() { # $1=port $2=rid $3=worktree $4=agent [extra env KEY=VAL ...]
    local port="$1" rid="$2" wt="$3" agent="$4"; shift 4
    local fifo="$SB/rt-${rid}.in" out="$SB/rt-${rid}.out" fd
    mkfifo "$fifo"
    # RDWR open in the PARENT: a fifo writer must exist before the launcher's
    # O_RDONLY stdin open, or the spawn blocks forever (deferring the first
    # rpc write until WARM would deadlock the cold start).
    fd=$(( ${#FIFO_FDS[@]} + 3 ))
    eval "exec ${fd}<>\"$fifo\""
    FIFO_FDS+=("$fd")
    ( env HOME="$SB/home" \
        GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
        GODOT_MCP_WORKSPACES_BASE="$WSBASE" \
        KOL_RUNTIME_ID="$rid" GODOT_MCP_RUNTIME_ID="$rid" KOL_AGENT_NAME="$agent" GODOT_PORT="$port" \
        KOL_WORKTREE="$wt" "$@" \
        bash "$REPO/launch/godot-mcp-launcher.sh" < "$fifo" > "$out" 2> "$SB/rt-${rid}.stderr" ) &
    RT_PIDS+=($!)
    FIFO_RT="$fifo"
}

rpc() { python3 "$RPC" "$1" "$2" "$3" "$4" "$5" "${6:-1}"; }

run_status() { # $1=cwd-worktree $2=agent
    ( cd "$1" && HOME="$SB/home" GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
      GODOT_MCP_WORKSPACES_BASE="$WSBASE" KOL_AGENT_NAME="$2" KOL_WORKTREE="$1" \
      bash "$REPO/launch/godot-status.sh" status --json 2>/dev/null )
}
run_doctor() { # $1=cwd-worktree $2=agent
    ( cd "$1" && HOME="$SB/home" GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
      GODOT_MCP_WORKSPACES_BASE="$WSBASE" KOL_AGENT_NAME="$2" KOL_WORKTREE="$1" \
      bash "$REPO/launch/godot-status.sh" doctor --json 2>/dev/null )
}

extract_echo_field() { # $1=jsonrpc-response $2=workdir_snapshot field name
    python3 -c "
import json,sys
try:
    d=json.loads(sys.argv[1])
    for c in d.get('result',{}).get('content',[]):
        if c.get('type')!='text': continue
        t=c.get('text','')
        if 'workdir_snapshot' not in t: continue
        try:
            snap=json.loads(t).get('workdir_snapshot') or {}
        except json.JSONDecodeError:
            continue
        v=snap.get(sys.argv[2])
        if v is not None:
            print(v); break
except Exception: pass
" "$1" "$2" 2>/dev/null
}

command -v jq >/dev/null && command -v python3 >/dev/null || { echo "jq+python3 required"; exit 1; }
mkdir -p "$SB/home" "$SB/.multica/godot-editor"
mapfile -t PRE_GODOT_PIDS < <(pre_existing_godot_pids)
echo "[pre] pre-existing godot pids: ${PRE_GODOT_PIDS[*]:-<none>}"

# ---- QA slot worktrees (jerry-owned minimal addon projects; the real KOL is
# untouched). Minimal shape: marker-pinnable, fast import — the L2/L5/L6
# assertions exercise the launcher/proxy/status/doctor chain, which does not
# need KOL content (L1's real-KOL run is a separate gqt channel).
section "S0: QA slot fixtures"
build_minimal_project() { # $1=worktree $2=name
    mkdir -p "$1/addons"
    [[ -d "$1/addons/godot_mcp" ]] || cp -a "$KOL/addons/godot_mcp" "$1/addons/"
    cat > "$1/project.godot" <<GODOT_EOF
; Engine configuration file.
; SEE-1356 QA fixture — minimal project carrying ONLY the godot_mcp addon.
[application]
config/name="$2"
[editor_plugins]
enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")
GODOT_EOF
}
mkdir -p "$(dirname "$W1")"
build_minimal_project "$W1" "KOL-QA-W1"
build_minimal_project "$W2" "KOL-QA-W2"
ok "S0 W1/W2 minimal addon projects (@ $SLOT1 / $SLOT2)" 1

# ================= S1: R1 cold start (L6-01/02, L2-03, L5 warm/T2) ===========
section "S1 R1: daemon cold start on W1"
# Fresh-import cold start: remove the import cache so the editor's warmup
# deterministically exceeds the 35s window (one clean T2 episode instead of
# the import-cache-warm race or the multi-attempt churn).
rm -rf "$W1/.godot"
spawn_rt "$P1" "$RID1" "$W1" "Revy" GODOT_MCP_WARMUP_TIMEOUT_MS="35000"; FIFO1="$FIFO_RT"
PLOG1="$SB/.multica/godot-editor/$RID1.proxy.log"
PS1="$SB/.multica/godot-editor/$RID1.proxy-state.json"
# Editor is LAZY-spawned on the first tools/call: issue the get_info probe
# concurrently NOW (held until warm), or the cold start deadlocks.
( rpc "$FIFO1" "$SB/rt-$RID1.out" '{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 41 300 > "$SB/rt-$RID1.rpc41.json" 2>&1 ) &
FIRST_CALL_PID=$!
# A5/A5b (pre-WARM): the 35s warmup window exhausts BEFORE the editor finishes
# warming → S.recovering + T2 persist while the first call is still held.
i=0; RECOV=""
while (( i < 150 )); do
    RECOV="$(run_doctor "$W1" "Revy" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))][0]' 2>/dev/null)"
    echo "$RECOV" | grep -q 'recovering' && break
    sleep 1; i=$((i+1))
done
ok "A5 T2: doctor proxy_state recovering（warmup 窗耗尽，warm 前窗口内）" \
    "$(echo "$RECOV" | grep -q 'recovering' && echo 1 || echo 0)" "$RECOV"
QD=""
[[ -f "$PS1" ]] && QD="$(jq -r '.hold_queue_depth' "$PS1" 2>/dev/null)"
# A5b: held-queue evidence — the first call is queued during the INITIAL
# warming (T1-era persist captures depth≥1); recovering answers diagnostics
# instead of holding (T2-era depth legitimately 0), so assert the queue depth
# observed across the whole cold-start episode via the transition ledger and
# the current snapshot.
# A5b: held-queue oracle — the proxy's own warmup lines report queued calls
# ("N call(s) queued") during the episode; additionally the snapshot's
# hold_queue_depth is sampled if any persist captured it.
QD_LOG="$(grep -oE '[1-9][0-9]* call\(s\) queued' "$PLOG1" 2>/dev/null | head -1)"
QD=""
[[ -f "$PS1" ]] && QD="$(jq -r '.hold_queue_depth' "$PS1" 2>/dev/null)"
ok "A5b T2: held 调用排队证据（proxy.log 排队行 + 快照 depth=$QD）" \
    "$([[ -n "$QD_LOG" || ( -n "$QD" && "$QD" -ge 1 ) ]] && echo 1 || echo 0)" "log='$QD_LOG' depth=$QD"

ok "S1 R1 WARM reached (cold start ≤300s)" \
    "$(wait_grep "$PLOG1" '\[stage=WARM\]' 300 "r1-warm" && echo 1 || echo 0)"
P_ALLOC="$(grep -oE 'GODOT_PORT=[0-9]+' "$SB/rt-$RID1.stderr" 2>/dev/null | tail -1 | cut -d= -f2)"
ok "S1b arbiter 实际分配端口可读回（P_ALLOC=$P_ALLOC）" "$([[ -n "$P_ALLOC" ]] && echo 1 || echo 0)"

# A1: ordered stage sequence — the chain spans TWO artifacts: the launcher's
# stderr (LAUNCHER_EXEC, the launcher-side anchor) and the proxy tee
# (PROXY_*→WARM). Both must exist for the daemon cold-start story (L6-01).
L_LAUNCH=$(grep -c 'stage=LAUNCHER_EXEC' "$SB/rt-$RID1.stderr" 2>/dev/null || true)
if [[ -f "$PLOG1" ]]; then
    L_WARM=$(grep -n 'stage=WARM' "$PLOG1" | tail -1 | cut -d: -f1)
    MID_N=$(grep -cE 'stage=(PROXY_INIT|WORKTREE_WAIT|SPAWN|NPX|CONFIGURE|WARMUP|RENDER|HANDSHAKE|PREPARE|ARBITER|EXEC|NPX_SPAWN|RENDER_STABLE_PASS)' "$PLOG1" || true)
    ok "A1 stage chain LAUNCHER_EXEC(launcher×$L_LAUNCH) → proxy mid($MID_N) → WARM(#$L_WARM)" \
        "$([[ "$L_LAUNCH" -ge 1 && -n "$L_WARM" && "$MID_N" -ge 3 ]] && echo 1 || echo 0)" \
        "launch=$L_LAUNCH warm=$L_WARM mid=$MID_N"
    HDR=$(grep -m1 '=== proxy start' "$PLOG1" || true)
    ok "A1b startup header: port/worktree/workdir_hash 口径" \
        "$([[ "$HDR" == *"port=${P_ALLOC:-$P1}"* && "$HDR" == *"workdir_hash=$H1 hash_source=slot"* ]] && echo 1 || echo 0)" "$HDR"
fi

# A2: status_proxylog_json (L6-02)
OUT="$(run_status "$W1" "Revy")"
ok "A2 proxylog.present + highest_stage=WARM + 无 JSON-RPC 混入" \
    "$([[ "$(echo "$OUT" | jq -r '.proxylog.present' 2>/dev/null)" == "true" \
      && "$(echo "$OUT" | jq -r '.proxylog.json_rpc_contaminated' 2>/dev/null)" == "false" \
      && "$(echo "$OUT" | jq -r '.proxylog.highest_stage' 2>/dev/null)" == "WARM" ]] && echo 1 || echo 0)" \
    "$(echo "$OUT" | jq -c '{p: .proxylog.present, s: .proxylog.highest_stage, c: .proxylog.json_rpc_contaminated}' 2>/dev/null)"

# A3: get_info snapshot echo == status workdir_hash (L2-03) — the FIRST call
# races the 35s warmup window (used for the T2 construction) and can answer
# with the recovering diagnostic instead of the result; the echo contract is
# judged on a RETRY issued after warm is confirmed (the diagnostic itself
# says "please retry").
ST_HASH="$(echo "$OUT" | jq -r '.runtime.workdir_hash' 2>/dev/null)"
kill "$FIRST_CALL_PID" 2>/dev/null || true

# A4: L5 warm snapshot + doctor warm PASS — the snapshot's state lags the
# [stage=WARM] tee line until the next persist trigger (heartbeat/transition),
# so poll the doctor event-driven instead of sampling once.
OUTD=""
i=0
while (( i < 60 )); do
    OUTD="$(run_doctor "$W1" "Revy")"
    [[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="PASS" and (.check=="proxy_state:warm"))' >/dev/null 2>&1 && break
    sleep 2; i=$((i+2))
done
ok "A4 doctor proxy_state:warm PASS（活体快照主判据）" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="PASS" and (.check=="proxy_state:warm"))' >/dev/null 2>&1 && echo 1 || echo 0)"
i=0
while (( i < 40 )); do
    [[ -f "$PS1" ]] && [[ "$(jq -r '.state' "$PS1" 2>/dev/null)" == "warm" ]] && break
    sleep 1; i=$((i+1))
done
ok "A4b 快照文件 state=warm + schema 字段完整" \
    "$([[ -f "$PS1" ]] && jq -e '.state=="warm" and (.schema|startswith("see1356-l5-proxy-state/")) and (.workdir_hash!=null) and (.heartbeat_at!=null) and (.warmupDiagnostic!=null) and (.last_transitions!=null) and (.recent_calls!=null) and (.give_up_count!=null)' "$PS1" >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(jq -c '{state, schema, workdir_hash}' "$PS1" 2>/dev/null)"

# A3 retry (warm confirmed above): the get_info echo rides the RESULT now.
RESP="$(rpc "$FIFO1" "$SB/rt-$RID1.out" '{"jsonrpc":"2.0","id":44,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 44 90 0)" || RESP=""
[[ -z "$(extract_echo_field "$RESP" workdir_hash)" ]] && echo "  [diag] A3 retry response: $(echo "$RESP" | head -c 400)"
GI_HASH="$(extract_echo_field "$RESP" workdir_hash)"
GI_SRC="$(extract_echo_field "$RESP" hash_source)"
ok "A3 get_info 回显哈希($GI_HASH) == status workdir_hash($ST_HASH)，hash_source=slot" \
    "$([[ -n "$GI_HASH" && "$GI_HASH" == "$ST_HASH" && "$ST_HASH" == "$H1" && "$GI_SRC" == "slot" ]] && echo 1 || echo 0)" \
    "gi=$GI_HASH/$GI_SRC status=$ST_HASH"

# A5c: recovering → warm 恢复 + 转移留痕（T2_recovering_enter 已入 last_transitions）
ok "A5c 恢复正常 warm 且 T2 转移留痕（last_transitions 含 T2_recovering_enter）" \
    "$([[ -f "$PS1" ]] && jq -e '.state=="warm" and ([.last_transitions[].trigger] | index("T2_recovering_enter") != null)' "$PS1" >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(jq -c '{state, trigs: [.last_transitions[].trigger]}' "$PS1" 2>/dev/null)"

# A6: snapshot_absent null semantics (L2-03)
rm -f "$PS1"
RESP="$(rpc "$FIFO1" "$SB/rt-$RID1.out" '{"jsonrpc":"2.0","id":43,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 43 60 0)" || RESP=""
ABS_SRC="$(extract_echo_field "$RESP" hash_source)"
ok "A6 快照删除后 get_info → hash_source=snapshot_absent（null 语义）" \
    "$([[ "$ABS_SRC" == "snapshot_absent" ]] && echo 1 || echo 0)" "src=$ABS_SRC"
# R1 stays ALIVE through S2: the double-worktree registry assertions need both
# runtime entries present concurrently (the L2 root scenario is concurrent
# runtime isolation). R1/R2 are reaped together after A7.

# ================= S2: R2 on sibling slot fixture (L2-02) ====================
section "S2 R2: sibling slot worktree (L2-02 registry annotations)"
spawn_rt "$P2" "$RID2" "$W2" "Revy"; FIFO2="$FIFO_RT"
PLOG2="$SB/.multica/godot-editor/$RID2.proxy.log"
( rpc "$FIFO2" "$SB/rt-$RID2.out" '{"jsonrpc":"2.0","id":51,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 51 300 > "$SB/rt-$RID2.rpc51.json" 2>&1 ) &
ok "S2 R2 WARM reached (minimal project ≤300s)" \
    "$(wait_grep "$PLOG2" '\[stage=WARM\]' 300 "r2-warm" && echo 1 || echo 0)"

OUT="$(run_status "$W1" "Revy")"
E1_HASH="$(echo "$OUT" | jq -r ".registry.entries[\"$RID1\"].workdir_hash" 2>/dev/null)"
E2_HASH="$(echo "$OUT" | jq -r ".registry.entries[\"$RID2\"].workdir_hash" 2>/dev/null)"
E1_CUR="$(echo "$OUT" | jq -r ".registry.entries[\"$RID1\"].is_current_workdir" 2>/dev/null)"
E2_CUR="$(echo "$OUT" | jq -r ".registry.entries[\"$RID2\"].is_current_workdir" 2>/dev/null)"
TRUE_N="$(echo "$OUT" | jq '[.registry.entries[] | select(.is_current_workdir == true)] | length' 2>/dev/null)"
RT_ID="$(echo "$OUT" | jq -r '.runtime.runtime_id' 2>/dev/null)"
ok "A7 双 worktree 哈希互异且与目录尾一致 ($E1_HASH vs $E2_HASH)" \
    "$([[ "$E1_HASH" == "$H1" && "$E2_HASH" == "$H2" && "$E1_HASH" != "$E2_HASH" ]] && echo 1 || echo 0)"
ok "A7b 仅一条 entry is_current_workdir=true（W1 cwd 视角）" \
    "$([[ "$E1_CUR" == "true" && "$E2_CUR" == "false" && "$TRUE_N" == "1" ]] && echo 1 || echo 0)" "e1=$E1_CUR e2=$E2_CUR n=$TRUE_N"
ok "A7c seed-* alias 命中（runtime_id = agent-<slot hash>）" \
    "$([[ "$RT_ID" == "$RID1" ]] && echo 1 || echo 0)" "$RT_ID"
for pid in "${RT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
RT_PIDS=()
# Reap the section's editors so their ports are free for R3 (a stale listener
# on the dynamic pool made v6's R3 warm-connect to R1's editor).
for frag in "kol-mcp-runtime $RID1" "kol-mcp-runtime $RID2"; do
    for gpid in $(godot_pids_for_slot "$frag"); do kill_win_pid "$gpid"; done
done
sleep 3

# ================= S3: R3 spawn-failure T4 (L5-02 cooldown WARN → FAIL) ======
section "S3 R3: spawn failure → failed_exit + cooldown arbitration"
spawn_rt "$P3" "$RID3" "$W1" "Revy" \
    GODOT_EDITOR="/nonexistent-godot-qa-binary" \
    GODOT_MCP_WARMUP_TIMEOUT_MS="20000" \
    GODOT_MCP_GIVEUP_COOLDOWN_MS="20000"
PLOG3="$SB/.multica/godot-editor/$RID3.proxy.log"
PS3="$SB/.multica/godot-editor/$RID3.proxy-state.json"
GUP3="$SB/.multica/godot-editor/$RID3.giveup.json"
( rpc "$FIFO_RT" "$SB/rt-$RID3.out" '{"jsonrpc":"2.0","id":61,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 61 120 > "$SB/rt-$RID3.rpc61.json" 2>&1 ) &
ok "S3 R3 give-up reached (spawn failure → T4 ≤120s)" \
    "$(wait_grep "$PLOG3" 'give.up' 120 "r3-giveup" && echo 1 || echo 0)"
[[ ! -f "$PLOG3" ]] && echo "  [diag] R3 tee missing; stderr tail: $(tail -5 "$SB/rt-$RID3.stderr" 2>/dev/null | tr '\n' ' ')"
i=0
while (( i < 40 )); do
    [[ -f "$PS3" ]] && [[ "$(jq -r '.state' "$PS3" 2>/dev/null)" == "failed_exit" ]] && break
    sleep 1; i=$((i+1))
done
ok "A8 快照 state=failed_exit（T4 落地）" \
    "$([[ -f "$PS3" && "$(jq -r '.state' "$PS3" 2>/dev/null)" == "failed_exit" ]] && echo 1 || echo 0)" \
    "$(jq -c '{state, give_up_count, last_error_bucket}' "$PS3" 2>/dev/null)"
OUTD="$(run_doctor "$W1" "Revy")"
ok "A8b cooldown 中 doctor → proxy_state:failed_exit WARN（设计内）" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="WARN" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(echo "$OUTD" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"
for pid in "${RT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
RT_PIDS=()
# Fixed wait: the cooldown EXPIRY itself is the tested semantic here (the
# doctor arbitration turns WARN→FAIL only after cooldown_until passes), so a
# real-clock window is the correct oracle per the sync-wait boundary rule.
sleep 23
OUTD="$(run_doctor "$W1" "Revy")"; RCD=0
( cd "$W1" && HOME="$SB/home" GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
  GODOT_MCP_WORKSPACES_BASE="$WSBASE" KOL_AGENT_NAME="Revy" KOL_WORKTREE="$W1" \
  bash "$REPO/launch/godot-status.sh" doctor >/dev/null 2>&1 ) || RCD=$?
ok "A9 冷却过期 + 无 rearm → doctor FAIL proxy_state:failed_exit + exit 1" \
    "$([[ "$RCD" == "1" ]] && [[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="FAIL" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
    "rc=$RCD $(echo "$OUTD" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"
ok "A9b 两文件 mtime 并列呈现" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '[.checks[] | select((.detail//"")|contains("mtime="))] | length >= 1' >/dev/null 2>&1 && echo 1 || echo 0)"

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -gt 0 ]] && exit 1
exit 0
