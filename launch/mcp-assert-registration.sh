#!/usr/bin/env bash
# SEE-1242 B-2 P3-1: doctor SessionStart 断言。
#
# 在每次 Claude Code SessionStart 时被动运行：调用 godot-status.sh doctor
# （SEE-1240 WS-4 注册层检查）对 /tmp/multica-mcp-*/mcp-config.json 的
# godot-mcp 条目做注册层对账，结果写入 hook-fire.log。registration FAIL
# = 2026-08-01 全员中断形态（command 缺失/指向已删路径），即刻可见，
# 不必等 agent 首次调工具才发现幽灵工具。
#
# 设计约束：
#   - 只读探测，零副作用（不写 /tmp、不动 mcp-config）；
#   - 任何失败都是软失败（exit 0），绝不阻塞 SessionStart；
#   - 输出同时带 registration verdict 与 doctor verdict，供 B-0 归因
#     （「配置完好 + tool list 缺失」= 注册窗口时序竞态，非静默丢弃）。
#
# 用法：由 SessionStart hook（repo-checkout.sh 末尾）被动调用，也可手动跑：
#   bash .dev/godot-mcp/launch/mcp-assert-registration.sh [--json]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SCRIPT_DIR = <repo>/KingOfLikes-Godot/.dev/godot-mcp/launch → repo root 三级上跳
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HOOK_FIRE_LOG="${PROJECT_ROOT:-$(cd "$REPO_ROOT/.." && pwd)}/.claude/hook-fire.log"
[[ -d "$(dirname "$HOOK_FIRE_LOG")" ]] || HOOK_FIRE_LOG="$HOME/.claude/hook-fire.log"

JSON_MODE=0
[[ "${1:-}" == "--json" ]] && JSON_MODE=1

if [[ ! -f "$REPO_ROOT/.dev/godot-mcp/launch/godot-status.sh" ]]; then
    # 软失败：godot-status.sh 不在（旧分支/未检出），只记一行缺位事实
    printf '[%s] [mcp-assert-registration] SKIP: godot-status.sh not found at %s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_ROOT" >> "$HOOK_FIRE_LOG" 2>/dev/null || true
    exit 0
fi

DOCTOR_JSON="$(bash "$REPO_ROOT/.dev/godot-mcp/launch/godot-status.sh" doctor --json 2>/dev/null || true)"

if [[ -z "$DOCTOR_JSON" ]]; then
    printf '[%s] [mcp-assert-registration] WARN: doctor produced no output (godot-status.sh failed)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOOK_FIRE_LOG" 2>/dev/null || true
    exit 0
fi

RESULT="$(DOCTOR_JSON="$DOCTOR_JSON" node -e '
const d = JSON.parse(process.env.DOCTOR_JSON);
const reg = d.registration_detail || {};
const cfgs = reg.configs || [];
let godotEntries = 0, broken = 0;
for (const c of cfgs) for (const s of (c.godot_servers || [])) {
    godotEntries++;
    if (s.verdict === "broken") broken++;
}
let verdict;
if (godotEntries === 0) verdict = "NO_GODOT_ENTRY";
else if (broken > 0) verdict = "FAIL";
else verdict = "PASS";
process.stdout.write(JSON.stringify({
    verdict,
    godot_entries: godotEntries,
    broken,
    doctor_verdict: d.verdict || "?",
    configs_seen: cfgs.length
}));
' 2>/dev/null || echo '{"verdict":"PARSE_FAIL","godot_entries":0,"broken":0,"doctor_verdict":"?","configs_seen":0}')"

VERDICT="$(RESULT_JSON="$RESULT" node -e 'process.stdout.write(JSON.parse(process.env.RESULT_JSON).verdict)' 2>/dev/null || echo "PARSE_FAIL")"

printf '[%s] [mcp-assert-registration] %s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VERDICT" "$RESULT" >> "$HOOK_FIRE_LOG" 2>/dev/null || true

if (( JSON_MODE )); then
    printf '%s\n' "$RESULT"
fi

# 断言语义：FAIL/NO_GODOT_ENTRY 是幽灵工具的注册层根因（agent 侧可见即上报）；
# PASS 但 tool list 仍缺 → 注册窗口时序竞态（B-1 裁决定性），交 P3-2 被动记录归因。
# SessionStart hook 永不因此失败（exit 0）。
exit 0
