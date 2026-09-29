#!/usr/bin/env bash
# test_see1356_status_segments.sh — SEE-1356 L2/L5/L6 status/doctor regression.
#
#   R1  resolve helper (§SPEC-L6-03): absolute ok / dangling broken / retired
#       stale / bare PATH hit ok / bare PATH miss degraded / not-executable
#       degraded — the SEE-1240 regression cases ride the same harness
#   R2  workdir_hash SSOT (§SPEC-L2-01/02): slot 主口径 + path fallback +
#       hash_source stamp; double-worktree fixture: hashes互异, 与目录名哈希段
#       一致, entry 级 workdir_hash/is_current_workdir 三态 (仅一条 true)
#   R3  proxy_state segment (§SPEC-L5-02): doctor 仲裁判定表 — fresh+warm
#       PASS 主判据 (giveup 降级为参考), stale 降权 WARN, failed_exit+cooling
#       WARN 设计内, failed_exit 无 rearm FAIL 契约逃逸, 快照缺席语义
#   R4  proxylog segment (§SPEC-L6-02): 64KB tail 扫描, highest_stage 提取,
#       json_rpc_contaminated 哨兵恒 false
#
# Sandbox: HOME / GODOT_MCP_HOME / KOL_PORT_REGISTRY_PATH_OVERRIDE 全部重定向
# （ws4 seam）；不触真实 ~/.multica，不触真实 /tmp/multica-mcp-*。

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STATUS="$REPO/launch/godot-status.sh"

command -v node >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || { echo "node+jq required"; exit 1; }
# shellcheck source=../resolve-command.lib.sh
source "$REPO/launch/resolve-command.lib.sh"

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"
export GODOT_MCP_HOME="$SB/home/.multica"
export KOL_PORT_REGISTRY_PATH_OVERRIDE="$GODOT_MCP_HOME/godot-port-registry.json"
mkdir -p "$GODOT_MCP_HOME/godot-editor"

# Double-worktree fixture: seed-<hex12>/<see-hash>/workdir/KingOfLikes-Godot
CONTAINER="seed-a1b2c3d4e5f6"
IN1="see-c1-111122223333"
IN2="see-c2-222233334444"
WT1="$HOME/multica_workspaces/$CONTAINER/$IN1/workdir/KingOfLikes-Godot"
WT2="$HOME/multica_workspaces/$CONTAINER/$IN2/workdir/KingOfLikes-Godot"
mkdir -p "$WT1/launch" "$WT2/launch"
RID1="Bachi-111122223333"
RID2="Bachi-222233334444"

seed_registry() {
    node -e '
const fs = require("fs");
const [p, wt1, wt2] = process.argv.slice(1);
fs.writeFileSync(p, JSON.stringify({
    schema_version: 1, updated_at: new Date().toISOString(),
    entries: {
        "Bachi-111122223333": { port: 6571, agent: "Bachi", worktree: wt1, proxy_pid: process.pid, heartbeat_at: new Date().toISOString() },
        "Bachi-222233334444": { port: 6572, agent: "Bachi", worktree: wt2, proxy_pid: null, heartbeat_at: new Date().toISOString() },
    },
}, null, 2) + "\n");
' "$KOL_PORT_REGISTRY_PATH_OVERRIDE" "$WT1" "$WT2"
}
seed_registry

run_status() { ( cd "$1" && shift && HOME="$HOME" GODOT_MCP_HOME="$GODOT_MCP_HOME" KOL_PORT_REGISTRY_PATH_OVERRIDE="$KOL_PORT_REGISTRY_PATH_OVERRIDE" KOL_AGENT_NAME=Bachi KOL_WORKTREE="$1" bash "$STATUS" status --json 2>/dev/null ); }
run_doctor_j() { HOME="$HOME" GODOT_MCP_HOME="$GODOT_MCP_HOME" KOL_PORT_REGISTRY_PATH_OVERRIDE="$KOL_PORT_REGISTRY_PATH_OVERRIDE" KOL_AGENT_NAME=Bachi KOL_WORKTREE="$WT1" bash "$STATUS" doctor --json 2>/dev/null; }

section "R1: shared resolve helper — verdict 分级"
{
    mcp_resolve_command "$STATUS"
    ok "R1a absolute existing+exec → ok" "$([[ "$RCV_VERDICT" == "ok" && "$RCV_REASON" == "ok" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    mcp_resolve_command "/nonexistent/see1356/path/launcher.sh"
    ok "R1b absolute dangling → broken (2026-08-01 形态保留)" "$([[ "$RCV_VERDICT" == "broken" && "$RCV_REASON" == "dangling_path" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    mcp_resolve_command "/mnt/d/GodotProjects/king-of-likes/.dev/godot-mcp/launch/godot-mcp-launcher.sh"
    ok "R1c retired legacy path → stale (SEE-1288)" "$([[ "$RCV_VERDICT" == "stale" && "$RCV_REASON" == "stale_retired_path" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    mcp_resolve_command "bash"
    ok "R1d bare name on PATH → ok (SEE-1240)" "$([[ "$RCV_VERDICT" == "ok" && "$RCV_REASON" == "bare_path_hit" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    mcp_resolve_command "see1356-no-such-command-xyz"
    ok "R1e bare name PATH miss → degraded 不 FAIL (SEE-1240 D1)" "$([[ "$RCV_VERDICT" == "degraded" && "$RCV_REASON" == "bare_path_miss" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    NOEXEC="$SB/noexec.sh"; printf '#!/bin/bash\n' > "$NOEXEC"; chmod 644 "$NOEXEC"
    mcp_resolve_command "$NOEXEC"
    ok "R1f not executable → degraded (EACCES 分级)" "$([[ "$RCV_VERDICT" == "degraded" && "$RCV_REASON" == "not_executable" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    # SEE-1240 实机判据的沙箱等价物：bare 名在 PATH 第 3 目录命中 → 判 ok。
    P3="$SB/path3"; mkdir -p "$P3"; printf '#!/bin/bash\nexit 0\n' > "$P3/see1356-p3cmd"; chmod +x "$P3/see1356-p3cmd"
    RCV_VERDICT=""; RCV_PATH=""; RCV_REASON=""
    SAVED_PATH="$PATH"; PATH="/usr/bin:/bin:$P3"
    mcp_resolve_command "see1356-p3cmd"
    PATH="$SAVED_PATH"
    ok "R1g bare name in 3rd PATH dir → ok (第 3 目录判 PASS)" "$([[ "$RCV_VERDICT" == "ok" && "$RCV_PATH" == "$P3/see1356-p3cmd" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_PATH"

    # —— SEE-1356 hardener：R1 边界形态全覆盖（每条注明所杀变异类别）——
    # R1h 空命令 → broken/empty_command 且 rc=0。kills: `[[ -n "$cmd" ]]`
    #   早退删除（空串会落入 bare 分支 → bare_path_miss，verdict/reason 双变）。
    mcp_resolve_command ""
    ok "R1h empty command → broken/empty_command rc=0" \
        "$([[ "$RCV_VERDICT" == "broken" && "$RCV_REASON" == "empty_command" && "$RCV_PATH" == "" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON/$RCV_PATH"
    # R1i 相对路径形态（含 /）直判。kills: `== */*` 形态分流变异（相对路径
    #   误入 bare 分支会变 bare_path_hit/miss）。
    REL="$SB/rel-exec.sh"; printf '#!/bin/bash\n' > "$REL"; chmod +x "$REL"
    OUTI2="$(cd "$SB" && mcp_resolve_command "./rel-exec.sh"; printf '%s|%s|%s' "$RCV_VERDICT" "$RCV_REASON" "$RCV_PATH")"
    ok "R1i relative path form → ok (direct judgement)" \
        "$([[ "$OUTI2" == "ok|ok|./rel-exec.sh" ]] && echo 1 || echo 0)" "$OUTI2"
    # R1j 目录路径 → degraded/not_regular_file。kills: `[[ -d ]]` 分支删除
    #   （目录会落入 -f 分支 → dangling/broken，误 FAIL）。
    mcp_resolve_command "$SB"
    ok "R1j directory path → degraded/not_regular_file" \
        "$([[ "$RCV_VERDICT" == "degraded" && "$RCV_REASON" == "not_regular_file" && "$RCV_PATH" == "$SB" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    # R1k 非常规文件（fifo）存在但非 dir/regular → degraded。kills:
    #   `[[ -e ]]` 兜底分支删除（socket/fifo 形态会误判 dangling → FAIL）。
    FIFO="$SB/see1356.fifo"; mkfifo "$FIFO"
    mcp_resolve_command "$FIFO"
    ok "R1k non-regular file (fifo) → degraded/not_regular_file" \
        "$([[ "$RCV_VERDICT" == "degraded" && "$RCV_REASON" == "not_regular_file" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    # R1l 退役路径但健康可执行 → 必须 ok（marker 只降级失败，不污染健康解）。
    #   kills: marker 降级无条件化变异（ok 也被改判 stale）。
    RET="$SB/.dev/godot-mcp/launch"; mkdir -p "$RET"
    printf '#!/bin/bash\n' > "$RET/healthy-launcher.sh"; chmod +x "$RET/healthy-launcher.sh"
    mcp_resolve_command "$RET/healthy-launcher.sh"
    ok "R1l retired-path but healthy+exec → ok (marker never demotes ok)" \
        "$([[ "$RCV_VERDICT" == "ok" && "$RCV_REASON" == "ok" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
    # R1m 已删除（见 review 说明）：bare miss 的 RCV_PATH 重置被函数入口
    #   `RCV_PATH=""` 初始化输出等价遮蔽——任何单变异下该断言均不可失败，
    #   属无效断言，按对抗性原则不保留凑数用例。
    # R1n 空 PATH 段绝不落回 cwd 探测（SEE-1240 回归类）。kills:
    #   `"$dir/$cmd"`→`"$cmd"` 简化变异（会命中 cwd 同名可执行 → 假 ok）。
    TRAP="$SB/cwd-trap"; mkdir -p "$TRAP"; P3B="$SB/path3b"; mkdir -p "$P3B"
    printf '#!/bin/bash\nexit 0\n' > "$TRAP/see1356-p3exec"; chmod +x "$TRAP/see1356-p3exec"
    printf '#!/bin/bash\nexit 0\n' > "$P3B/see1356-p3exec"; chmod +x "$P3B/see1356-p3exec"
    OUTN="$(cd "$TRAP" && SAVED_PATH="$PATH"; PATH=":$P3B"; mcp_resolve_command "see1356-p3exec"; PATH="$SAVED_PATH"; printf '%s|%s' "$RCV_VERDICT" "$RCV_PATH")"
    ok "R1n empty PATH segment never probes cwd (SEE-1240 class)" \
        "$([[ "$OUTN" == "ok|$P3B/see1356-p3exec" ]] && echo 1 || echo 0)" "$OUTN"
    # R1o bare 名仅遇不可执行同名 → degraded/bare_path_miss（不是 ok 也不是
    #   not_executable）。kills: bare 分支 `&& -x` 条件删除（非执行命中会
    #   假 ok）。
    NOEX3="$SB/path-noex"; mkdir -p "$NOEX3"; printf '#!/bin/bash\n' > "$NOEX3/see1356-noex"; chmod 644 "$NOEX3/see1356-noex"
    RCV_VERDICT=""; RCV_PATH=""; RCV_REASON=""
    SAVED_PATH="$PATH"; PATH="$NOEX3"
    mcp_resolve_command "see1356-noex"
    PATH="$SAVED_PATH"
    ok "R1o bare name vs non-executable only → degraded/bare_path_miss" \
        "$([[ "$RCV_VERDICT" == "degraded" && "$RCV_REASON" == "bare_path_miss" ]] && echo 1 || echo 0)" "$RCV_VERDICT/$RCV_REASON"
}

section "R2: workdir_hash SSOT + status/registry 三处标注"
{
    # SSOT helper: slot 主口径
    OUT="$(bash -c 'source "$1/launch/runtime.lib.sh" && kol_workdir_hash "$2"' _ "$REPO" "$WT1")"
    ok "R2a slot 口径命中目录名哈希段" "$([[ "$OUT" == "111122223333 slot" ]] && echo 1 || echo 0)" "$OUT"
    # path fallback: worktree outside multica_workspaces
    OUT="$(bash -c 'source "$1/launch/runtime.lib.sh" && kol_workdir_hash "$2"' _ "$REPO" "$REPO/launch")"
    ok "R2b 非 slot 路径 → sha256(realpath)[:8] + path 标注" "$([[ "$OUT" =~ ^[0-9a-f]{8}\ path$ ]] && echo 1 || echo 0)" "$OUT"
    # 哈希互异
    OUT1="$(bash -c 'source "$1/launch/runtime.lib.sh" && kol_workdir_hash "$2"' _ "$REPO" "$WT1" | cut -d" " -f1)"
    OUT2="$(bash -c 'source "$1/launch/runtime.lib.sh" && kol_workdir_hash "$2"' _ "$REPO" "$WT2" | cut -d" " -f1)"
    ok "R2c 双 worktree 哈希互异" "$([[ -n "$OUT1" && -n "$OUT2" && "$OUT1" != "$OUT2" ]] && echo 1 || echo 0)" "$OUT1 vs $OUT2"

    OUT="$(run_status "$WT1" "$WT1")"
    ok "R2d runtime.workdir_hash 与目录名哈希段一致" \
        "$([[ "$(echo "$OUT" | jq -r .runtime.workdir_hash)" == "111122223333" && "$(echo "$OUT" | jq -r .runtime.hash_source)" == "slot" ]] && echo 1 || echo 0)" \
        "$(echo "$OUT" | jq -c .runtime)"
    ok "R2e entry 级 workdir_hash 并列输出" \
        "$([[ "$(echo "$OUT" | jq -r '.registry.entries["Bachi-222233334444"].workdir_hash')" == "222233334444" ]] && echo 1 || echo 0)" \
        "$(echo "$OUT" | jq -c '.registry.entries["Bachi-222233334444"]')"
    ok "R2f is_current_workdir 三态: cwd=WT1 → entry1 true / entry2 false" \
        "$([[ "$(echo "$OUT" | jq -r '.registry.entries["Bachi-111122223333"].is_current_workdir')" == "true" && "$(echo "$OUT" | jq -r '.registry.entries["Bachi-222233334444"].is_current_workdir')" == "false" ]] && echo 1 || echo 0)"
    TRUE_N="$(echo "$OUT" | jq '[.registry.entries[] | select(.is_current_workdir == true)] | length')"
    ok "R2g 仅一条 entry is_current_workdir=true" "$([[ "$TRUE_N" == "1" ]] && echo 1 || echo 0)" "true_count=$TRUE_N"
    # seed-* alias 命中: runtime_id 派生自 slot 哈希（alias 容器形态下与
    # test_see1273_t2_param 同判据）
    ok "R2h seed-* alias 命中（runtime_id = agent-<slot hash>）" \
        "$([[ "$(echo "$OUT" | jq -r .runtime.runtime_id)" == "$RID1" ]] && echo 1 || echo 0)" \
        "$(echo "$OUT" | jq -r .runtime.runtime_id)"

    # —— SEE-1356 hardener：kol_workdir_hash 边界形态全覆盖（每条注明所杀变异类别）——
    WDH() { bash -c 'source "$1/launch/runtime.lib.sh" && kol_workdir_hash "$2"' _ "$REPO" "$1"; }
    WSH() { bash -c 'source "$1/launch/runtime.lib.sh" && out="$(kol_workdir_hash "$2" 2>/dev/null)"; rc=$?; printf "%s|%s|%s" "$rc" "$out" "$KOL_WORKDIR_HASH_SOURCE"' _ "$REPO" "$1"; }
    # R2i 空输入 → rc=1、零输出、source 变量清空。kills: `[[ -n "$wt" ]]`
    #   早退删除（空串会走 sha256("") → 产出一个假哈希 + path 标注）。
    OUTI="$(WSH "")"
    ok "R2i empty input → rc=1, no output, source var cleared" \
        "$([[ "$OUTI" == "1||" ]] && echo 1 || echo 0)" "$OUTI"
    # R2j legacy 裸 8-hex 槽目录 → slot 口径。kills: `{8,}` 下界抬到
    #   `{12,}`（legacy bare-dir 布局会整族跌落 path fallback）。
    WTL="$HOME/multica_workspaces/wslegacy/5d621003/workdir/KingOfLikes-Godot"
    mkdir -p "$WTL"
    ok "R2j legacy bare 8-hex slot dir → slot" \
        "$([[ "$(WDH "$WTL")" == "5d621003 slot" ]] && echo 1 || echo 0)" "$(WDH "$WTL")"
    # R2k 大写 hex 尾段 → 非 slot（大小写敏感）。kills: `[0-9a-f]`→
    #   `[0-9a-fA-F]` 松化（大写尾段会冒充 slot 身份）。
    WTU="$HOME/multica_workspaces/$CONTAINER/see-x-AAAA11112222/workdir/KingOfLikes-Godot"
    mkdir -p "$WTU"
    ok "R2k uppercase hex tail → path fallback (case-sensitivity)" \
        "$([[ "$(WDH "$WTU")" =~ ^[0-9a-f]{8}\ path$ ]] && echo 1 || echo 0)" "$(WDH "$WTU")"
    # R2l 7-hex 尾段（低于下界）→ path fallback。kills: `{8,}`→`{7,}`/`+`
    #   下界松化（短尾段会冒充 slot 哈希，撞 slot 身份空间）。
    WTS="$HOME/multica_workspaces/$CONTAINER/see-x-abc1234/workdir/KingOfLikes-Godot"
    mkdir -p "$WTS"
    ok "R2l 7-hex tail below floor → path fallback" \
        "$([[ "$(WDH "$WTS")" =~ ^[0-9a-f]{8}\ path$ ]] && echo 1 || echo 0)" "$(WDH "$WTS")"
    # R2m 多 `-` 分段槽名 → 尾段即哈希。kills: `${h##*-}` 尾段提取删除
    #   （要求整段裸 hex 会拒绝 see-<issue>-<hex12> 正典形态）。
    WTM="$HOME/multica_workspaces/$CONTAINER/see-x-y-333344445555/workdir/KingOfLikes-Godot"
    mkdir -p "$WTM"
    ok "R2m multi-dash slot name → last -segment is the hash" \
        "$([[ "$(WDH "$WTM")" == "333344445555 slot" ]] && echo 1 || echo 0)" "$(WDH "$WTM")"
    # R2n realpath 归一：词法不同指向同目录 → 同一 path 哈希。kills:
    #   `realpath -m` 归一删除（../ 未折叠 → 哈希漂移，registry 去重失效）。
    H1="$(WDH "$REPO/launch" | cut -d' ' -f1)"
    H2="$(WDH "$REPO/launch/../launch" | cut -d' ' -f1)"
    ok "R2n realpath normalization: lexical variants hash identically" \
        "$([[ -n "$H1" && "$H1" == "$H2" ]] && echo 1 || echo 0)" "$H1 vs $H2"
    # R2o 双形态互斥 + provenance 变量：slot 调用后 source=slot，path 调用后
    #   source=path，失败后清空。kills: `KOL_WORKDIR_HASH_SOURCE` 赋值删除
    #   （标注会滞留上一次取值 → status hash_source 谎报来源）。
    OUTO="$(bash -c 'source "$1/launch/runtime.lib.sh"
kol_workdir_hash "$2" >/dev/null; s1="$KOL_WORKDIR_HASH_SOURCE"
kol_workdir_hash "$3" >/dev/null; s2="$KOL_WORKDIR_HASH_SOURCE"
kol_workdir_hash "" >/dev/null 2>&1; s3="$KOL_WORKDIR_HASH_SOURCE"
printf "%s|%s|%s" "$s1" "$s2" "$s3"' _ "$REPO" "$WT1" "$REPO/launch")"
    ok "R2o hash_source variable tracks slot→path→empty transitions" \
        "$([[ "$OUTO" == "slot|path|" ]] && echo 1 || echo 0)" "$OUTO"
    # R2p path 哈希 = sha256(realpath)[:8] 精确口径。kills: `cut -c1-8`
    #   截断长度变异（16 字符哈希会破坏 runtime_id 槽段宽度契约）。
    REAL_LAUNCH="$(realpath -m -- "$REPO/launch")"
    EXPECTED_HASH="$(printf '%s' "$REAL_LAUNCH" | sha256sum | cut -c1-8)"
    ok "R2p path hash == sha256(realpath)[:8] exact" \
        "$([[ "$(WDH "$REPO/launch")" == "$EXPECTED_HASH path" ]] && echo 1 || echo 0)" "$(WDH "$REPO/launch") vs $EXPECTED_HASH"
}

write_proxy_state() {
    # $1 = doc-json file path for the state; $2 = giveup doc path (optional "")
    node -e '
const fs = require("fs");
const [p, doc] = process.argv.slice(1);
fs.writeFileSync(p, doc);
' "$2" "$1"
}

make_ps_doc() {
    # $1=state $2=heartbeat_age_s $3=extra-json(node obj literal)
    node -e '
const fs = require("fs");
const [out, state, ageS, extra] = process.argv.slice(1);
const hb = new Date(Date.now() - Number(ageS) * 1000).toISOString();
const doc = Object.assign({
    schema: "see1356-l5-proxy-state/1",
    runtime_id: "Bachi-111122223333",
    worktree: process.argv[5],
    workdir_hash: "111122223333",
    hash_source: "slot",
    state, stage: "WARM", port: 6571, pid: process.pid,
    elapsed_ms: 5000, hold_queue_depth: 0, spawn_attempts: 1,
    last_error_bucket: null, give_up_count: 0,
    warmupDiagnostic: { state: "warm", elapsedMs: 5000, warmupTimeoutMs: 300000, stage: "WARM" },
    last_transitions: [{ at: hb, trigger: "heartbeat", state, stage: "WARM" }],
    recent_calls: [],
    heartbeat_at: hb,
}, extra ? JSON.parse(extra) : {});
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
' "$1" "$2" "$3" "$4" "$WT1"
}

make_giveup_doc() {
    # $1=out $2=count $3=cooldown_until(iso or "")
    node -e '
const fs = require("fs");
const [out, count, until] = process.argv.slice(1);
const doc = {
    schema: "see1240-ws5-giveup/1", state: "FAILED_CLEAN",
    updated_at: new Date().toISOString(),
    giveup_count: Number(count), last_event: "give_up", last_bucket: "editor_busy",
    last_reason: "mock", backoff_ms: 30000,
    cooldown_until: until || null,
};
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
' "$1" "$2" "$3"
}

PS1="$GODOT_MCP_HOME/godot-editor/$RID1.proxy-state.json"
GUP1="$GODOT_MCP_HOME/godot-editor/$RID1.giveup.json"

section "R3: proxy_state doctor 仲裁判定表"
{
    # A: fresh + warm + giveup 历史 → 主判据 PASS，giveup 降级为参考
    make_ps_doc "$PS1" "warm" 5 "" ""
    make_giveup_doc "$GUP1" 2 "$(node -e 'process.stdout.write(new Date(Date.now()-60000).toISOString())')"
    OUTJ="$(run_doctor_j)"
    ok "R3a fresh+warm → PASS 主判据" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="PASS" and (.check=="proxy_state:warm"))' >/dev/null 2>&1 && echo 1 || echo 0)"
    ok "R3b giveup 降级为参考（fresh+warm 下不计 WARN）" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="WARN" and (.check|startswith("giveup")))' >/dev/null 2>&1 && echo 0 || echo 1)"
    ok "R3c 两文件 mtime 并列呈现" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select((.check//"")=="proxy_state:warm" and (.detail|contains("mtime=")))' >/dev/null 2>&1 && echo 1 || echo 0)"

    # B: stale（heartbeat 120s）→ 降权为参考 WARN
    make_ps_doc "$PS1" "warm" 120 "" ""
    OUTJ="$(run_doctor_j)"
    ok "R3d stale（>90s）→ WARN 降权参考" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="WARN" and (.check=="proxy_state"))' >/dev/null 2>&1 && echo 1 || echo 0)"

    # C: failed_exit + cooling → WARN 设计内
    make_ps_doc "$PS1" "failed_exit" 5 '{"last_error_bucket":"editor_busy","give_up_count":1}' ""
    make_giveup_doc "$GUP1" 1 "$(node -e 'process.stdout.write(new Date(Date.now()+60000).toISOString())')"
    OUTJ="$(run_doctor_j)"
    ok "R3e failed_exit+cooling → WARN 设计内" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="WARN" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)"

    # D: failed_exit 无 rearm（冷却已毕）→ FAIL 契约逃逸
    make_ps_doc "$PS1" "failed_exit" 5 '{"last_error_bucket":"editor_busy","give_up_count":1}' ""
    make_giveup_doc "$GUP1" 1 "$(node -e 'process.stdout.write(new Date(Date.now()-60000).toISOString())')"
    OUTJ="$(run_doctor_j)"; RCD=0
    HOME="$HOME" GODOT_MCP_HOME="$GODOT_MCP_HOME" KOL_PORT_REGISTRY_PATH_OVERRIDE="$KOL_PORT_REGISTRY_PATH_OVERRIDE" KOL_AGENT_NAME=Bachi KOL_WORKTREE="$WT1" bash "$STATUS" doctor >/dev/null 2>&1 || RCD=$?
    ok "R3f failed_exit 无 rearm → FAIL 契约逃逸" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="FAIL" and (.check=="proxy_state:failed_exit"))' >/dev/null 2>&1 && echo 1 || echo 0)" \
        "$(echo "$OUTJ" | jq -c '[.checks[] | select((.check//"")|startswith("proxy_state"))]' 2>/dev/null)"
    ok "R3g FAIL 判级 → doctor exit 1" "$([[ "$RCD" == "1" ]] && echo 1 || echo 0)" "rc=$RCD"

    # E: 快照缺席 + 无 giveup → PASS 正常
    rm -f "$PS1" "$GUP1"
    OUTJ="$(run_doctor_j)"
    ok "R3h 快照缺席（无 giveup）→ PASS 正常缺席语义" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="PASS" and (.check=="proxy_state"))' >/dev/null 2>&1 && echo 1 || echo 0)"

    # F: 快照缺席 + giveup 存在 → WARN 证据链断裂
    make_giveup_doc "$GUP1" 1 "$(node -e 'process.stdout.write(new Date(Date.now()+60000).toISOString())')"
    OUTJ="$(run_doctor_j)"
    ok "R3i 快照缺席但 giveup 存在 → WARN 证据链断裂" \
        "$([[ -n "$OUTJ" ]] && echo "$OUTJ" | jq -e '.checks[] | select(.level=="WARN" and (.check=="proxy_state"))' >/dev/null 2>&1 && echo 1 || echo 0)"
    rm -f "$GUP1"
}

section "R4: proxylog 段（64KB tail 扫描 + JSON-RPC 污染哨兵）"
{
    PLOG="$GODOT_MCP_HOME/godot-editor/$RID1.proxy.log"
    {
        printf '[godot-mcp-proxy] [pid=424242] [stage=WARM] [t=+9500ms] [ts=2026-09-29T00:00:00.000Z] warm reached\n'
        printf '[godot-mcp-proxy] [pid=424242] [stage=NPX_CLI_CONNECTED] [t=+9800ms] [ts=2026-09-29T00:00:00.300Z] ok\n'
        printf '[godot-mcp-proxy] [pid=424242] INFO: the spawn method: default\n'
    } > "$PLOG"
    OUT="$(run_status "$WT1" "$WT1")"
    ok "R4a proxylog 段 present + highest_stage 提取" \
        "$([[ "$(echo "$OUT" | jq -r .proxylog.present)" == "true" && "$(echo "$OUT" | jq -r .proxylog.highest_stage)" == "WARM" ]] && echo 1 || echo 0)" \
        "$(echo "$OUT" | jq -c '{present: .proxylog.present, stage: .proxylog.highest_stage}')"
    ok "R4b JSON-RPC 污染哨兵恒 false（含 method: 字样的日志行不误报）" \
        "$([[ "$(echo "$OUT" | jq -r .proxylog.json_rpc_contaminated)" == "false" ]] && echo 1 || echo 0)"
    ok "R4c last_lines 尾部窗口存在" \
        "$([[ "$(echo "$OUT" | jq '.proxylog.last_lines | length')" -ge 2 ]] && echo 1 || echo 0)"
    # 污染正例：真 JSON-RPC 行必须触发哨兵
    printf '{"jsonrpc":"2.0","id":1,"result":{}}\n' >> "$PLOG"
    OUT="$(run_status "$WT1" "$WT1")"
    ok "R4d 真 JSON-RPC 行触发污染哨兵（契约 breach 可见）" \
        "$([[ "$(echo "$OUT" | jq -r .proxylog.json_rpc_contaminated)" == "true" ]] && echo 1 || echo 0)"
    rm -f "$PLOG"
}

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
