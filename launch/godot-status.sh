#!/usr/bin/env bash
# SEE-1240 WS-4 (C1+C2): godot-mcp status/doctor — 三消费形态共用一个可查询数据基底。
#
# 用法:
#   godot-status.sh status  [--json]   (a) status 查询 — agent 排障主入口（JSON 契约）
#   godot-status.sh doctor [--json]    (b) doctor 链路层体检（PASS/WARN/FAIL 判级）
#                                      (c) 注册层检查内置于 doctor 首位断言
#                                          （/tmp/multica-mcp-*/mcp-config.json 比对）
#
# 数据源（只读；lease sidecar 保持唯一真相源——WS-4 约束"不得引入第二真相源"）:
#   lease sidecar, port registry, lifecycle pidfiles, OS 端口实测（探测优先级
#   复用 arbiter 语义）, editor log stage 行, /tmp/multica-mcp-*/mcp-config.json
#   注册层, D4 超时全表。
#
# Exit codes: status 恒 0（查询永不因链路故障而失败——故障本身就是答案）。
#             doctor: 0=全 PASS, 1=有 FAIL, 2=仅 WARN（三态互斥，CI 友好）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=godot-status.lib.sh
source "$SCRIPT_DIR/godot-status.lib.sh"

MODE="${1:-status}"
JSON_OUT=0
shift || true
while (( $# > 0 )); do
    case "$1" in
        --json) JSON_OUT=1; shift ;;
        -h|--help)
            sed -n '2,14p' "$0"
            exit 0
            ;;
        *) echo "[godot-status] unknown arg: $1 (usage: godot-status.sh status|doctor [--json])" >&2; exit 2 ;;
    esac
done

case "$MODE" in
    status|doctor) ;;
    *) echo "[godot-status] unknown mode: $MODE (expected status|doctor)" >&2; exit 2 ;;
esac

# --- 解析查询对象（与 launcher 同派生逻辑，同降级）---------------------------
source "$SCRIPT_DIR/kol-runtime.lib.sh"
source "$SCRIPT_DIR/agent-ports.lib.sh" 2>/dev/null || true

AGENT_NAME="${KOL_AGENT_NAME:-${1:-}}"
WT_RESOLVED=""
if [[ -n "${KOL_WORKTREE:-}" ]]; then
    WT_RESOLVED="$KOL_WORKTREE"
elif command -v git >/dev/null 2>&1; then
    # Best-effort: 查询通常在 agent 关心的 repo 内运行。
    WT_RESOLVED="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
RUNTIME_ID=""
if [[ -n "$WT_RESOLVED" ]]; then
    RUNTIME_ID="$(kol_derive_runtime_id "$AGENT_NAME" "$WT_RESOLVED")"
elif [[ -n "$AGENT_NAME" ]]; then
    RUNTIME_ID="${AGENT_NAME}-solo"
fi
LABEL=""
if [[ -n "$AGENT_NAME" ]]; then
    LABEL="$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')"
fi

# 端口解析优先级镜像 launcher: KOL_MCP_PORT > registry 条目 > lease sidecar > legacy 表。
PORT="${KOL_MCP_PORT:-}"
PORT_SOURCE=""
if [[ -n "$PORT" ]]; then
    PORT_SOURCE="env:KOL_MCP_PORT"
fi
# registry 条目端口（只读查询，不复用 upsert；entry 缺失返回空）
reg_port=""
if [[ -n "$RUNTIME_ID" && -f "${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${HOME}/.multica/godot-port-registry.json}" ]]; then
    reg_port="$(REG_PATH="${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${HOME}/.multica/godot-port-registry.json}" REG_RID="$RUNTIME_ID" node -e '
let raw = "";
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
    try {
        const o = JSON.parse(raw);
        const e = (o.entries || {})[process.env.REG_RID];
        if (e && e.port != null) process.stdout.write(String(e.port));
    } catch (err) {}
});' < "${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${HOME}/.multica/godot-port-registry.json}" 2>/dev/null || true)"
fi
if [[ -z "$PORT" && "$reg_port" =~ ^[0-9]+$ ]]; then
    PORT="$reg_port"; PORT_SOURCE="registry:${RUNTIME_ID}"
fi
LEASE_FILE=""
if [[ -n "$WT_RESOLVED" ]]; then
    LEASE_FILE="$WT_RESOLVED/.godot/mcp-lease.json"  # 路径始终报告，即使文件不存在
fi
if [[ -z "$PORT" && -n "$LEASE_FILE" && -f "$LEASE_FILE" ]]; then
    _lp="$(sidecar_get "$LEASE_FILE" "port" 2>/dev/null || true)"
    if [[ "$_lp" =~ ^[0-9]+$ ]]; then
        PORT="$_lp"; PORT_SOURCE="lease_sidecar"
    fi
fi
if [[ -z "$PORT" && -n "$AGENT_NAME" ]] && declare -f resolve_port_for_agent >/dev/null 2>&1; then
    # Legacy 静态表（deprecated, SEE-1148 P4 迁移窗口）——最后兜底，旧路径仍有意义。
    _tp="$(resolve_port_for_agent "$AGENT_NAME" 2>/dev/null || true)"
    if [[ "$_tp" =~ ^[0-9]+$ ]]; then
        PORT="$_tp"; PORT_SOURCE="agent-ports.json (deprecated legacy table)"
    fi
fi

# --- 聚合 ---------------------------------------------------------------------
LEASE_JSON="$(status_lease_json "$LEASE_FILE")"
REGISTRY_JSON="$(status_registry_json)"
LIFECYCLE_JSON="$(status_lifecycle_json "$RUNTIME_ID" "$LABEL")"
LAUNCHER_LOG=""
[[ -n "$LABEL" ]] && LAUNCHER_LOG="${HOME}/.multica/godot-mcp-launcher-${LABEL}.log"
[[ -z "$LAUNCHER_LOG" && -n "$PORT" ]] && LAUNCHER_LOG="${HOME}/.multica/godot-mcp-launcher-port-${PORT}.log"
WARMUP_JSON="$(status_warmup_json "$RUNTIME_ID" "$LABEL" "$LAUNCHER_LOG")"
GIVEUP_JSON="$(status_giveup_json "$RUNTIME_ID" "$LABEL")"
REGISTRATION_JSON="$(status_registration_json)"
TIMEOUTS_JSON="$(status_timeouts_json)"
PORT_BOUND="null"
if [[ -n "$PORT" ]]; then
    if status_port_bound "$PORT"; then PORT_BOUND=true; else PORT_BOUND=false; fi
fi

# --- 组装（node 纯 JSON，杜绝字符串拼接）--------------------------------------
OUT="$(mktemp /tmp/godot-status-out.XXXXXX.json)"
trap 'rm -f "$OUT"' EXIT
AGENT="$AGENT_NAME" RID="$RUNTIME_ID" LBL="$LABEL" PORTV="${PORT:-}" PSRC="$PORT_SOURCE" \
WT="$WT_RESOLVED" PB="$PORT_BOUND" LEASE="$LEASE_JSON" REG="$REGISTRY_JSON" \
LIFE="$LIFECYCLE_JSON" WARM="$WARMUP_JSON" GUP="$GIVEUP_JSON" REGS="$REGISTRATION_JSON" TIMEO="$TIMEOUTS_JSON" \
node -e '
const env = process.env;
const j = (s, name) => { try { return JSON.parse(s); } catch (e) { return { error: `unreadable:${name}` }; } };
const doc = {
    schema: "see1240-ws4-status/1",
    generated_at: new Date().toISOString(),
    runtime: {
        agent: env.AGENT || "",
        runtime_id: env.RID || "",
        label: env.LBL || "",
        port: env.PORTV ? Number(env.PORTV) : null,
        port_source: env.PSRC || "",
        worktree: env.WT || "",
        port_bound: env.PB === "true" ? true : env.PB === "false" ? false : null,
    },
    lease: j(env.LEASE, "lease"),
    registry: j(env.REG, "registry"),
    lifecycle: j(env.LIFE, "lifecycle"),
    warmup: j(env.WARM, "warmup"),
    giveup: j(env.GUP, "giveup"),
    registration: j(env.REGS, "registration"),
    timeouts: j(env.TIMEO, "timeouts"),
};
require("fs").writeFileSync(process.argv[1], JSON.stringify(doc, null, 2) + "\n");
' "$OUT" \
AGENT="$AGENT_NAME" RID="$RUNTIME_ID" LBL="$LABEL" PORTV="${PORT:-}" PSRC="$PORT_SOURCE" \
WT="$WT_RESOLVED" PB="$PORT_BOUND" LEASE="$LEASE_JSON" REG="$REGISTRY_JSON" \
LIFE="$LIFECYCLE_JSON" WARM="$WARMUP_JSON" GUP="$GIVEUP_JSON" REGS="$REGISTRATION_JSON" TIMEO="$TIMEOUTS_JSON" || true

if [[ ! -s "$OUT" ]]; then
    echo "[godot-status] ERROR: failed to compose status document (node assembly failed); sources: lease=${LEASE_FILE:-none} registry=${HOME}/.multica/godot-port-registry.json" >&2
    exit 3
fi

if [[ "$MODE" == "status" ]]; then
    # (a) status: agent 排障主入口 — JSON 契约，查询永不因链路故障而失败。
    cat "$OUT"
    exit 0
fi

# --- (b) doctor: 链路层体检 ----------------------------------------------------
# 每条检查 = 层级 + 检查项 + 证据。FAIL = 链路可证断裂；WARN = 降级但可能正常；
# PASS = 健康证据。
VERDICTS=()
add_verdict() { VERDICTS+=("$1|$2|$3"); }  # level|check|detail

# 1. 注册层（先跑——Fronti 共识"注册层断言排第一"；注册断了后面全无意义）
BROKEN_REG=0; TOTAL_GODOT=0; MISSING_REG=0
while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS='|' read -r cfg_name srv cmd verdict <<< "$line"
    if [[ "$verdict" == "missing" ]]; then
        MISSING_REG=$((MISSING_REG+1))
        add_verdict "WARN" "registration:${cfg_name}" "/tmp/multica-mcp-*/mcp-config.json 中未发现任何 godot-mcp server 条目（可能平台未注入或全部缺失——mcp_config 缺失形态，2026-08-01 事故同款）"
        continue
    fi
    TOTAL_GODOT=$((TOTAL_GODOT+1))
    if [[ "$verdict" == "broken" ]]; then
        add_verdict "FAIL" "registration:${cfg_name}/${srv}" "command 指向失效: ${cmd}（2026-08-01 事故形态：mcp_config 指向已删除路径 → server 拉起失败 → 工具不注册）"
        BROKEN_REG=$((BROKEN_REG+1))
    fi
done < <(node -e '
const o = JSON.parse(process.argv[1]);
for (const c of o.configs || []) {
    for (const g of c.godot_servers || []) {
        process.stdout.write([c.dir, g.name, g.command, g.verdict].join("|") + "\n");
    }
    if ((c.godot_servers || []).length === 0) {
        process.stdout.write([c.dir, "<no-godot-entry>", "", "missing"].join("|") + "\n");
    }
}
' "$REGISTRATION_JSON" 2>/dev/null)
if (( TOTAL_GODOT > 0 && BROKEN_REG == 0 )); then
    add_verdict "PASS" "registration" "${TOTAL_GODOT} 个 godot-mcp 注册条目 command 全部存在且可执行"
fi

# 2. 端口物理层
if [[ -n "$PORT" ]]; then
    if [[ "$PORT_BOUND" == "true" ]]; then
        add_verdict "PASS" "port:${PORT}" "端口有监听（来源 ${PORT_SOURCE}）"
    else
        add_verdict "WARN" "port:${PORT}" "端口无监听（来源 ${PORT_SOURCE}）。若 lease state=active 则属异常（真相源宣称活、物理无监听）：编辑器已死或绑定失败，等 reaper 回收后 cold-start"
    fi
else
    add_verdict "WARN" "port" "未能解析端口（无 KOL_MCP_PORT / registry 条目 / lease / legacy 表命中）。从 MCP server 环境外查询时属正常"
fi

# 3. Lease 层（真相源一致性）
LEASE_STATE="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.state||""))' "$LEASE_JSON" 2>/dev/null)"
if [[ -f "${LEASE_FILE:-}" ]]; then
    case "$LEASE_STATE" in
        active)
            if [[ "$PORT_BOUND" == "true" ]]; then
                add_verdict "PASS" "lease" "state=active 且端口实测有监听（真相源与物理一致）"
            else
                add_verdict "FAIL" "lease" "state=active 但端口无监听——真相源与物理不一致（编辑器已死或绑定失败；reaper 应在 grace 后回收）"
            fi
            ;;
        released)
            add_verdict "PASS" "lease" "state=released（已正常释放）"
            ;;
        *)
            add_verdict "WARN" "lease" "state=${LEASE_STATE:-<unreadable>}（sidecar 存在但状态未知；若 parse_error 见 status JSON 的 lease.parse_error）"
            ;;
    esac
else
    add_verdict "WARN" "lease" "sidecar 不存在（${LEASE_FILE:-<unresolved>}）：该 worktree 从未 configure，或已被 quarantine"
fi

# 4. Editor 进程层
ED_PID="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.editor_pid??""))' "$LIFECYCLE_JSON" 2>/dev/null)"
ED_ALIVE="$(node -e 'const o=JSON.parse(process.argv[1]);const v=o.editor_pid_alive;process.stdout.write(v===null?"unknown":v?"alive":"dead")' "$LIFECYCLE_JSON" 2>/dev/null)"
if [[ -z "$ED_PID" ]]; then
    add_verdict "WARN" "editor_pid" "无生命周期 pidfile（未启动或已清理）"
elif [[ "$ED_PID" == "pending" ]]; then
    add_verdict "WARN" "editor_pid" "pending（schtasks 启动中，CIM 尚未解析出真实 Windows PID）"
elif [[ "$ED_ALIVE" == "alive" ]]; then
    add_verdict "PASS" "editor_pid:${ED_PID}" "进程存活"
else
    add_verdict "WARN" "editor_pid:${ED_PID}" "pidfile 存在但进程已死（残留 pidfile，等 reaper 清理）"
fi

# 5. Warmup 相位层（log 尾部证据）
HIGHEST_STAGE="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.highest_stage||""))' "$WARMUP_JSON" 2>/dev/null)"
LEASE_EXIT_SEEN="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(o.lease_exit_line_seen?"1":"0")' "$WARMUP_JSON" 2>/dev/null)"
if [[ -n "$HIGHEST_STAGE" ]]; then
    if [[ "$LEASE_EXIT_SEEN" == "1" ]]; then
        add_verdict "WARN" "warmup:${HIGHEST_STAGE}" "日志含 lease 自退出行（grace 窗口无 client → editor 已退出释放端口）——正常生命周期，重试即 cold-start"
    else
        add_verdict "PASS" "warmup:${HIGHEST_STAGE}" "最高观测阶段（ts=$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.highest_stage_ts||""))' "$WARMUP_JSON" 2>/dev/null)）"
    fi
else
    add_verdict "WARN" "warmup" "日志尾未观测到任何 stage 行（editor 从未启动或日志已轮转）"
fi

# 6. Give-up / 重武装层（SEE-1240 WS-5：proxy in-band 恢复状态可查询）
GIVEUP_COUNT="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.giveup_count??0))' "$GIVEUP_JSON" 2>/dev/null)"
GIVEUP_COOLING="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(o.cooling?"1":"0")' "$GIVEUP_JSON" 2>/dev/null)"
GIVEUP_PRESENT="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(o.present?"1":"0")' "$GIVEUP_JSON" 2>/dev/null)"
if [[ "$GIVEUP_PRESENT" == "0" ]]; then
    add_verdict "PASS" "giveup" "无 give-up 记录（该 runtime 未发生 spawn 连续失败终态）"
elif [[ "$GIVEUP_COOLING" == "1" ]]; then
    GUP_UNTIL="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.cooldown_until||""))' "$GIVEUP_JSON" 2>/dev/null)"
    add_verdict "WARN" "giveup:${GIVEUP_COUNT}" "give-up 后冷却中（until ${GUP_UNTIL}）——proxy in-band 恢复已武装，冷却后下次 tools/call 自动重试，无需重启 MCP server"
else
    add_verdict "WARN" "giveup:${GIVEUP_COUNT}" "曾发生 give-up（count=${GIVEUP_COUNT}，reason: $(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(o.last_reason||"").slice(0,80))' "$GIVEUP_JSON" 2>/dev/null)）——当前不在冷却期，proxy 已重武装"
fi

# --- 输出 doctor ---------------------------------------------------------------
if (( JSON_OUT )); then
    node -e '
const verdicts = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map(l => {
    const [level, check, detail] = l.split("|");
    return { level, check, detail };
});
const reg = JSON.parse(process.argv[1]);
const timeo = JSON.parse(process.argv[2]);
const fail = verdicts.filter(v => v.level === "FAIL").length;
const warn = verdicts.filter(v => v.level === "WARN").length;
process.stdout.write(JSON.stringify({
    schema: "see1240-ws4-doctor/1",
    verdict: fail ? "FAIL" : (warn ? "WARN" : "PASS"),
    fail_count: fail, warn_count: warn, pass_count: verdicts.length - fail - warn,
    checks: verdicts,
    registration_detail: reg,
    timeouts: timeo,
}, null, 2));
' "$REGISTRATION_JSON" "$TIMEOUTS_JSON" <<< "$(printf '%s\n' "${VERDICTS[@]}")"
else
    echo "== godot-mcp doctor (${RUNTIME_ID:-<unknown-runtime>} port=${PORT:-?}) =="
    RC=0
    for v in "${VERDICTS[@]}"; do
        IFS='|' read -r level check detail <<< "$v"
        case "$level" in
            PASS) printf '  [PASS] %-34s %s\n' "$check" "$detail" ;;
            WARN) printf '  [WARN] %-34s %s\n' "$check" "$detail"; [[ "$RC" == "0" ]] && RC=2 ;;
            FAIL) printf '  [FAIL] %-34s %s\n' "$check" "$detail"; RC=1 ;;
        esac
    done
    echo "== timeouts (D4 生效超时全表) =="
    node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const l of t.layers){console.log(`  [${l.layer}] ${l.name} = ${l.value_ms!==null&&l.value_ms!==undefined?l.value_ms+"ms":(l.attempts?l.attempts+" attempts":"-")}  (${l.source}${l.injected===false?", 未注入(默认值)":l.injected===true?", 已注入":""})`)}' <<< "$TIMEOUTS_JSON"
    case "$RC" in
        0) echo "doctor verdict: PASS (all checks green)" ;;
        2) echo "doctor verdict: WARN (degraded but no provable break)" ;;
        1) echo "doctor verdict: FAIL (broken link detected)" ;;
    esac
    exit "$RC"
fi

# JSON doctor exit mirrors the text contract (0=PASS, 2=WARN, 1=FAIL):
node -e '
const verdicts = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map(l => l.split("|")[0]);
const fail = verdicts.filter(v => v === "FAIL").length;
const warn = verdicts.filter(v => v === "WARN").length;
process.exit(fail ? 1 : warn ? 2 : 0);
' <<< "$(printf '%s\n' "${VERDICTS[@]}")"
