#!/usr/bin/env bash
# qa_see1356_b2_live_env.sh — batch-2 QA environment bootstrap.
# Builds a jerry-owned QA slot: full KOL copy with the BATCH-2 addon synced
# from the godot-mcp repo (the daemon editor's vendored addon is stale at
# SEE-1348 gitlink d8e684c and must not be touched). Launches the production
# launcher/proxy on the fixture and waits for WARM.
# Exports (via /tmp/see1356-b2-env): FIFO, SB, RID, W, PLOG for the driver.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PWSH="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

KOL="${KOL_ROOT:-/home/jerry/multica_workspaces/seed-478690824e46/see-1356-ef9f21ac6d16/workdir/KingOfLikes-Godot}"
WSBASE="/home/jerry/multica_workspaces"
CONTAINER="seed-478690824e46"
H="${B2_H:-f1n4lfedcba}"
SLOT="${B2_SLOT:-see-qa6-$H}"
FRESH_IMPORT="${B2_FRESH_IMPORT:-0}"
W="$WSBASE/$CONTAINER/$SLOT/workdir/KingOfLikes-Godot"
RID="Revy-$H"
PORT=6650

SB="$(mktemp -d)"
REG="$SB/.multica/godot-port-registry.json"
mkdir -p "$SB/home" "$SB/.multica/godot-editor"

pre_pids() {
    "$PWSH" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r' | sort -n
}
mapfile -t PRE_PIDS < <(pre_pids)
echo "[pre] pre-existing godot pids: ${PRE_PIDS[*]:-<none>}"

# fixture: full KOL copy + batch-2 addon sync from the repo under test
if [[ ! -d "$W" ]]; then
    mkdir -p "$(dirname "$W")"
    cp -a "$KOL" "$W"
fi
if [[ "$FRESH_IMPORT" == "1" ]]; then
    # The Windows editor writes .godot via \wsl.localhost → root-owned; a
    # poisoned shader cache crashes the editor on boot. Wipe it so the import
    # rebuilds fully jerry-owned.
    rm -rf "$W/.godot" 2>/dev/null || true
fi
# sync the batch-2 addon tree (commands/core/etc. live at the repo root)
for entry in commands core scripts addon plugin.cfg; do
    [[ -e "$REPO/$entry" ]] && rm -rf "$W/addons/godot_mcp/$entry" && cp -a "$REPO/$entry" "$W/addons/godot_mcp/$entry"
done
# sync websocket server + command router if they live at root
for f in command_router.gd lease_controller.gd plugin.gd websocket_server.gd; do
    [[ -f "$REPO/$f" ]] && cp -a "$REPO/$f" "$W/addons/godot_mcp/$f"
done
grep -q "INSTANCED_SCENE" "$W/addons/godot_mcp/commands/node_commands.gd" \
    && echo "[fixture] batch-2 addon synced (INSTANCED_SCENE present)" \
    || { echo "[fixture] FATAL: addon sync failed"; exit 1; }
cat > /tmp/see1356-b2-env.env <<ENV
SB=$SB
REG=$REG
W=$W
RID=$RID
PLOG=$SB/.multica/godot-editor/$RID.proxy.log
PS_FILE=$SB/.multica/godot-editor/$RID.proxy-state.json
PORT=$PORT
REPO=$REPO
PRE_PIDS="${PRE_PIDS[*]}"
ENV

# launch
FIFO="$SB/rt-$RID.in"
mkfifo "$FIFO"
exec 9<>"$FIFO"
( cd "$W" && env HOME="$SB/home" \
    GODOT_MCP_HOME="$SB/.multica" KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
    GODOT_MCP_WORKSPACES_BASE="$WSBASE" \
    KOL_RUNTIME_ID="$RID" GODOT_MCP_RUNTIME_ID="$RID" KOL_AGENT_NAME="Revy" \
    KOL_WORKTREE="$W" \
    bash "$REPO/launch/godot-mcp-launcher.sh" --port "$PORT" < "$FIFO" > "$SB/rt.out" 2> "$SB/rt.err" ) &
LAUNCHER_PID=$!
echo "LAUNCHER_PID=$LAUNCHER_PID" >> /tmp/see1356-b2-env.env
echo "FIFO=$FIFO" >> /tmp/see1356-b2-env.env

# init handshake + hold the first call (triggers lazy editor spawn)
python3 "$HERE/see1356_rpc_call.py" "$FIFO" "$SB/rt-$RID.out" \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"see1356-b2qa","version":"0"}}}' 1 30 > /dev/null 2>&1 &
INIT_PID=$!

# wait for the initialize response (id:1), then fire a real tools/call — the
# proxy lazy-spawns the editor on the first tools/call, NOT on initialize, so
# an init-only handshake leaves the runtime waiting forever.
i=0
while (( i < 60 )); do
    grep -q '"id":1' "$SB/rt.out" 2>/dev/null && break
    sleep 1; i=$((i+1))
done
python3 "$HERE/see1356_rpc_call.py" "$FIFO" "$SB/rt.out" \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}' 2 300 0 > /dev/null 2>&1 &
TRIGGER_PID=$!

# wait WARM (proxy log naming is not SSOT-stable across subsystems — accept
# either the slot-form or the legacy-form log file)
i=0
while (( i < 900 )); do
    for cand in "$SB/.multica/godot-editor/$RID.proxy.log" "$SB"/.multica/godot-editor/godot-editor-*.proxy.log; do
        [[ -f "$cand" ]] && grep -q '\[stage=WARM\]' "$cand" 2>/dev/null && break 2
    done
    sleep 1; i=$((i+1))
done
if grep -q '\[stage=WARM\]' "$SB"/.multica/godot-editor/*.proxy.log 2>/dev/null; then
    echo "WARM reached after ${i}s"
else
    echo "TIMEOUT waiting for WARM"
    tail -5 "$SB"/.multica/godot-editor/*.proxy.log 2>/dev/null
    tail -3 "$SB/rt.err" 2>/dev/null
    exit 1
fi
kill "$INIT_PID" "$TRIGGER_PID" 2>/dev/null
exit 0
