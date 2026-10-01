#!/usr/bin/env bash
# SEE-1273 AC-M3REORG-013: shell 孪生守卫空值单测（prepare-worktree / configure-mcp-port）。
#
# 判据（与 8d51b13 JS 版逐语义对齐）：GODOT_MCP_SHARED_MASTER 为空串/未设时，
# 守卫必须「不拦任何路径」；非空时精确拦 shared master 及其子路径、放行 agent
# worktree。
#
# 真实代码驱动（非重实现）：从两个脚本 sed 抽取实际的 known_shared 赋值 + if
# 条件行，把 $WORKTREE/$target_dir 绑定为测试值后 eval 求值——源码丢了空值
# 守卫，本测试即转红。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../../.. && pwd)"
LAUNCH="$REPO/launch"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# run_guard <file> <tested-path> <shared-master> → prints BLOCK | ALLOW
# 抽取源码里真实的 known_shared= 赋值行与紧跟的 if 条件行，原样 eval——
# 条件里引用的 $WORKTREE/$target_dir 直接在 eval 上下文里定义为实测值。
run_guard() {
    local file="$1" value="$2" shared="$3"
    local block
    block="$(awk '
        /^[[:space:]]*(local )?known_shared=/ { print; grab=1; next }
        grab && /^[[:space:]]*if .*known_shared/ { print; exit }
    ' "$file")"
    [ -n "$block" ] || { echo "EXTRACT-FAIL"; return 1; }
    GUARD_SRC="$block" GUARD_VALUE="$value" GODOT_MCP_SHARED_MASTER="$shared" bash -c '
        WORKTREE="$GUARD_VALUE"
        target_dir="$GUARD_VALUE"
        # 真实源码两行：赋值行（可能带 local 前缀，子 shell 非函数需剥掉）+ if 条件行原样 eval
        assign="$(printf "%s\n" "$GUARD_SRC" | head -1 | sed "s|^[[:space:]]*local ||")"
        cond="$(printf "%s\n" "$GUARD_SRC" | tail -1)"
        cond="${cond#"${cond%%[![:space:]]*}"}"   # 剥前导空白（configure 在函数内缩进）
        cond="${cond#if }"
        cond="${cond%%; then*}"
        eval "$assign"
        if eval "$cond"; then echo BLOCK; else echo ALLOW; fi
    '
}

check_src_has_guard() {  # <file> <label>
    local file="$1" label="$2"
    if grep -qE '\[\[ -n "\$known_shared" \]\] &&' "$file"; then
        ok "$label 源码含空值守卫 [[ -n \$known_shared ]]"
    else
        bad "$label 源码丢失空值守卫（[[ -n \$known_shared ]] 不在）"
    fi
}

echo "== AC-M3REORG-013.1: 源码结构断言（真实文件）=="
check_src_has_guard "$LAUNCH/prepare-worktree.sh" "prepare-worktree.sh"
check_src_has_guard "$LAUNCH/configure-mcp-port.sh" "configure-mcp-port.sh"

echo "== AC-M3REORG-013.2: prepare-worktree 守卫行为（抽取真实条件行 eval）=="
PW="$LAUNCH/prepare-worktree.sh"
r="$(run_guard "$PW" "/home/x/multica_workspaces/seed-ws/see-1-aaaa/workdir/KingOfLikes-Godot" "")"
[[ "$r" == "ALLOW" ]] && ok "空串 env + agent worktree → ALLOW（守卫不拦）" || bad "空串 env 误拦（got '$r'）"
r="$(run_guard "$PW" "/mnt/d/GodotProjects/king-of-likes" "")"
[[ "$r" == "ALLOW" ]] && ok "空串 env + 共享 master 路径 → ALLOW（K5 probe-failure 不拦）" || bad "空串 env 行为异常（got '$r'）"
r="$(run_guard "$PW" "/mnt/d/GodotProjects/king-of-likes" "/mnt/d/GodotProjects/king-of-likes")"
[[ "$r" == "BLOCK" ]] && ok "非空 env + 精确 shared master → BLOCK" || bad "精确匹配漏拦（got '$r'）"
r="$(run_guard "$PW" "/mnt/d/GodotProjects/king-of-likes/sub" "/mnt/d/GodotProjects/king-of-likes")"
[[ "$r" == "BLOCK" ]] && ok "非空 env + 子路径 → BLOCK" || bad "子路径漏拦（got '$r'）"
r="$(run_guard "$PW" "/home/x/workdir/KingOfLikes-Godot" "/mnt/d/GodotProjects/king-of-likes")"
[[ "$r" == "ALLOW" ]] && ok "非空 env + 无关路径 → ALLOW" || bad "无关路径误拦（got '$r'）"
r="$(run_guard "$PW" "/mnt/d/GodotProjects/king-of-likes-other" "/mnt/d/GodotProjects/king-of-likes")"
[[ "$r" == "ALLOW" ]] && ok "非空 env + 兄弟前缀（无斜杠边界）→ ALLOW" || bad "兄弟前缀误拦（got '$r'）"

echo "== AC-M3REORG-013.3: configure-mcp-port 守卫行为 =="
CF="$LAUNCH/configure-mcp-port.sh"
r="$(run_guard "$CF" "/home/x/workdir/KingOfLikes-Godot" "")"
[[ "$r" == "ALLOW" ]] && ok "空串 env + agent worktree → ALLOW" || bad "空串 env 误拦（got '$r'）"
r="$(run_guard "$CF" "/mnt/d/GodotProjects/king-of-likes" "/mnt/d/GodotProjects/king-of-likes")"
[[ "$r" == "BLOCK" ]] && ok "非空 env + 共享 master → BLOCK" || bad "精确匹配漏拦（got '$r'）"
r="$(run_guard "$CF" "/mnt/d/GodotProjects/king-of-likes/sub" "/mnt/d/GodotProjects/king-of-likes")"
[[ "$r" == "BLOCK" ]] && ok "非空 env + 子路径 → BLOCK" || bad "子路径漏拦（got '$r'）"

echo ""
echo "==== AC-M3REORG-013 shell guards: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
