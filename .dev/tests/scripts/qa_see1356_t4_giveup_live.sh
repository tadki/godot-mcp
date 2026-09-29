#!/usr/bin/env bash
# qa_see1356_t4_giveup_live.sh — SEE-1356 §SPEC-L5-02 T4 live construct, using
# the project's own sanctioned give-up pattern (test_see1240_ws5_giveup_rearm.sh):
# the REAL launcher/proxy chain + mock configure/start whose start ALWAYS
# fails — 3 serial calls → 3 spawn attempts → SPAWN_MAX_ATTEMPTS terminal →
# give_up (T4) → cooldown WARN → expiry FAIL (full doctor arbitration chain).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
source "$REPO/launch/tests/scripts/_see1085_helpers.sh"
lib_init

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"
CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0 "$MOCK_WORKTREE")
START_SH=$(make_start_mock "$START_COUNTER" 1 0)
PREP_SH="$TMPDIR/prepare-stub.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$PREP_SH"
chmod +x "$PREP_SH"

COOL=20000

wait_attempt() {
    local counter="$1" n="$2" waited=0
    while (( waited < 15000 )); do
        [[ "$(count_lines "$counter")" -ge "$n" ]] && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}
wait_backoff_expired() {
    sleep 1
}

RID="Revy-t4$(date +%H%M%S)"
PS_FILE="$TMPDIR/home/.multica/godot-editor/$RID.proxy-state.json"
GU_FILE="$TMPDIR/home/.multica/godot-editor/$RID.giveup.json"

run_doctor() {
    ( cd "$MOCK_WORKTREE" && HOME="$TMPDIR/home" GODOT_MCP_HOME="$TMPDIR/home/.multica" \
      KOL_PORT_REGISTRY_PATH_OVERRIDE="$TMPDIR/home/.multica/godot-port-registry.json" \
      KOL_AGENT_NAME="BachiWs5" KOL_WORKTREE="$MOCK_WORKTREE" GODOT_MCP_RUNTIME_ID="$RID" KOL_RUNTIME_ID="$RID" \
      bash "$REPO/launch/godot-status.sh" doctor --json 2>/dev/null )
}

section "T4: spawn terminal → give_up → cooldown WARN → expiry FAIL"
start_proxy \
    "GODOT_PORT=$PORT" \
    "GODOT_MCP_HOME=$TMPDIR/home/.multica" \
    "GODOT_MCP_RUNTIME_ID=$RID" \
    "KOL_RUNTIME_ID=$RID" \
    "KOL_AGENT_NAME=BachiWs5" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_PREPARE_SH=$PREP_SH" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_SPAWN_RETRY_BACKOFF_MS=200" \
    "KOL_GIVEUP_COOLDOWN_MS=$COOL" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 8000 || ok "pre: initialize answered" 0

# 3 serial calls → 3 attempts → terminal (ws5 pacing: wait each attempt's
# counter bump so no call is merely HELD-and-drained).
send_line "$(call_line 2)"
wait_attempt "$START_COUNTER" 1 || ok "attempt 1 fired" 0
wait_backoff_expired
send_line "$(call_line 3)"
wait_attempt "$START_COUNTER" 2 || ok "attempt 2 fired" 0
wait_backoff_expired
send_line "$(call_line 4)"
wait_attempt "$START_COUNTER" 3 || ok "attempt 3 fired" 0
ok "三次 spawn 尝试均落地（start mock 计数=3）" \
    "$([[ "$(count_lines "$START_COUNTER")" -ge 3 ]] && echo 1 || echo 0)"

i=0
while (( i < 30 )); do
    [[ -f "$PS_FILE" ]] && [[ "$(jq -r '.state' "$PS_FILE" 2>/dev/null)" == "failed_exit" ]] && break
    sleep 1; i=$((i+1))
done
ok "T4 快照 state=failed_exit（spawn terminal → give_up 落地）" \
    "$([[ -f "$PS_FILE" && "$(jq -r '.state' "$PS_FILE" 2>/dev/null)" == "failed_exit" ]] && echo 1 || echo 0)" \
    "$(jq -c '{state, give_up_count, last_error_bucket}' "$PS_FILE" 2>/dev/null)"
ok "T4b giveup 文件落盘（giveup_count ≥ 1 + cooldown_until 在场）" \
    "$([[ -f "$GU_FILE" ]] && jq -e '.giveup_count >= 1 and (.cooldown_until != null)' "$GU_FILE" >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(jq -c '{giveup_count, cooldown_until, backoff_ms}' "$GU_FILE" 2>/dev/null)"

OUTD="$(run_doctor)"
ok "T4c cooldown 中 doctor → proxy_state:failed_exit WARN（设计内）" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="WARN" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
    "$(echo "$OUTD" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"

stop_proxy
# Fixed wait: the cooldown EXPIRY is the tested semantic (WARN→FAIL 翻转窗).
sleep 22
OUTD="$(run_doctor)"; RCD=0
( cd "$MOCK_WORKTREE" && HOME="$TMPDIR/home" GODOT_MCP_HOME="$TMPDIR/home/.multica" \
  KOL_PORT_REGISTRY_PATH_OVERRIDE="$TMPDIR/home/.multica/godot-port-registry.json" \
  KOL_AGENT_NAME="BachiWs5" KOL_WORKTREE="$MOCK_WORKTREE" GODOT_MCP_RUNTIME_ID="$RID" KOL_RUNTIME_ID="$RID" \
  bash "$REPO/launch/godot-status.sh" doctor >/dev/null 2>&1 ) || RCD=$?
ok "T4d 冷却过期 + 无 rearm → doctor FAIL proxy_state:failed_exit + exit 1" \
    "$([[ "$RCD" == "1" ]] && [[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '.checks[] | select(.level=="FAIL" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
    "rc=$RCD $(echo "$OUTD" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"
ok "T4e 两文件 mtime 并列呈现" \
    "$([[ -n "$OUTD" ]] && echo "$OUTD" | jq -e '[.checks[] | select((.detail//"")|contains("mtime="))] | length >= 1' >/dev/null 2>&1 && echo 1 || echo 0)"

mkdir -p /tmp/see1356-artifacts-t4
cp -a "$TMPDIR/home/." /tmp/see1356-artifacts-t4/ 2>/dev/null || true

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -gt 0 ]] && exit 1
exit 0
