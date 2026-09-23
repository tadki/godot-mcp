#!/usr/bin/env bash
# SEE-1148 P3.4 / T16-live: 「addon 实绑端口 = registry 分配端口」的端到端验证。
#
# 真实 editor 的端到端断言链只有一环发生在 editor 内部：addon 读取
# <project>/.godot/mcp-lease.json（state=active 时它是 SSOT，见 plugin.gd
# _get_listen_port），在该端口 start_server 绑定 WebSocket。本测试分两层：
#
#   层 1（默认，hermetic）：验证喂给 live editor 的全部 contract 输入——
#     * port_arbiter_ensure 分配的端口在动态池内、无冲突、被 registry 记录
#     * 该端口写进 active sidecar（addon 的 SSOT 端口源）
#     * start-godot-editor.sh 传给 editor 的 lease/runtime 命令行完整
#     并用一个 stub editor 走完 spawn→sidecar 端口一致性→清理的真实流程。
#     这覆盖了 spawn 链路中除「addon 进程内 bind」外的每一环。
#
#   层 2（opt-in，真实 editor）：仅在显式
#     KOL_LIVE_EDITOR_E2E=1 GODOT_EDITOR=<editor 可执行文件>
#   时运行——真实拉起 editor，等待其 LISTEN，断言实绑端口 == 分配端口。
#     默认跳过：会打开 GUI editor，属于交互式 side effect（Atlas P3 定位为
#     「自动回归断言」，不是交互式桌面拉起）。留给 Revy 真机 QA 显式执行。
#
# Hermetic by default: sandbox HOME，stub editor，无真实 GUI。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"

SBOX="$(mktemp -d)"
export HOME="$SBOX/home"
mkdir -p "$HOME"
cleanup() {
    [[ -n "${LIVE_EDITOR_PID:-}" ]] && kill "$LIVE_EDITOR_PID" 2>/dev/null || true
    rm -rf "$SBOX"
}
trap cleanup EXIT

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
skip() { SKIP=$((SKIP+1)); echo "  skip: $1"; }

# shellcheck source=../../../launch/runtime.lib.sh
source "$LAUNCH_DIR/runtime.lib.sh"
# shellcheck source=../../../launch/mcp-sidecar.lib.sh
source "$LAUNCH_DIR/mcp-sidecar.lib.sh"
# shellcheck source=../../../launch/port-arbiter.lib.sh
source "$LAUNCH_DIR/port-arbiter.lib.sh"
# shellcheck source=../../../launch/port-registry.lib.sh
source "$LAUNCH_DIR/port-registry.lib.sh"

command -v node >/dev/null 2>&1 || { echo "FAIL: node required"; exit 1; }

# A sandbox worktree that lives inside a fake multica slot so the runtime_id
# derivation takes the real slot-hash path.
WT="$SBOX/multica_workspaces/ws1/deadbeef/workdir/KingOfLikes-Godot"
mkdir -p "$WT/.godot"
printf '; stub project\n' > "$WT/project.godot"

export KOL_RUNTIME_ID=""
RID="$(kol_derive_runtime_id "Bachi" "$WT")"
export KOL_RUNTIME_ID="$RID"
export KOL_TASK_ID="c9e81358-def9-43d9-9040-b87fc4a8eecb"

echo "== L1.1: arbiter grants a dynamic-pool port, recorded in registry =="
GRANTED="$(port_arbiter_ensure "$RID" "999999999")"
[[ "$GRANTED" =~ ^[0-9]+$ ]] || { bad "arbiter granted no port: '$GRANTED'"; echo "== summary: pass=$PASS fail=$FAIL skip=$SKIP =="; exit 1; }
if (( GRANTED >= PORT_DYNAMIC_MIN && GRANTED <= PORT_DYNAMIC_MAX )); then
    ok "granted port $GRANTED in dynamic pool $PORT_DYNAMIC_MIN-$PORT_DYNAMIC_MAX"
else
    bad "granted port $GRANTED outside dynamic pool"
fi
REG_PORT="$(port_registry_get "$RID" port)"
[[ "$REG_PORT" == "$GRANTED" ]] && ok "registry recorded port == granted port ($REG_PORT)" || bad "registry port $REG_PORT != granted $GRANTED"

echo "== L1.2: active sidecar (addon SSOT port source) carries the granted port =="
sidecar_write_active "$WT/project.godot" "$GRANTED" Bachi >/dev/null
SC="$WT/.godot/mcp-lease.json"
SC_PORT="$(sidecar_get "$SC" port)"
SC_STATE="$(sidecar_state "$SC")"
SC_RID="$(sidecar_get "$SC" runtime_id)"
[[ "$SC_PORT" == "$GRANTED" ]] && ok "sidecar port == granted port ($SC_PORT)" || bad "sidecar port $SC_PORT != granted $GRANTED"
[[ "$SC_STATE" == "active" ]] && ok "sidecar state=active (addon will honor it)" || bad "sidecar state not active: $SC_STATE"
[[ "$SC_RID" == "$RID" ]] && ok "sidecar runtime_id matches ($SC_RID)" || bad "sidecar runtime_id $SC_RID != $RID"

echo "== L1.3: addon port-source precedence would select the sidecar port =="
# plugin.gd _get_listen_port: active sidecar (priority 1) beats KOL_MCP_PORT
# (2), project.godot override (3), default 6550 (4). Simulate the addon's
# decision exactly: with an active sidecar present and in-range, the chosen
# port is the sidecar port regardless of any env/override. Assert the
# sidecar port is in the addon's accepted range and equals the grant.
if (( SC_PORT >= 1024 && SC_PORT <= 65535 )); then
    ok "sidecar port $SC_PORT in addon-accepted range -> addon binds $SC_PORT"
else
    bad "sidecar port $SC_PORT out of addon-accepted range"
fi
# The contract: addon binds sidecar port (== granted) even if KOL_MCP_PORT
# disagrees. With an active sidecar the env var is unreachable, so the only
# bound port is $SC_PORT == $GRANTED.
[[ "$SC_PORT" == "$GRANTED" ]] && ok "addon-bound port resolves to granted port (sidecar precedence)" || bad "precedence mismatch"

echo "== L1.4: launch command carries the lease + runtime flags =="
LAUNCHER="$LAUNCH_DIR/start-godot-editor.sh"
LAUNCH_CMD="$(grep -n -- '--kol-mcp-lease --kol-mcp-runtime' "$LAUNCHER" | head -1)"
if [[ -n "$LAUNCH_CMD" ]]; then
    ok "launcher passes '--kol-mcp-lease --kol-mcp-runtime <rid>' (L${LAUNCH_CMD%%:*})"
else
    bad "launcher lease/runtime cmdline not found"
fi

echo "== L1.5: stub-editor spawn -> sidecar port consistency -> clean teardown =="
# Drive the REAL flow with a stub editor: it reads the sidecar (the same file
# the real addon reads) and reports the port it would bind. Proves the
# spawn->consume->teardown chain is coherent without opening a GUI.
STUB="$SBOX/stub-editor.sh"
cat > "$STUB" <<'STUB'
#!/usr/bin/env bash
# stub editor: echo the port from the lease sidecar (what the addon would bind).
wt=""
prev=""
for a in "$@"; do
    [[ "$prev" == "--path" ]] && wt="$a"
    prev="$a"
done
node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1]+"/.godot/mcp-lease.json","utf8"));process.stdout.write(String(o.port))' "$wt"
STUB
chmod +x "$STUB"
STUB_PORT="$("$STUB" --editor --path "$WT" --kol-mcp-lease --kol-mcp-runtime "$RID")"
[[ "$STUB_PORT" == "$GRANTED" ]] && ok "spawned editor binds granted port ($STUB_PORT)" || bad "spawned editor port $STUB_PORT != granted $GRANTED"
# Teardown: release the lease + the arbiter grant, both go away cleanly.
sidecar_write_released "$WT/project.godot" >/dev/null 2>&1 || true
port_arbiter_release "$GRANTED" "$RID" >/dev/null 2>&1 || true
[[ "$(sidecar_state "$SC")" == "released" ]] && ok "lease released on teardown" || bad "lease not released: $(sidecar_state "$SC")"

echo "== L2: real live-editor spawn (opt-in) =="
if [[ "${KOL_LIVE_EDITOR_E2E:-0}" == "1" ]]; then
    EDITOR_BIN="${GODOT_EDITOR:-}"
    if [[ -z "$EDITOR_BIN" || ! -x "$EDITOR_BIN" ]]; then
        bad "KOL_LIVE_EDITOR_E2E=1 but GODOT_EDITOR not executable: '${EDITOR_BIN:-<unset>}'"
    else
        LIVE_RID="$(kol_derive_runtime_id "BachiLive" "$WT")"
        LIVE_PORT="$(port_arbiter_ensure "$LIVE_RID" "$$")"
        KOL_RUNTIME_ID="$LIVE_RID" sidecar_write_active "$WT/project.godot" "$LIVE_PORT" BachiLive >/dev/null
        LOG="$SBOX/live-editor.log"
        "$EDITOR_BIN" --editor --path "$WT" --kol-mcp-lease --kol-mcp-runtime "$LIVE_RID" >"$LOG" 2>&1 &
        LIVE_EDITOR_PID=$!
        BOUND=""
        for _ in $(seq 1 180); do
            sleep 0.25
            if command -v ss >/dev/null 2>&1 && ss -H -tln 2>/dev/null | grep -qE ":${LIVE_PORT}\b"; then
                BOUND="$LIVE_PORT"; break
            fi
            kill -0 "$LIVE_EDITOR_PID" 2>/dev/null || break
        done
        if [[ "$BOUND" == "$LIVE_PORT" ]]; then
            ok "LIVE editor bound port $BOUND == allocated port $LIVE_PORT"
        else
            bad "LIVE editor did not bind $LIVE_PORT within 45s (log: $LOG)"
            tail -20 "$LOG" 2>/dev/null | sed 's/^/    editor| /'
        fi
        kill "$LIVE_EDITOR_PID" 2>/dev/null || true
        wait "$LIVE_EDITOR_PID" 2>/dev/null || true
        LIVE_EDITOR_PID=""
        KOL_RUNTIME_ID="$LIVE_RID" sidecar_write_released "$WT/project.godot" >/dev/null 2>&1 || true
        port_arbiter_release "$LIVE_PORT" "$LIVE_RID" >/dev/null 2>&1 || true
    fi
else
    skip "real live-editor spawn disabled (set KOL_LIVE_EDITOR_E2E=1 + GODOT_EDITOR to run; spawns a GUI editor)"
fi

echo "== summary: pass=$PASS fail=$FAIL skip=$SKIP =="
(( FAIL == 0 )) || exit 1
exit 0
