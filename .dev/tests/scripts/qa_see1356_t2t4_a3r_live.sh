#!/usr/bin/env bash
# qa_see1356_t2t4_a3r_live.sh — SEE-1356 focused live constructs:
#   T2T4: editor-alive-but-never-MCP-warm (no addon in the worktree) — the
#         deterministic COLD-branch path: warmup window exhausts with
#         S.warm=false → coarse state=recovering (T2) → FAILED_EXIT →
#         give_up (T4) → cooldown WARN → expiry FAIL (§SPEC-L5-02 全仲裁链)
#   A3R:  clean warm runtime → get_info workdir_snapshot echo == status
#         workdir_hash (§SPEC-L2-03), snapshot_absent null semantics
# Only editors spawned by this script are killed (pre-existing pids protected).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RPC="$HERE/see1356_rpc_call.py"
PWSH="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

KOL="${KOL_ROOT:-/home/jerry/multica_workspaces/seed-478690824e46/see-1356-ef9f21ac6d16/workdir/KingOfLikes-Godot}"
WSBASE="/home/jerry/multica_workspaces"
CONTAINER="seed-478690824e46"
H1="aabbccddee11"
H3="c0ffee123457"
SLOT1="see-qa1-$H1"
SLOT3="see-qa3-$H3"
W1="$WSBASE/$CONTAINER/$SLOT1/workdir/KingOfLikes-Godot"
W3="$WSBASE/$CONTAINER/$SLOT3/workdir/KingOfLikes-Godot"
RID1="Revy-$H1"
RID3="Revy-$H3"

SB="$(mktemp -d)"
REG="$SB/.multica/godot-port-registry.json"
PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

declare -a RT_PIDS=() PRE_GODOT_PIDS=() FIFO_FDS=()

pre_existing_godot_pids() {
    "$PWSH" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r' | sort -n
}
godot_pids_for_slot() {
    "$PWSH" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | Where-Object { \$_.CommandLine -match '$1' } | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r'
}
kill_win_pid() { "$PWSH" -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true; }

cleanup() {
    for pid in "${RT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    sleep 2
    for pid in "${RT_PIDS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
    for frag in "kol-mcp-runtime $RID1" "kol-mcp-runtime $RID3"; do
        for gpid in $(godot_pids_for_slot "$frag"); do
            if ! printf '%s\n' "${PRE_GODOT_PIDS[@]}" | grep -qx "$gpid"; then
                kill_win_pid "$gpid"
            fi
        done
    done
    for fd in "${FIFO_FDS[@]:-}"; do [[ -n "$fd" ]] && eval "exec ${fd}>&-" 2>/dev/null || true; done
    mkdir -p /tmp/see1356-artifacts-t2t4
    cp -a "$SB/." /tmp/see1356-artifacts-t2t4/ 2>/dev/null || true
    rm -rf "$SB"
}
trap cleanup EXIT

wait_grep() {
    local f="$1" pat="$2" t="$3" i=0
    while (( i < t * 2 )); do
        [[ -f "$f" ]] && grep -q "$pat" "$f" 2>/dev/null && return 0
        sleep 0.5; i=$((i+1))
    done
    echo "TIMEOUT waiting for '$pat' in $f ($4)" >&2
    return 1
}

FIFO_RT=""
spawn_rt() {
    local port="$1" rid="$2" wt="$3" agent="$4"; shift 4
    local fifo="$SB/rt-${rid}.in" out="$SB/rt-${rid}.out" fd
    mkfifo "$fifo"
    fd=$(( ${#FIFO_FDS[@]} + 3 ))
    eval "exec ${fd}<>\"$fifo\""
    FIFO_FDS+=("$fd")
    ( cd "$wt" && env HOME="$SB/home" \
        GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
        GODOT_MCP_WORKSPACES_BASE="$WSBASE" \
        KOL_RUNTIME_ID="$rid" GODOT_MCP_RUNTIME_ID="$rid" KOL_AGENT_NAME="$agent" GODOT_PORT="$port" \
        KOL_WORKTREE="$wt" "$@" \
        bash "$REPO/launch/godot-mcp-launcher.sh" --port "$port" < "$fifo" > "$out" 2> "$SB/rt-${rid}.stderr" ) &
    RT_PIDS+=($!)
    FIFO_RT="$fifo"
}

rpc() { python3 "$RPC" "$1" "$2" "$3" "$4" "$5" "${6:-1}"; }

run_status() {
    ( cd "$1" && HOME="$SB/home" GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
      GODOT_MCP_WORKSPACES_BASE="$WSBASE" KOL_AGENT_NAME="$2" KOL_WORKTREE="$1" \
      bash "$REPO/launch/godot-status.sh" status --json 2>/dev/null )
}
run_doctor() {
    ( cd "$1" && HOME="$SB/home" GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
      GODOT_MCP_WORKSPACES_BASE="$WSBASE" KOL_AGENT_NAME="$2" KOL_WORKTREE="$1" \
      bash "$REPO/launch/godot-status.sh" doctor --json 2>/dev/null )
}

extract_echo_field() {
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

# ---------- fixtures: W3 no-addon (T2T4), W1 addon (A3R) --------------------
section "S0: fixtures"
mkdir -p "$W3"
# Editors running on Windows map file ownership to root under WSL; a fixture
# file touched by a previous editor is root-owned — remove before rewrite
# (the QA slot directory itself is jerry-owned, so rm always succeeds).
rm -f "$W3/project.godot"
cat > "$W3/project.godot" <<'GODOT_EOF'
; Engine configuration file.
; SEE-1356 QA fixture — NO godot_mcp addon: the editor opens fine but never
; listens on the MCP port (deterministic cold-branch "editor 装死" construct).
[application]
config/name="KOL-QA-W3-NOADDON"
GODOT_EOF
[[ -d "$W1/addons/godot_mcp" ]] || { mkdir -p "$W1/addons"; cp -a "$KOL/addons/godot_mcp" "$W1/addons/"; }
rm -f "$W1/project.godot"
cat > "$W1/project.godot" <<'GODOT_EOF'
[application]
config/name="KOL-QA-W1"
[editor_plugins]
enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")
GODOT_EOF
ok "S0 W3 (no-addon) + W1 (addon) fixtures" 1

# ================= T2T4: cold-branch recovering → FAILED_EXIT → give_up ======
section "T2T4: no-addon worktree → recovering → failed_exit → cooldown → FAIL"
spawn_rt 6640 "$RID3" "$W3" "Revy" \
    GODOT_MCP_WARMUP_TIMEOUT_MS="35000" \
    GODOT_MCP_GIVEUP_COOLDOWN_MS="20000"
FIFO3="$FIFO_RT"
PLOG3="$SB/.multica/godot-editor/$RID3.proxy.log"
PS3="$SB/.multica/godot-editor/$RID3.proxy-state.json"
( rpc "$FIFO3" "$SB/rt-$RID3.out" '{"jsonrpc":"2.0","id":61,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 61 300 > "$SB/rt-$RID3.rpc61.json" 2>&1 ) &

# T2: window exhausts with S.warm=false (no addon → never listens) → recovering
i=0; RECOV=""
while (( i < 120 )); do
    RECOV="$(run_doctor "$W3" "Revy" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))][0]' 2>/dev/null)"
    echo "$RECOV" | grep -q 'recovering' && break
    sleep 1; i=$((i+1))
done
ok "T2 快照 state=recovering（无 addon 冷分支，editor 活着但永不 warm）" \
    "$(echo "$RECOV" | grep -q 'recovering' && echo 1 || echo 0)" "$RECOV"
QD_LOG="$(grep -oE '[1-9][0-9]* call\(s\) queued' "$PLOG3" 2>/dev/null | head -1)"
ok "T2b held 调用排队（proxy.log 排队行）" \
    "$([[ -n "$QD_LOG" ]] && echo 1 || echo 0)" "log='$QD_LOG'"

# T4: FAILED_EXIT (2×35s) → give_up + giveup file + cooldown WARN
i=0
while (( i < 120 )); do
    [[ -f "$PS3" ]] && [[ "$(jq -r '.state' "$PS3" 2>/dev/null)" == "failed_exit" ]] && break
    sleep 1; i=$((i+1))
done
ok "T4 快照 state=failed_exit（FAILED_EXIT 落地）" \
    "$([[ -f "$PS3" && "$(jq -r '.state' "$PS3" 2>/dev/null)" == "failed_exit" ]] && echo 1 || echo 0)" \
    "$(jq -c '{state, give_up_count, last_error_bucket}' "$PS3" 2>/dev/null)"
GUP3="$SB/.multica/godot-editor/$RID3.giveup.json"
ok "T4b giveup 文件落盘（give_up_count ≥ 1 + cooldown_until 在场）" \
    "$([[ -f "$GUP3" ]] && jq -e '.giveup_count >= 1 and (.cooldown_until != null)' "$GUP3" >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(jq -c '{giveup_count, cooldown_until}' "$GUP3" 2>/dev/null)"
OUTD="$(run_doctor "$W3" "Revy")"
ok "T4c cooldown 中 doctor → proxy_state:failed_exit WARN（设计内）" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="WARN" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(echo "$OUTD" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"
for pid in "${RT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
RT_PIDS=()
# Fixed wait: the cooldown EXPIRY is the tested semantic (WARN→FAIL 翻转窗).
sleep 23
OUTD="$(run_doctor "$W3" "Revy")"; RCD=0
( cd "$W3" && HOME="$SB/home" GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
  GODOT_MCP_WORKSPACES_BASE="$WSBASE" KOL_AGENT_NAME="Revy" KOL_WORKTREE="$W3" \
  bash "$REPO/launch/godot-status.sh" doctor >/dev/null 2>&1 ) || RCD=$?
ok "T4d 冷却过期 + 无 rearm → doctor FAIL proxy_state:failed_exit + exit 1" \
    "$([[ "$RCD" == "1" ]] && [[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="FAIL" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
    "rc=$RCD $(echo "$OUTD" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"
ok "T4e 两文件 mtime 并列呈现" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '[.checks[] | select((.detail//"")|contains("mtime="))] | length >= 1' >/dev/null 2>&1 && echo 1 || echo 0)"

# ================= A3R: clean warm runtime → get_info echo ===================
section "A3R: warm runtime → get_info 快照回显"
spawn_rt 6641 "$RID1" "$W1" "Revy"
FIFO1="$FIFO_RT"
PLOG1="$SB/.multica/godot-editor/$RID1.proxy.log"
PS1="$SB/.multica/godot-editor/$RID1.proxy-state.json"
( rpc "$FIFO1" "$SB/rt-$RID1.out" '{"jsonrpc":"2.0","id":71,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 71 300 > "$SB/rt-$RID1.rpc71.json" 2>&1 ) &
ok "A3R WARM reached (≤300s)" \
    "$(wait_grep "$PLOG1" '\[stage=WARM\]' 300 "a3r-warm" && echo 1 || echo 0)"
i=0; OUTD=""
while (( i < 60 )); do
    OUTD="$(run_doctor "$W1" "Revy")"
    [[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="PASS" and (.check=="proxy_state:warm"))' >/dev/null 2>&1 && break
    sleep 2; i=$((i+2))
done
ok "A3R doctor proxy_state:warm PASS" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="PASS" and (.check=="proxy_state:warm"))' >/dev/null 2>&1 && echo 1 || echo 0)"
OUT="$(run_status "$W1" "Revy")"
ST_HASH="$(echo "$OUT" | jq -r '.runtime.workdir_hash' 2>/dev/null)"
RESP="$(rpc "$FIFO1" "$SB/rt-$RID1.out" '{"jsonrpc":"2.0","id":72,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 72 90 0)" || RESP=""
GI_HASH="$(extract_echo_field "$RESP" workdir_hash)"
GI_SRC="$(extract_echo_field "$RESP" hash_source)"
ok "A3 get_info 回显哈希($GI_HASH) == status workdir_hash($ST_HASH)，hash_source=slot" \
    "$([[ -n "$GI_HASH" && "$GI_HASH" == "$ST_HASH" && "$ST_HASH" == "$H1" && "$GI_SRC" == "slot" ]] && echo 1 || echo 0)" \
    "gi=$GI_HASH/$GI_SRC status=$ST_HASH"
rm -f "$PS1"
RESP="$(rpc "$FIFO1" "$SB/rt-$RID1.out" '{"jsonrpc":"2.0","id":73,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 73 60 0)" || RESP=""
ABS_SRC="$(extract_echo_field "$RESP" hash_source)"
ok "A6 快照删除后 get_info → hash_source=snapshot_absent（null 语义）" \
    "$([[ "$ABS_SRC" == "snapshot_absent" ]] && echo 1 || echo 0)" "src=$ABS_SRC"
for pid in "${RT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
RT_PIDS=()

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -gt 0 ]] && exit 1
exit 0
