#!/usr/bin/env bash
# SEE-1458 §SPEC-101 活机 A/B：launcher 部署自举状态目录漂移（/abtest 流程）。
#
# 实机专用 QA harness — 依赖真实 KOL 工作树的 .env/kol-mcp.env 内容与真实
# launcher 全链路，不适合 CI/vitest 环境，故意不注册 vitest（同 launch/tests
# 下 61 个 drift/env harness 亦不进自动发现）。
#
# 对照组 A = 修复前 launcher（git show cdc8b96:launch/...；与 D 盘 master 活机
#           launcher 逐字节一致，启动时 md5 复核）
# 实验组 B = 修复后 launcher（默认本仓工作树 launch/godot-mcp-launcher.sh）
#
# 判据（concrete oracle，fake node 捕获 config-validate 真实 argv）：
#   A1-A3 全链路 3/3：bootstrap 静默 no-op → --godot-mcp-home <sbx>/.config/
#       godot-mcp（env.sh 中性默认）、--shared-master 空、--marker 空
#   B1-B3 全链路 3/3：bootstrap 命中 .env/kol-mcp.env → --godot-mcp-home
#       <sbx>/.multica + --shared-master /mnt/d/... + --marker 1（env 文件
#       全量语义恢复，与 .mcp.json 链同源 = 语义不变）
#   语义不变旁证：A/B 在 validate 失败路径上 exit 同为 2、同打
#       CONFIG_VALIDATE_FAIL 横幅；standalone（无 env 文件）下 B 与 A 同 no-op
#
# 环境隔离（/abtest Step 2）：每轮独立 mktemp sandbox HOME；A/B 除 launcher
# 版本外环境逐字节相同（同一棵树、同一 env 文件副本、同一 fake node）；
# trap 清理。同步执行无等待（fork CLAUDE.md 事件驱动规则 N/A）。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../../.. && pwd)"
LAUNCH_REL="launch/godot-mcp-launcher.sh"
AFTER="${ABTEST_AFTER_LAUNCHER:-$REPO/$LAUNCH_REL}"
KOL_ENV_SRC="${ABTEST_KOL_ENV:-$REPO/../KingOfLikes-Godot/.env/kol-mcp.env}"
LIVE_D="/mnt/d/GodotProjects/king-of-likes/addons/godot_mcp/launch/godot-mcp-launcher.sh"
EXPECT_MASTER="/mnt/d/GodotProjects/king-of-likes"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BEFORE_FILE="$TMP/before.sh"
git -C "$REPO" show "cdc8b96:$LAUNCH_REL" > "$BEFORE_FILE" 2>/dev/null \
    || { echo "FAIL: 修复前版本提取失败 (cdc8b96:$LAUNCH_REL)"; exit 1; }
[ -s "$BEFORE_FILE" ] || { echo "FAIL: 修复前版本提取为空"; exit 1; }
[ -f "$AFTER" ] || { echo "FAIL: 修复后 launcher 缺失 ($AFTER)"; exit 1; }
[ -f "$KOL_ENV_SRC" ] || { echo "FAIL: 真实 KOL .env/kol-mcp.env 未找到 ($KOL_ENV_SRC)"; exit 1; }

# A/B 单变量隔离：env.sh 两版本必须一致，否则差异不止 launcher
if git -C "$REPO" diff --quiet cdc8b96..HEAD -- launch/env.sh; then
    ok "env.sh 修复前后一致（A/B 唯一差异 = launcher 自举块）"
else
    bad "env.sh 在两版本间有差异，A/B 不再单变量"
fi

if [ -f "$LIVE_D" ]; then
    before_md5="$(md5sum "$BEFORE_FILE" | cut -d' ' -f1)"
    live_md5="$(md5sum "$LIVE_D" | cut -d' ' -f1)"
    if [ "$before_md5" = "$live_md5" ]; then
        ok "对照组 A ≡ D 盘 master 活机 launcher (md5 $live_md5) — 对照即生产代码"
    else
        bad "对照组 A 与活机 launcher 字节不一致 ($before_md5 vs $live_md5)"
    fi
else
    echo "  note: D 盘活机 launcher 不存在（非实机复跑场景），跳过字节一致性旁证"
fi

mkdir -p "$TMP/kol/addons/godot_mcp/launch" "$TMP/kol/.env"
cp "$KOL_ENV_SRC" "$TMP/kol/.env/kol-mcp.env"
cp "$REPO/launch/env.sh" "$TMP/kol/addons/godot_mcp/launch/env.sh"
LAUNCH_IN_TREE="$TMP/kol/addons/godot_mcp/launch/godot-mcp-launcher.sh"

# fake node：捕获 config-validate 全 argv 后 exit 3 → launcher 走确定性
# CONFIG_VALIDATE_FAIL 早退（真实脚本 L1→validate 全链路被真实执行）
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nprintf "NODEARGV:"\nprintf " %%q" "$@"\nprintf "\\n"\nexit 3\n' > "$FAKEBIN/node"
chmod +x "$FAKEBIN/node"

# node_argv <err_file> <flag>：从 stderr 回显的 NODEARGV 行取 --flag 的值。
# sandbox 路径与预期值均无空格/特殊字符，%q 输出与裸值一致，可按空格切分；
# 空参数经 %q 变成字面 ''，此处归一为空串。
node_argv() {
    awk '/^NODEARGV:/{line=$0} END{if(line!="")print line}' "$1" \
        | tr ' ' '\n' | awk -v f="$2" '$0==f{getline; print; exit}' \
        | sed "s/^''$//"
}

# chain_run <group><round>：安装指定版本 launcher 后全链路跑一轮
chain_run() {
    local tag="$1" launcher="$2"
    local sbx="$TMP/home_$tag"
    mkdir -p "$sbx"
    cp "$launcher" "$LAUNCH_IN_TREE"
    HOME="$sbx" PATH="$FAKEBIN:$PATH" MULTICA_AGENT_NAME="revyqa$tag" \
        timeout 20 bash "$LAUNCH_IN_TREE" "revyqa$tag" \
        </dev/null >"$sbx.out" 2>"$sbx.err"
    echo "$?" > "$sbx.exit"
    local rc gmh master marker want_home want_master want_marker
    rc="$(cat "$sbx.exit")"
    gmh="$(node_argv "$sbx.err" --godot-mcp-home)"
    master="$(node_argv "$sbx.err" --shared-master)"
    marker="$(node_argv "$sbx.err" --marker)"
    if [[ "$tag" == A* ]]; then
        want_home="$sbx/.config/godot-mcp"; want_master=""; want_marker=""
    else
        want_home="$sbx/.multica"; want_master="$EXPECT_MASTER"; want_marker="1"
    fi
    if [ "$rc" = "2" ] && grep -q "CONFIG_VALIDATE_FAIL" "$sbx.err"; then
        ok "$tag exit=2 + CONFIG_VALIDATE_FAIL 横幅（失败路径语义两版一致）"
    else
        bad "$tag exit=$rc / 横幅缺失（语义漂移）"
    fi
    if [ "$gmh" = "$want_home" ]; then
        ok "$tag GODOT_MCP_HOME=$gmh"
    else
        bad "$tag GODOT_MCP_HOME 漂移 (got '${gmh:-<none>}' want '$want_home')"
    fi
    if [ "$master" = "$want_master" ] && [ "$marker" = "$want_marker" ]; then
        ok "$tag env 语义 (master='${master:-}' marker='${marker:-}')"
    else
        bad "$tag env 语义不全 (master='${master:-}' want '${want_master:-}'; marker='$marker' want '$want_marker')"
    fi
}

echo "== 对照组 A（修复前 ≡ 活机 master launcher）×3 =="
for i in 1 2 3; do
    chain_run "A$i" "$BEFORE_FILE"
done
echo "== 实验组 B（修复后 launcher）×3 =="
for i in 1 2 3; do
    chain_run "B$i" "$AFTER"
done

echo "== 补充：standalone（树内无 env 文件）B 保持 no-op（兼容无回归）×1 =="
rm -rf "$TMP/kol/.env"
SBX_S="$TMP/home_S1"
mkdir -p "$SBX_S"
cp "$AFTER" "$LAUNCH_IN_TREE"
HOME="$SBX_S" PATH="$FAKEBIN:$PATH" MULTICA_AGENT_NAME="revyqas" \
    timeout 20 bash "$LAUNCH_IN_TREE" revyqas </dev/null >"$SBX_S.out" 2>"$SBX_S.err"
rc_s="$?"
gmh_s="$(node_argv "$SBX_S.err" --godot-mcp-home)"
marker_s="$(node_argv "$SBX_S.err" --marker)"
if [ "$rc_s" = "2" ] && [ "$gmh_s" = "$SBX_S/.config/godot-mcp" ] && [ "$marker_s" = "" ]; then
    ok "standalone: B 静默 no-op + 中性默认 (home=$gmh_s marker='')"
else
    bad "standalone 行为回归 (exit=$rc_s home='${gmh_s:-<none>}' marker='$marker_s')"
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "A/B RESULT: A组复现漂移 3/3, B组收敛 ~/.multica 3/3, standalone 无回归"
    exit 0
fi
echo "A/B RESULT: FAIL"
exit 1
