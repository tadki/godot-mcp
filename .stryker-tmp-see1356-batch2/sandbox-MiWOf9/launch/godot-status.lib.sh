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
# SEE-1356 L2 (§SPEC-L2-02): 每条 entry 并列输出 workdir_hash + hash_source
# （经 kol_workdir_hash SSOT，禁止此处自算）与 is_current_workdir 三态
# （true=本进程 cwd 归一后命中 / false=不命中 / null=entry 无 worktree 可比）。
# freshness 仍为纯展示派生——不触发任何 reaper/清理联动（WS-4 约束）。
status_registry_json() {
    local reg="${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}/godot-port-registry.json}"
    local ann='{}' rid wt cw cwd_real wt_real
    cwd_real="$(realpath -m -- "$PWD" 2>/dev/null || printf '%s' "$PWD")"
    while IFS=$'\t' read -r rid wt; do
        [[ -n "$rid" ]] || continue
        local h="" src=""
        # Helper prints "<hash> <source>" ($()-safe provenance).
        read -r h src <<< "$(kol_workdir_hash "$wt" 2>/dev/null || true)"
        if [[ -z "$wt" ]]; then
            cw='null'
        else
            wt_real="$(realpath -m -- "$wt" 2>/dev/null || printf '%s' "$wt")"
            if [[ "$wt_real" == "$cwd_real" ]]; then cw=true; else cw=false; fi
        fi
        ann="$(ANN_ACC="$ann" ANN_RID="$rid" ANN_H="$h" ANN_SRC="$src" ANN_CW="$cw" node -e '
const ann = JSON.parse(process.env.ANN_ACC || "{}");
ann[process.env.ANN_RID] = {
    workdir_hash: process.env.ANN_H || null,
    hash_source: process.env.ANN_SRC || null,
    is_current_workdir: process.env.ANN_CW === "null" ? null : process.env.ANN_CW === "true",
};
process.stdout.write(JSON.stringify(ann));
' 2>/dev/null)"
    done < <(REG_PATH="$reg" node -e '
const fs = require("fs");
try {
    const o = JSON.parse(fs.readFileSync(process.env.REG_PATH, "utf8"));
    for (const [rid, e] of Object.entries(o.entries || {})) {
        if (!e || typeof e !== "object") continue;
        process.stdout.write(rid + "\t" + String(e.worktree ?? "") + "\n");
    }
} catch { /* absent/unparseable — no annotations */ }
' 2>/dev/null)
    REG_PATH="$reg" REG_ANN="$ann" node -e '
const fs = require("fs");
const p = process.env.REG_PATH;
const ann = JSON.parse(process.env.REG_ANN || "{}");
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
        const a = ann[rid] || {};
        out.entries[rid] = {
            port: e.port ?? null,
            agent: e.agent ?? "",
            worktree: e.worktree ?? "",
            proxy_pid: e.proxy_pid ?? null,
            heartbeat_at: e.heartbeat_at ?? null,
            heartbeat_age_s: ageMs === null ? null : Math.round(ageMs / 1000),
            heartbeat: ageMs === null ? "never" : (ageMs < 60000 ? "alive" : "stale"),
            workdir_hash: a.workdir_hash ?? null,
            hash_source: a.hash_source ?? null,
            is_current_workdir: a.is_current_workdir === undefined ? null : a.is_current_workdir,
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
const home = process.env.GODOT_MCP_HOME || (process.env.HOME ? (process.env.HOME + "/.config/godot-mcp") : "");
const lid = process.env.LID || "";
const lbl = process.env.LBL || "";
const out = { source: "lifecycle_files", dir_form: null, legacy_flat: null, editor_pid: null, editor_pid_alive: null };
const candidates = [];
if (lid) candidates.push(["dir_form", `${home}/godot-editor/${lid}.pid`]);
if (lbl) candidates.push(["legacy_flat", `${home}/godot-editor-${lbl}.pid`]);
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
    // SEE-1348 WP4 (§SPEC-008) 判活链路核验结论 + 修复：历史上这里用裸
    // process.kill(pid,0) 判定 pidfile 里的 PID——但该 PID 可能是 Windows
    // editor pid（schtasks/interop CIM 解析路径写入），WSL 侧 kill(0) 对
    // 活着的 Windows 进程恒报 ESRCH，"活" 被误判为 "死"。修复 = 按来源
    // 分流：powershell.exe 可用时走 Get-Process 计数探针（reaper pid_alive
    // 同款），否则回退 kill(0)（仅对确知的 WSL pid 可靠）。
    const n = Number(pid);
    let alive = null;
    try {
        if (process.platform === "win32") {
            alive = true; // native Windows caller: kill(0) is authoritative
            try { process.kill(n, 0); } catch (e) { alive = e.code === "EPERM"; }
        } else if (fs.existsSync("/proc/" + n)) {
            // /proc hit = a WSL-side pid (interop wrapper) — kill(0) is the
            // authoritative probe for those. Checked FIRST: the Windows probe
            // below can never see a WSL pid and would misreport it dead.
            try { process.kill(n, 0); alive = true; }
            catch (e) { alive = e.code === "EPERM"; }
        } else {
            const { execFileSync } = require("child_process");
            // powershell.exe may be missing from PATH in minimal WSL shells —
            // fall through to the well-known System32 location (same two-step
            // resolution the launcher uses).
            let psh = null;
            for (const cand of ["powershell.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"]) {
                try { execFileSync(cand, ["-NoProfile", "-Command", "exit 0"], { timeout: 10000, stdio: "ignore" }); psh = cand; break; } catch (e) { /* next */ }
            }
            if (!psh) {
                alive = null; // probe unavailable — degrade, do not misjudge
            } else try {
                const res = execFileSync(
                    psh,
                    ["-NoProfile", "-Command",
                     "$p = Get-Process -Id " + n + " -ErrorAction SilentlyContinue; " +
                     "if ($p) { Write-Output (\"1 \" + $p.ProcessName) } else { Write-Output \"0\" }"],
                    { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }
                ).trim().split(/\r?\n/)[0] || "";
                const parts = res.split(" ");
                if (parts[0] === "1") {
                    const name = parts.slice(1).join(" ").trim();
                    // Name check guards PID reuse; unreadable name trusts count.
                    alive = !name || /^godot/i.test(name);
                } else if (parts[0] === "0") {
                    alive = false;
                } else {
                    alive = null; // powershell failed entirely — unknown
                }
            } catch (e) {
                alive = null; // no powershell / timeout — degrade, do not misjudge
            }
        }
    } catch (e) { alive = null; }
    out.editor_pid_alive = alive;
    if (alive === null) out.editor_pid_alive_degraded = "probe-unavailable";
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
const home = process.env.GODOT_MCP_HOME || (process.env.HOME ? (process.env.HOME + "/.config/godot-mcp") : "");
const lid = process.env.LID || "";
const lbl = process.env.LBL || "";
const out = { source: "giveup_status", present: false, giveup_count: 0 };
const candidates = [];
if (lid && /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/.test(lid)) candidates.push(`${home}/godot-editor/${lid}.giveup.json`);
if (lbl) candidates.push(`${home}/godot-editor-${lbl}.giveup.json`);
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
const home = process.env.GODOT_MCP_HOME || (process.env.HOME ? (process.env.HOME + "/.config/godot-mcp") : "");
const rid = process.env.RID || "";
const lbl = process.env.LBL || "";
const STAGES = ["LAUNCHER_EXEC","EDITOR_SPAWNED","PLUGIN_INIT","SERVER_LISTENING","TCP_CONNECTED","WS_HANDSHAKE","MCP_INITIALIZED","WARM"];
const out = { source: "log_tails", editor_log: null, highest_stage: null, highest_stage_ts: null, lease_exit_line_seen: false };
const editorLogs = [];
if (rid) editorLogs.push(`${home}/godot-editor/${rid}.log`);
if (lbl) editorLogs.push(`${home}/godot-editor-${lbl}.log`);
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
# 逐条判定 command 可解析性。SEE-1356 L6 (§SPEC-L6-03): 判定改由 launch 域共享
# resolve helper（resolve-command.lib.sh mcp_resolve_command）单点执行——
# 绝对/相对直判、bare 名逐 PATH 解析、退役路径 stale 降级、ENOENT/EACCES 分级；
# verdict 集合 ok|stale|broken|degraded（degraded = 探测不可证 → doctor WARN）。
status_registration_json() {
    local resolved_tsv="" dir name cmd
    while IFS=$'\t' read -r dir name cmd; do
        [[ -n "$dir" ]] || continue
        mcp_resolve_command "$cmd"
        resolved_tsv+="${dir}"$'\t'"${name}"$'\t'"${cmd}"$'\t'"${RCV_VERDICT}"$'\t'"${RCV_PATH}"$'\t'"${RCV_REASON}"$'\n'
    done < <(node -e '
const fs = require("fs");
const path = require("path");
let dirs = [];
try { dirs = fs.readdirSync("/tmp").filter(d => d.startsWith("multica-mcp-")).sort(); } catch { /* no /tmp scan root */ }
for (const d of dirs) {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join("/tmp", d, "mcp-config.json"), "utf8"));
        for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
            if (!/godot/i.test(name)) continue;
            process.stdout.write([d, name, (s && s.command) || ""].join("\t") + "\n");
        }
    } catch { /* absent/unparseable handled in final assembly */ }
}
' 2>/dev/null)
    REG_RESOLVED="$resolved_tsv" node -e '
const fs = require("fs");
const path = require("path");
const out = { source: "mcp_config_registration", root: "/tmp", configs: [] };
const resolution = {};
for (const line of (process.env.REG_RESOLVED || "").split("\n")) {
    if (!line) continue;
    const [dir, name, cmd, verdict, rpath, reason] = line.split("\t");
    resolution[dir + " " + name] = { verdict, resolved_path: rpath || null, reason };
}
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
            // SEE-1356 L6: the shared helper owns the verdict. An empty
            // command can never resolve — pin it broken at the assembly.
            const r = resolution[d + " " + name]
                || { verdict: "broken", resolved_path: null, reason: cmd ? "unresolved" : "empty_command" };
            entry.godot_servers.push({
                name, command: cmd, args,
                resolved_path: r.resolved_path,
                verdict: r.verdict,
                reason: r.reason,
            });
        }
    } catch (e) {
        entry.error = e.code === "ENOENT" ? "mcp-config.json_absent" : ("unparseable: " + String(e.message || e));
    }
    out.configs.push(entry);
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- proxy_state 段: L5 快照只读镜像（SEE-1356 §SPEC-L5-02）-------------------
# 读取 <rid>.proxy-state.json（双形态命名，镜像 giveup 解析规则），附派生
# stale 判定：heartbeat_at 距今 > 90s → stale:true（纯派生，不推断死因，
# 不触发任何联动）。缺失 = 该 runtime 的 proxy 尚未持久化过快照（正常）。
status_proxy_state_json() {
    local runtime_id="$1" label="$2"
    LID="$runtime_id" LBL="$label" node -e '
const fs = require("fs");
const home = process.env.GODOT_MCP_HOME || (process.env.HOME ? (process.env.HOME + "/.config/godot-mcp") : "");
const lid = process.env.LID || "";
const lbl = process.env.LBL || "";
const out = { source: "proxy_state", present: false, path: null };
const candidates = [];
if (lid && /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/.test(lid)) candidates.push(`${home}/godot-editor/${lid}.proxy-state.json`);
if (lbl) candidates.push(`${home}/godot-editor/godot-editor-${lbl}.proxy-state.json`);
for (const p of candidates) {
    try {
        const o = JSON.parse(fs.readFileSync(p, "utf8"));
        Object.assign(out, o);
        out.path = p;
        out.present = true;
        const hb = o.heartbeat_at ? Date.parse(o.heartbeat_at) : NaN;
        out.heartbeat_age_s = Number.isFinite(hb) ? Math.round((Date.now() - hb) / 1000) : null;
        // 90s stale threshold (§SPEC-L5-02): purely derived, display-only.
        out.stale = !(Number.isFinite(hb) && (Date.now() - hb) <= 90000);
        out.mtime = fs.statSync(p).mtime.toISOString();
        break;
    } catch (e) {
        if (e.code !== "ENOENT") { out.parse_error = String(e.message || e); out.path = p; }
    }
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}

# --- proxylog 段: proxy stderr 落盘文件的 64KB tail 扫描（SEE-1356 §SPEC-L6-02）-
# 复用 status_warmup_json 形态。json_rpc_contaminated 恒应为 false：tee 只写
# 日志行，stdout（JSON-RPC 通道）永不入文件——该字段是契约自证哨兵。
status_proxylog_json() {
    local runtime_id="$1" label="$2"
    RID="$runtime_id" LBL="$label" node -e '
const fs = require("fs");
const home = process.env.GODOT_MCP_HOME || (process.env.HOME ? (process.env.HOME + "/.config/godot-mcp") : "");
const rid = process.env.RID || "";
const lbl = process.env.LBL || "";
const STAGES = ["LAUNCHER_EXEC","EDITOR_SPAWNED","PLUGIN_INIT","SERVER_LISTENING","TCP_CONNECTED","WS_HANDSHAKE","MCP_INITIALIZED","WARM"];
const out = { source: "proxy_log", path: null, present: false, tail_bytes_scanned: 0, highest_stage: null, highest_stage_ts: null, json_rpc_contaminated: false, last_lines: [] };
const candidates = [];
if (rid && /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/.test(rid)) candidates.push(`${home}/godot-editor/${rid}.proxy.log`);
if (lbl) candidates.push(`${home}/godot-editor/godot-editor-${lbl}.proxy.log`);
for (const p of candidates) {
    let tail = "";
    try {
        const fd = fs.openSync(p, "r");
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 65536);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        tail = buf.toString("utf8");
    } catch { continue; }
    out.path = p;
    out.present = true;
    out.tail_bytes_scanned = tail.length;
    const lines = tail.split("\n").filter(Boolean);
    out.last_lines = lines.slice(-5);
    for (const line of lines) {
        let m;
        if ((m = line.match(/\[stage=([A-Z_]+)\]/))) {
            const ord = STAGES.indexOf(m[1]);
            if (ord >= 0 && (out.highest_stage === null || ord > STAGES.indexOf(out.highest_stage))) {
                out.highest_stage = m[1];
                out.highest_stage_ts = (line.match(/\[ts=([^\]]+)\]/) || [])[1] || null;
            }
        }
        // JSON-RPC contamination sentinel: a request/response SHAPE at line
        // start in the tee would mean stdout leaked into the log — contract
        // breach. Plain-text log lines that merely mention words stay clean.
        if (/^\s*\{"(jsonrpc|id|result|error)"/.test(line)) out.json_rpc_contaminated = true;
    }
    break; // one file is authoritative (slot form first, then legacy)
}
process.stdout.write(JSON.stringify(out, null, 2));
' 2>/dev/null
}
