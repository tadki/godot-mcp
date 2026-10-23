#!/usr/bin/env bash
# SEE-1458 §SPEC-101: deployment-config 自举三布局行为钉扎。
#
# SEE-1430b 把 KOL 部署配置从 .dev/env/kol-mcp.env 搬到 .env/kol-mcp.env 后,
# launcher 的向上自举只认旧路径 → 静默 no-op → GODOT_MCP_HOME 漂到 env.sh
# 中性默认 (~/.config/godot-mcp), 状态双落点 (SEE-1457 实测)。判据:
#   新布局 (.env/kol-mcp.env)   → 自举命中, GODOT_MCP_HOME 钉到 env 文件值;
#   旧布局 (.dev/env/kol-mcp.env) → 行为不变, 同样命中;
#   双布局并存 (过渡树)          → 新布局优先 (与 .mcp.json 链同源);
#   standalone (两处皆无)        → 静默 no-op, GODOT_MCP_HOME 保持未设
#                                  (env.sh 中性默认在后续 :− 链生效);
#   深度护栏                     → 4 层向上预算外的 env 文件不命中。
#
# 真实代码驱动（非重实现）：awk 抽取 launcher 内真实的自举循环原样 eval —
# 源码丢了任一路径探测或深度护栏，本测试即转红。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../../.. && pwd)"
LAUNCH="$REPO/launch"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# 抽取 launcher 内真实自举块: 从赋值行到 unset 行（含）, 原样输出
BOOTSTRAP_BLOCK="$(awk '
    /^_gmc_depl_root="\$SCRIPT_DIR"$/ { grab=1 }
    grab { print }
    grab && /^unset _gmc_depl_root$/ { exit }
' "$LAUNCH/godot-mcp-launcher.sh")"
[ -n "$BOOTSTRAP_BLOCK" ] || { echo "FAIL: 自举块抽取失败（launcher 源码结构漂移?）"; exit 1; }

# run_bootstrap <script_dir> → "source=<new|legacy|none> home=<value|unset>"
# 子 shell 内 set -euo pipefail 复刻 launcher 严格模式; eval 前定义 SCRIPT_DIR。
run_bootstrap() {
    local sd="$1"
    SCRIPT_DIR="$sd" bash -c '
        set -euo pipefail
        GODOT_MCP_HOME=""
        GMC_DEPL_SOURCE="none"
        '"$(printf "%s" "$BOOTSTRAP_BLOCK")"'
        printf "source=%s home=%s\n" "$GMC_DEPL_SOURCE" \
            "${GODOT_MCP_HOME:-unset}"
    '
}

# make_env_file <path> <kind> — 测试夹具 env 文件: 钉 GODOT_MCP_HOME 到哨兵值
make_env_file() {
    local file="$1" kind="$2"
    mkdir -p "$(dirname "$file")"
    printf 'export GODOT_MCP_HOME="/sentinel/multica-home"\nGMC_DEPL_SOURCE=%s\n' "$kind" > "$file"
}

BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT
# SCRIPT_DIR 深度: BASE/ws/a/b/c/d — 向上候选根 = c, b, a, ws (4 层预算内);
# BASE 本体在第 5 层 → 深度护栏外。
SD="$BASE/ws/a/b/c/d"
mkdir -p "$SD"

echo "== SEE-1458 §SPEC-101.1: 新布局 (.env/kol-mcp.env) =="
make_env_file "$BASE/ws/.env/kol-mcp.env" new
r="$(run_bootstrap "$SD")"
case "$r" in
    "source=new home=/sentinel/multica-home")
        ok "新布局命中: $r" ;;
    *) bad "新布局未命中/漂移 (got '$r')" ;;
esac
rm -rf "$BASE/ws/.env"

echo "== SEE-1458 §SPEC-101.2: 旧布局 (.dev/env/kol-mcp.env) =="
make_env_file "$BASE/ws/a/.dev/env/kol-mcp.env" legacy
r="$(run_bootstrap "$SD")"
case "$r" in
    "source=legacy home=/sentinel/multica-home")
        ok "旧布局命中: $r" ;;
    *) bad "旧布局未命中/漂移 (got '$r')" ;;
esac
rm -rf "$BASE/ws/a/.dev"

echo "== SEE-1458 §SPEC-101.3: 双布局并存（同一 repo root 过渡树）→ 新布局优先 =="
# 过渡树的真实形态: .dev 合并前后两份 env 同在 repo root 一层; 同层内新路径
# 先探测（与 .mcp.json 链 source .env/ 同源）。更近层的旧文件先于更远层的新
# 文件命中属向上行走语义, 不在本判据内。
make_env_file "$BASE/ws/a/.env/kol-mcp.env" new
make_env_file "$BASE/ws/a/.dev/env/kol-mcp.env" legacy
r="$(run_bootstrap "$SD")"
case "$r" in
    "source=new home=/sentinel/multica-home")
        ok "双布局新者优先: $r" ;;
    *) bad "双布局优先级漂移 (got '$r')" ;;
esac
rm -rf "$BASE/ws/a/.env" "$BASE/ws/a/.dev"

echo "== SEE-1458 §SPEC-101.4: standalone (两处皆无) → 静默 no-op =="
r="$(run_bootstrap "$SD")"
case "$r" in
    "source=none home=unset")
        ok "standalone 静默 no-op: $r" ;;
    *) bad "standalone 非 no-op (got '$r')" ;;
esac

echo "== SEE-1458 §SPEC-101.5: 深度护栏 (env 在第 5 层) 不命中 =="
make_env_file "$BASE/.env/kol-mcp.env" new
r="$(run_bootstrap "$SD")"
case "$r" in
    "source=none home=unset")
        ok "深度护栏保持: $r" ;;
    *) bad "深度护栏失效 (got '$r')" ;;
esac
rm -rf "$BASE/.env"

echo "== SEE-1458 §SPEC-101.6: 源码结构守卫 =="
if grep -q '\.env/kol-mcp\.env' "$LAUNCH/godot-mcp-launcher.sh" \
    && grep -q '\.dev/env/kol-mcp\.env' "$LAUNCH/godot-mcp-launcher.sh"; then
    ok "launcher 同时探测新/旧两路径"
else
    bad "launcher 丢失新旧路径之一"
fi
unset_line="$(grep -n '^unset _gmc_depl_root$' "$LAUNCH/godot-mcp-launcher.sh" | head -1 | cut -d: -f1)"
# shellcheck disable=SC2016  # 字面量模式（含 ${SCRIPT_DIR} 文本）→ grep -F 固定串匹配
envsh_src='. "${SCRIPT_DIR}/env.sh"'
envsh_line="$(grep -nF "$envsh_src" "$LAUNCH/godot-mcp-launcher.sh" | head -1 | cut -d: -f1)"
if [ -n "$unset_line" ] && [ -n "$envsh_line" ] && [ "$unset_line" -lt "$envsh_line" ]; then
    ok "自举先于 env.sh（钉值不被中性默认抢先, L$unset_line < L$envsh_line）"
else
    bad "自举/env.sh 顺序漂移 (unset=L${unset_line:-?} env.sh=L${envsh_line:-?})"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PASS ($PASS checks)"
    exit 0
fi
echo "FAILED ($FAIL of $((PASS+FAIL)) checks)"
exit 1
