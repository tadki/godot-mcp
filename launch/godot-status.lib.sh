#!/usr/bin/env bash
# SEE-1240 WS-4 (C1+C2): godot-mcp 状态查询基底 + status/doctor 消费形态。
#
# 设计原则（WS-4 约束"不得引入第二真相源"）：
#   本工具是【只读聚合器】——只读取已经存在于磁盘上的状态数据，绝不写入、绝不推断：
#   · lease sidecar (.godot/mcp-lease.json, SEE-1117/1148 schema v2) = 端口真相源
#   · port registry (~/.multica/godot-port-registry.json, SEE-1148 P1) = proxy 心跳加速层
#   · lifecycle pidfile (kol_lifecycle_path) = editor PID 载体
#   · 端口实测 = 物理证据（探测优先级复用 arbiter 语义：PowerShell → /dev/tcp → ss）
#   · warmup 相位 = 从 editor log / launcher log 的 [stage=...] 行只读推导（SEE-1110/1152 协议）
#   · 注册层 = /tmp/multica-mcp-*/mcp-config.json（2026-08-01 事故形态检测点）
#
# 用法:
#   godot-status.sh status  [--json]   (a) status 查询 — agent 排障主入口（JSON 契约）
#   godot-status.sh doctor [--json]    (b) doctor 链路层体检（PASS/WARN/FAIL 判级）
#   godot-status.sh doctor --registry [--json]   (c) 注册层检查（mcp-config 比对）
#
# Exit codes: status 恒 0（查询永不因链路故障而失败——故障本身就是答案）。
#             doctor: 0=全 PASS, 1=有 FAIL, 2=仅 WARN（三态互斥，CI 友好）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "[godot-status] ERROR: node is required for JSON assembly; aborting." >&2; exit 1; }

# --- D4 生效超时全表 ----------------------------------------------------------
# Owner directive (SEE-1239 D4 分层定值, Bachi 四层表 + Revy 第三层补充): 任何
# agent 凭记忆报超时都是部落知识——必须可查询。数值镜像生产常量，每条注明出处
# （file:line 级锚点），未来改动可 grep 定位。
#   L1 Claude initialize — 平台注入 MCP_TIMEOUT（默认 120000；Atlas 8-31 建议采纳；
#     launcher fallback MCP_TIMEOUT_SEC=60 先于它存在，仅平台未注入时生效）
#   L2 proxy 生命周期族 — COLD_WARMUP 300s / HOT 30s / QUICK_TIMEOUT 90s(fork CLI
#     WS connect) / FAILED_EXIT 600s / SPAWN_MAX_ATTEMPTS 3 / RESTART_HOLD 120s /
#     TAKEOVER 30s / PORT_TAKEOVER 300s / RESPAWN_WINDOW 8s
#   L3 Claude tools/call — 平台注入 MCP_TOOL_TIMEOUT（默认 300000）
#   L4 addon 契约 — INITIAL_GRACE_SEC=300 / QUIT_DELAY_SEC=120
#     (lease_controller.gd, SEE-1070 契约常量不可放宽, C12)
status_timeouts_json() {
    local l1="${MCP_TIMEOUT:-120000}"
    local l3="${MCP_TOOL_TIMEOUT:-300000}"
    node -e '
const l1=Number(process.argv[1]), l3=Number(process.argv[2]);
const t = {
  schema: "see1240-ws4-d4-timeouts",
  note: "D4 生效超时全表 — 查询用，勿凭记忆报数",
  layers: [
    { layer: "L1", name: "claude_initialize", value_ms: l1,
      source: "platform env MCP_TIMEOUT", injected: !!process.env.MCP_TIMEOUT },
    { layer: "L2", name: "proxy_cold_warmup", value_ms: 300000,
      source: "godot-mcp-proxy.mjs COLD_WARMUP_TIMEOUT_MS (KOL_WARMUP_TIMEOUT_MS)" },
    { layer: "L2", name: "proxy_hot_warmup", value_ms: 30000,
      source: "godot-mcp-proxy.mjs HOT_WARMUP_TIMEOUT_MS" },
    { layer: "L2", name: "fork_cli_ws_connect", value_ms: 90000,
      source: "fork GODOT_MCP_QUICK_TIMEOUT_MS" },
    { layer: "L2", name: "proxy_failed_exit", value_ms: 600000,
      source: "godot-mcp-proxy.mjs FAILED_EXIT_MS (2x cold)" },
    { layer: "L2", name: "spawn_max_attempts", value_ms: null, attempts: 3,
      source: "godot-mcp-proxy.mjs SPAWN_MAX_ATTEMPTS" },
    { layer: "L2", name: "restart_hold", value_ms: 120000,
      source: "godot-mcp-proxy.mjs RESTART_HOLD_TIMEOUT_MS" },
    { layer: "L2", name: "editor_takeover", value_ms: 30000,
      source: "godot-mcp-proxy.mjs TAKEOVER_TIMEOUT_MS" },
    { layer: "L2", name: "port_takeover_hot", value_ms: 300000,
      source: "godot-mcp-proxy.mjs PORT_TAKEOVER_TIMEOUT_MS" },
    { layer: "L2", name: "port_respawn_window", value_ms: 8000,
      source: "godot-mcp-proxy.mjs PORT_RESPAWN_WINDOW_MS" },
    { layer: "L3", name: "claude_tool_call", value_ms: l3,
      source: "platform env MCP_TOOL_TIMEOUT", injected: !!process.env.MCP_TOOL_TIMEOUT },
    { layer: "L4", name: "addon_initial_grace", value_ms: 300000,
      source: "addons/godot_mcp/lease_controller.gd INITIAL_GRACE_SEC=300 (SEE-1070 契约)" },
    { layer: "L4", name: "addon_quit_delay", value_ms: 120000,
      source: "addons/godot_mcp/lease_controller.gd QUIT_DELAY_SEC=120 (SEE-1070 契约)" },
  ],
};
process.stdout.write(JSON.stringify(t, null, 2));
' "$l1" "$l3"
}

# --- lease: 读 per-worktree lease sidecar（端口真相源）-----------------------
# Args: <lease_path>. 输出 JSON；文件缺失 → {present:false}；存在但非法 JSON →
# {present:true, parse_error}（损坏本身是 status 相关信息——reaper 会 quarantine）。
status_lease_json() {
    local lease="$1"
    LEASE_PATH="$lease" node -e '
const fs = require("fs");
const p = process.env.LEASE_PATH;
const out = { source: "lease_sidecar", path: p };
try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    out.present = true;
    out.schema_version = o.schema_version ?? null;
    out.state = o.state ?? null;
    out.port = o.port ?? null;
    out.runtime_id = o.runtime_id ?? "";
    out.agent = o.agent ?? "";
    out.lease_id = o.lease_id ?? "";
    out.configured_at = o.configured_at ?? null;
    out.configured_by_pid = o.configured_by_pid ?? null;
    out.released_at = o.released_at ?? null;
    out.intentional_release = o.intentional_release === true;
} catch (e) {
    if (e.code === "ENOENT") { out.present = false; }
    else { out.present = true; out.parse_error = String(e.message || e); }
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- registry: proxy 心跳加速层 ----------------------------------------------
# 输出全部 entries + 派生每条活性判定（heartbeat 距今 vs 60s 阈值——阈值与
# kol-runtime/port-registry 语义一致，此处只读引用，阈值本体在 launcher 的
# worktree-holder 扫描逻辑里，同为 60s）。
status_registry_json() {
    local reg="${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${HOME}/.multica/godot-port-registry.json}"
    REG_PATH="$reg" node -e '
const fs = require("fs");
const p = process.env.REG_PATH;
const out = { source: "port_registry", path: p, entries: {} };
let raw = null;
try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {
    out.error = e.code === "ENOENT" ? "registry_absent" : ("registry_unparseable: " + String(e.message || e));
}
if (raw && raw.entries && typeof raw.entries === "object") {
    const now = Date.now();
    for (const [rid, e] of Object.entries(raw.entries)) {
        if (!e || typeof e !== "object") continue;
        const hb = e.heartbeat_at ? Date.parse(e.heartbeat_at) : NaN;
        const ageMs = Number.isFinite(hb) ? now - hb : null;
        out.entries[rid] = {
            port: e.port ?? null,
            agent: e.agent ?? "",
            worktree: e.worktree ?? "",
            proxy_pid: e.proxy_pid ?? null,
            heartbeat_at: e.heartbeat_at ?? null,
            heartbeat_age_s: ageMs === null ? null : Math.round(ageMs / 1000),
            heartbeat: ageMs === null ? "never" : (ageMs < 60000 ? "alive" : "stale"),
        };
    }
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- 单端口物理探测 -----------------------------------------------------------
# 复用 arbiter 探测语义（PowerShell → /dev/tcp → ss；不可判定视为 FREE——arbiter
# 的文档化安全默认）。这是只读探测（永不作为 grant gate），语义漂移风险低。
status_port_bound() {
    local p="$1"
    local ps=""
    if command -v powershell.exe >/dev/null 2>&1; then ps="powershell.exe"
    elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then ps="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    fi
    if [[ -n "$ps" ]]; then
        if "$ps" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
            return 0
        fi
        return 1
    fi
    if (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then
        exec 3>&- 3<&- 2>/dev/null || true
        return 0
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -H -tln 2>/dev/null | grep -qE ":${p}\b" && return 0
    fi
    return 1
}

# --- lifecycle: editor PID 文件（目录形态优先 + legacy flat 回退）-------------
# 路径解析镜像 kol_lifecycle_path；只读，不写。
status_lifecycle_json() {
    local runtime_id="$1" label="$2"
    LID="$runtime_id" LBL="$label" node -e '
const fs = require("fs");
const home = process.env.HOME || "";
const lid = process.env.LID || "";
const lbl = process.env.LBL || "";
const out = { source: "lifecycle_files", dir_form: null, legacy_flat: null, editor_pid: null, editor_pid_alive: null };
const candidates = [];
if (lid) candidates.push(["dir_form", `${home}/.multica/godot-editor/${lid}.pid`]);
if (lbl) candidates.push(["legacy_flat", `${home}/.multica/godot-editor-${lbl}.pid`]);
let pid = null, form = null;
for (const [name, p] of candidates) {
    try {
        const v = fs.readFileSync(p, "utf8").trim();
        if (v) { pid = v; form = name; out[`${name}_path`] = p; break; }
    } catch (e) { /* absent */ }
}
out.dir_form = form === "dir_form";
out.legacy_flat = form === "legacy_flat";
out.editor_pid = pid;
if (pid && /^\d+$/.test(pid)) {
    try { process.kill(Number(pid), 0); out.editor_pid_alive = true; }
    catch (e) { out.editor_pid_alive = e.code === "EPERM"; }
} else if (pid === "pending") {
    out.editor_pid_alive = null; // start-godot-editor 写 "pending" 直到 CIM 解析出真实 Windows PID
} else {
    out.editor_pid_alive = false;
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- give-up 计数器: proxy 重武装/退避状态（SEE-1240 WS-5）--------------------
# proxy 在每次 give-up / rearm 时写 <rid>.giveup.json（或 legacy flat 命名）。
# 这里只读镜像 kol_lifecycle_path 的双形态解析，附派生 cooling 状态（cooldown_until
# 是否还在未来）。缺失 = 该 runtime 从未 give-up（正常）。
status_giveup_json() {
    local runtime_id="$1" label="$2"
    LID="$runtime_id" LBL="$label" node -e '
const fs = require("fs");
const home = process.env.HOME || "";
const lid = process.env.LID || "";
const lbl = process.env.LBL || "";
const out = { source: "giveup_status", present: false, giveup_count: 0 };
const candidates = [];
if (lid && /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8}$/.test(lid)) candidates.push(`${home}/.multica/godot-editor/${lid}.giveup.json`);
if (lbl) candidates.push(`${home}/.multica/godot-editor-${lbl}.giveup.json`);
for (const p of candidates) {
    try {
        const o = JSON.parse(fs.readFileSync(p, "utf8"));
        Object.assign(out, o);
        out.path = p;
        out.present = true;
        if (o.cooldown_until) {
            out.cooling = Date.parse(o.cooldown_until) > Date.now();
        } else {
            out.cooling = false;
        }
        break;
    } catch (e) {
        if (e.code !== "ENOENT") { out.parse_error = String(e.message || e); out.path = p; }
    }
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- warmup 相位: 从 editor log / launcher log 尾部只读推导 -------------------
# proxy 的 stage 相位在内存里；持久证据是 editor log 的 [godot-mcp] 行 + 镜像到
# launcher log 的 [stage=...] 行。同时扫两个尾巴取最高观测阶段及时间戳——只读推导，
# 不发明新真相。editor log 路径解析镜像 kol_lifecycle_path：目录形态优先，legacy 回退。
status_warmup_json() {
    local runtime_id="$1" label="$2" launcher_log="$3"
    RID="$runtime_id" LBL="$label" LL="$launcher_log" node -e '
const fs = require("fs");
const home = process.env.HOME || "";
const rid = process.env.RID || "";
const lbl = process.env.LBL || "";
const STAGES = ["LAUNCHER_EXEC","EDITOR_SPAWNED","PLUGIN_INIT","SERVER_LISTENING","TCP_CONNECTED","WS_HANDSHAKE","MCP_INITIALIZED","WARM"];
const out = { source: "log_tails", editor_log: null, highest_stage: null, highest_stage_ts: null, lease_exit_line_seen: false };
const editorLogs = [];
if (rid) editorLogs.push(`${home}/.multica/godot-editor/${rid}.log`);
if (lbl) editorLogs.push(`${home}/.multica/godot-editor-${lbl}.log`);
const launcherLogs = process.env.LL ? [process.env.LL] : [];
let bestOrd = -1, bestTs = null, editorLogUsed = null;
const scan = (file, isEditor) => {
    let tail = "";
    try {
        const fd = fs.openSync(file, "r");
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 65536);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        tail = buf.toString("utf8");
    } catch (e) { return; }
    if (isEditor && editorLogUsed === null) editorLogUsed = file;
    for (const line of tail.split("\n").reverse()) {
        let m;
        if ((m = line.match(/\[stage=([A-Z_]+)\]/))) {
            const ord = STAGES.indexOf(m[1]);
            if (ord > bestOrd) { bestOrd = ord; bestTs = (line.match(/\[ts=([^\]]+)\]/) || [])[1] || null; }
        }
        if (/Lease: no MCP client for the grace window/.test(line)) out.lease_exit_line_seen = true;
    }
};
for (const f of editorLogs) scan(f, true);
for (const f of launcherLogs) scan(f, false);
out.editor_log = editorLogUsed;
if (bestOrd >= 0) { out.highest_stage = STAGES[bestOrd]; out.highest_stage_ts = bestTs; }
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- 注册层: mcp-config 层检查（2026-08-01 事故形态检测点）--------------------
# 读取每个 /tmp/multica-mcp-*/mcp-config.json，抽取 godot-mcp-* server 条目，
# 逐条判定：command 文件是否存在且可执行？——2026-08-01 事故形态 = "仓库移动了
# launcher，per-agent mcp_config 仍指向已删除路径" → server 拉起失败 → 工具不注册。
# 同时报告完整 server 列表，"mcp_config 缺失"（godot 条目整体缺失）也可见。
status_registration_json() {
    REG_ROOT="/tmp" node -e '
const fs = require("fs");
const path = require("path");
const out = { source: "mcp_config_registration", root: "/tmp", configs: [] };
let dirs = [];
try { dirs = fs.readdirSync("/tmp").filter(d => d.startsWith("multica-mcp-")).sort(); } catch (e) { out.error = String(e.message || e); }
for (const d of dirs) {
    const cfgPath = path.join("/tmp", d, "mcp-config.json");
    const entry = { dir: d, path: cfgPath, present: false, godot_servers: [], server_count: 0, all_servers: [] };
    try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        entry.present = true;
        const servers = cfg.mcpServers || {};
        entry.server_count = Object.keys(servers).length;
        entry.all_servers = Object.keys(servers).sort();
        for (const [name, s] of Object.entries(servers)) {
            if (!/godot/i.test(name)) continue;
            const cmd = (s && s.command) || "";
            const args = (s && s.args) || [];
            const g = { name, command: cmd, args, command_exists: null, command_executable: null };
            if (cmd) {
                // MCP stdio commands come in two shapes: an absolute/relative
                // PATH (resolve directly) or a bare name resolved via PATH at
                // spawn time ("bash", "npx"). accessSync on a bare name would
                // probe the process cwd and false-FAIL a perfectly valid
                // registration — resolve through PATH for that shape.
                const cmdPath = cmd.includes("/") ? cmd : null;
                let resolved = cmdPath;
                if (!resolved) {
                    for (const dir of (process.env.PATH || "").split(":")) {
                        if (!dir) continue;
                        try {
                            const p = dir + "/" + cmd;
                            fs.accessSync(p, fs.constants.X_OK);
                            resolved = p;
                            break;
                        } catch { /* next dir */ }
                    }
                }
                if (resolved) {
                    try { fs.accessSync(resolved, fs.constants.F_OK); g.command_exists = true; }
                    catch { g.command_exists = false; }
                    if (g.command_exists) {
                        try { fs.accessSync(resolved, fs.constants.X_OK); g.command_executable = true; }
                        catch { g.command_executable = false; }
                    }
                } else {
                    g.command_exists = false;
                    g.command_executable = false;
                }
            }
            // Verdict mirrors the SEE-1078 incident: missing/dangling command = broken registration.
            g.verdict = (g.command_exists && g.command_executable) ? "ok" : "broken";
            entry.godot_servers.push(g);
        }
    } catch (e) {
        entry.error = e.code === "ENOENT" ? "mcp-config.json_absent" : ("unparseable: " + String(e.message || e));
    }
    out.configs.push(entry);
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}
