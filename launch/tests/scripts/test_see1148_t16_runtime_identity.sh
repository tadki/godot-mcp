#!/usr/bin/env bash
# SEE-1148 T16: runtime_id 派生 + 全链路传递 + 单 runtime 等价性。
#
# Verifies the identity layer end-to-end:
#   1. kol_derive_runtime_id is deterministic on the same slot path.
#   2. Different slots yield different runtime_ids (no collision between
#      concurrent same-agent slots).
#   3. A worktree outside a multica slot degrades to "<agent>-solo" so
#      manual/standalone launches still get a stable identity.
#   4. Sidecar schema v2 writer emits runtime_id when KOL_RUNTIME_ID is
#      set, omits it cleanly when unset (v1 fallback at read).
#   5. Port registry upsert is keyed by runtime_id, idempotent on re-upsert,
#      and stale-state calculation respects the 60s heartbeat window.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"
SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX" ~/.multica/godot-port-registry.json' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# shellcheck source=../../../launch/runtime.lib.sh
source "$LAUNCH_DIR/runtime.lib.sh"
# shellcheck source=../../../launch/mcp-sidecar.lib.sh
source "$LAUNCH_DIR/mcp-sidecar.lib.sh"
# shellcheck source=../../../launch/port-registry.lib.sh
source "$LAUNCH_DIR/port-registry.lib.sh"
die() { echo "DIE: $*" >&2; exit 1; }

echo "== T16.1: deterministic runtime_id on the same slot =="
WT_A="/home/jerry/multica_workspaces/ws1/fe7bb0db/workdir/KingOfLikes-Godot"
WT_B="/home/jerry/multica_workspaces/ws1/fe7bb0db/workdir/KingOfLikes-Godot"
R1="$(kol_derive_runtime_id "Bachi" "$WT_A")"
R2="$(kol_derive_runtime_id "Bachi" "$WT_B")"
[[ "$R1" == "Bachi-fe7bb0db" && "$R1" == "$R2" ]] && ok "deterministic on slot (=$R1)" || bad "non-deterministic: $R1 vs $R2"

echo "== T16.2: distinct runtime_ids for concurrent same-agent slots =="
WT_X="/home/jerry/multica_workspaces/ws1/11aa22bb/workdir/KingOfLikes-Godot"
WT_Y="/home/jerry/multica_workspaces/ws1/deadbeef/workdir/KingOfLikes-Godot"
RX="$(kol_derive_runtime_id "Bachi" "$WT_X")"
RY="$(kol_derive_runtime_id "Bachi" "$WT_Y")"
[[ "$RX" == "Bachi-11aa22bb" && "$RY" == "Bachi-deadbeef" && "$RX" != "$RY" ]] && ok "two distinct slots give two distinct ids" || bad "collision: $RX vs $RY"

echo "== T16.3: outside-slot worktree degrades to <agent>-solo =="
WT_OUTSIDE="/mnt/d/GodotProjects/king-of-likes"
RS="$(kol_derive_runtime_id "Bachi" "$WT_OUTSIDE")"
[[ "$RS" == "Bachi-solo" ]] && ok "outside-slot = Bachi-solo" || bad "outside-slot wrong: $RS"

echo "== T16.7: SEE-1244 see-<issue>-<hex> slot layout derives distinct runtime_ids =="
# per-runtime 隔离失效根因（并发验收套件 SEE-1258/59/60 全塌缩 Revy-solo）的
# 回归门：当前 multica 槽位目录是 `see-<issue>-<12hex>`，必须各自提取末尾
# hex 段 → 3 个并发 Revy 槽位得到 3 个不同 runtime_id（而非全部 Revy-solo）。
WT_C1="/home/jerry/multica_workspaces/seed-478690824e46/see-1259-aa4de5376e75/workdir/KingOfLikes-Godot"
WT_C2="/home/jerry/multica_workspaces/seed-478690824e46/see-1260-543fed12aa77/workdir/KingOfLikes-Godot"
RC1="$(kol_derive_runtime_id "Revy" "$WT_C1")"
RC2="$(kol_derive_runtime_id "Revy" "$WT_C2")"
[[ "$RC1" == "Revy-aa4de5376e75" && "$RC2" == "Revy-543fed12aa77" && "$RC1" != "$RC2" ]] \
    && ok "3-concurrent layout: see-bug-<hex> → distinct (=$RC1 / $RC2)" \
    || bad "see-<issue>-<hex> isolation broken: $RC1 vs $RC2"
# 显式并发三重唯一性（1258/1259/1260 三个并发射手应得 3 个不同 id）。
WT_C3="/home/jerry/multica_workspaces/seed-478690824e46/see-1258-4288fcce0120/workdir/KingOfLikes-Godot"
RC3="$(kol_derive_runtime_id "Revy" "$WT_C3")"
[[ "$RC1" != "$RC3" && "$RC2" != "$RC3" ]] \
    && ok "three concurrent Revy slots → three distinct runtime_ids" \
    || bad "concurrent Revy id collision: $RC1 / $RC2 / $RC3"

echo "== T16.8: legacy bare-<8hex> slot still derives (no regression) =="
# 旧 `<hash8>` 裸目录兼容（T16.1/T16.2 依赖）：`see-...` 前缀不存在时
# 末尾段就是裸 hash，同样命中新判定。
WT_LEGACY="/home/jerry/multica_workspaces/ws1/fe7bb0db/workdir/KingOfLikes-Godot"
RL="$(kol_derive_runtime_id "Bachi" "$WT_LEGACY")"
[[ "$RL" == "Bachi-fe7bb0db" ]] && ok "legacy bare-<8hex> slot unchanged (=$RL)" || bad "legacy slot regressed: $RL"
# 非 slot 路径（末尾段非 hex）仍回落 -solo。
[[ "$(kol_derive_runtime_id "Bachi" "/home/jerry/multica_workspaces/ws1/notahex/workdir/KingOfLikes-Godot")" == "Bachi-solo" ]] \
    && ok "non-hex slot dir → Bachi-solo" || bad "non-hex slot dir not solo"

echo "== T16.4: sidecar v2 writer emits runtime_id when set =="
mkdir -p "$SBOX/wt4/.godot"
export KOL_RUNTIME_ID="Bachi-fe7bb0db"
export KOL_TASK_ID="c9e81358-def9-43d9-9040-b87fc4a8eecb"
sidecar_write_active "$SBOX/wt4/project.godot" 6553 Bachi >/dev/null
GOT="$(sidecar_get "$SBOX/wt4/.godot/mcp-lease.json" runtime_id)"
[[ "$GOT" == "Bachi-fe7bb0db" ]] && ok "sidecar runtime_id round-trip" || bad "runtime_id round-trip failed: $GOT"

echo "== T16.5: sidecar v1 reader tolerates a v2 record (no parse error) =="
ST="$(sidecar_state "$SBOX/wt4/.godot/mcp-lease.json")"
[[ "$ST" == "active" ]] && ok "v2 record readable as active" || bad "v2 record state unread: $ST"

echo "== T16.6: port registry upsert keyed by runtime_id =="
rm -f ~/.multica/godot-port-registry.json
port_registry_upsert "Bachi-fe7bb0db" "port=6553" "agent=Bachi" "label=bachi" "proxy_pid=1234" "heartbeat_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PORT_GOT="$(port_registry_get "Bachi-fe7bb0db" port)"
[[ "$PORT_GOT" == "6553" ]] && ok "registry upsert keyed" || bad "registry upsert failed: $PORT_GOT"

echo "== T16.8: F12 path assertion — KOL_RUNTIME_ID export precedes KOL_WORKTREE export in launcher =="
# Atlas P1 FAIL 修订决策 F12: KOL_RUNTIME_ID must be exported at the TOP of
# the launcher, before/with KOL_WORKTREE, so the proxy + helper children
# inherit it regardless of which early code path runs. Assert the source
# order in godot-mcp-launcher.sh: the export line for KOL_RUNTIME_ID must
# appear BEFORE the KOL_WORKTREE export line.
LAUNCHER_FILE="$LAUNCH_DIR/godot-mcp-launcher.sh"
if [[ -f "$LAUNCHER_FILE" ]]; then
    RID_LINE="$(grep -n 'export KOL_RUNTIME_ID' "$LAUNCHER_FILE" | head -1 | cut -d: -f1)"
    WT_LINE="$(grep -n 'export KOL_WORKTREE' "$LAUNCHER_FILE" | head -1 | cut -d: -f1)"
    if [[ -n "$RID_LINE" && -n "$WT_LINE" ]] && (( RID_LINE < WT_LINE )); then
        ok "KOL_RUNTIME_ID export (L${RID_LINE}) precedes KOL_WORKTREE export (L${WT_LINE})"
    else
        bad "export order wrong: RID_LINE=${RID_LINE:-unset} WT_LINE=${WT_LINE:-unset}"
    fi
else
    bad "launcher file missing: $LAUNCHER_FILE"
fi

echo "== T16.9: F11 HOME-unset guard — port-registry.lib.sh refuses to pick a path =="
# Atlas P1 FAIL 修订决策 F11: no /root fallback; HOME unset must die loudly
# at source time. Assert sourcing the lib with HOME cleared exits non-zero
# with a FATAL message instead of silently resolving to a fallback path.
LIB_FILE="$LAUNCH_DIR/port-registry.lib.sh"
if [[ -f "$LIB_FILE" ]]; then
    HOME_UNSET_OUT="$(env -u HOME bash -c "source '$LIB_FILE' 2>&1" || true)"
    if echo "$HOME_UNSET_OUT" | grep -q "FATAL: HOME is unset"; then
        ok "HOME-unset source dies loudly: ${HOME_UNSET_OUT%%$'\n'*}"
    else
        bad "HOME-unset source did not die loudly: $HOME_UNSET_OUT"
    fi
else
    bad "registry lib missing: $LIB_FILE"
fi

echo "== T16.10: F11 proxy guard — godot-mcp-proxy.mjs dies loudly when HOME is unset =="
# Atlas P1 FAIL 修订决策 F11 names proxy.mjs explicitly (the proxy heartbeat
# used `process.env.HOME || '/root'`). Assert the proxy refuses to start with
# HOME cleared, instead of deriving a registry path under /.multica.
PROXY_FILE="$LAUNCH_DIR/godot-mcp-proxy.mjs"
if [[ -f "$PROXY_FILE" ]]; then
    HOME_UNSET_PX="$(env -u HOME node "$PROXY_FILE" 2>&1 | head -2; exit 0)"
    if echo "$HOME_UNSET_PX" | grep -q "FATAL: HOME is unset"; then
        ok "proxy HOME-unset start dies loudly: ${HOME_UNSET_PX%%$'\n'*}"
    else
        bad "proxy HOME-unset start did not die loudly: $HOME_UNSET_PX"
    fi
else
    bad "proxy file missing: $PROXY_FILE"
fi

echo "== T16.7: registry stale-state honors 60s window =="
port_registry_upsert "Old-slot1" "heartbeat_at=2024-01-01T00:00:00Z"
STATE="$(port_registry_runtime_state "Old-slot1")"
[[ "$STATE" == "stale" ]] && ok "old heartbeat = stale" || bad "old heartbeat not stale: $STATE"
STATE2="$(port_registry_runtime_state "Bachi-fe7bb0db")"
[[ "$STATE2" == "alive" ]] && ok "fresh heartbeat = alive" || bad "fresh heartbeat not alive: $STATE2"

echo "== T16 summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
