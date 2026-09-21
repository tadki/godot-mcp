// proxy/worktree.mjs — worktree resolution + holder sidecars + helper
// script runner (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a):
// marker-anchor mandatory trust, SEE-1170 bare-repo prune, lease/worktree
// sidecar reads, detached bash helper execution, stderr persistence.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import {
    DIAGNOSTIC_STDERR_TAIL, EDITOR_LOG_FILE, GODOT_MCP_HOME, GODOT_PORT,
    POWERSHELL_BIN, STAGE_LOG_ENABLED, scriptDir,
} from './config.mjs';
import { log, stageLog } from './log.mjs';

// PS PID→cmdline 兜底（§SPEC-007，≤2s 超时由 runScript 竞速保证）：
// 只读探测，命中 = 该 PID 的命令行包含本 worktree 目录名。

async function probeHolderCmdline(pid, ourWorktree) {
    if (!POWERSHELL_BIN) return null;
    const dirName = (ourWorktree || '').split('/').filter(Boolean).pop();
    if (!dirName) return null;
    const result = await Promise.race([
        new Promise((resolve) => {
            execFile(POWERSHELL_BIN, ['-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
                env: { ...process.env }, timeout: 2000,
            }, (err, stdout) => resolve(err ? null : (typeof stdout === 'string' && stdout.includes(dirName))));
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    return result;
}

// Linux 侧 PID 存活判定（/proc 存在性即活进程；zombie 属罕见残余，恢复轮
// 保守视为活——错判活比误杀安全，§SPEC-006 健康度先行原则的 pid 侧体现）。
function pidAlive(pid) {
    try { return existsSync(`/proc/${pid}`); } catch { return false; }
}

// Lease sidecar 读取（恢复轮归因输入）。
async function readLeaseSidecar() {
    try {
        const pg = process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT
            || path.join(await resolveWorktreeForSpawn(), 'project.godot');
        const sidecar = pg.replace(/project\.godot$/, '.godot/mcp-lease.json');
        return JSON.parse(await readFile(sidecar, 'utf8'));
    } catch { return null; }
}

// Resolve the worktree the proxy should spawn the editor against. The launcher
// (godot-mcp-launcher.sh) runs the marker resolution layer (resolve_worktree_root
// → _resolve_via_runtime_registry, PR #496-#499) and exports its result as
// KOL_WORKTREE / KOL_PROJECT_GODOT. That env value IS the marker layer's output
// (路径 A). The proxy must treat it as the SOLE authoritative worktree source.
//
// SEE-1129 路径 B 统一 (sub-step b3c94ed8): the prior version of this resolver
// silently fell back to a cwd down-search / script-dir up-walk when KOL_WORKTREE
// was unset or its stat failed. That fallback was the dual worktree-resolution
// path (路径 B) that drifted off the marker result: on Archi's real machine the
// spawn target landed on a residual same-agent slot (c508560b) instead of this
// task's marker-resolved slot (7a634b21). The marker layer never agreed to
// that — the proxy just independently re-resolved and could land elsewhere.
//
// Fix: when the launcher handed us a marker-derived worktree, trust it as
// mandatory. If its path does not (yet) exist on disk (daemon lazy-provision
// race), surface worktree_unresolved loudly so the operator sees the gap —
// never silently substitute a different worktree found by walking the fs. The
// cwd/script-dir walk is now a LAST-RESORT used only when NO env anchor exists
// (direct/manual proxy run with no launcher in the parent chain).
// SEE-1170 通道 3: proxy-side stale-registration prune. When the mandatory
// anchor stat fails, the cause is often a bare-repo worktree registration whose
// target directory no longer exists (daemon Defect 2 residue) — `git worktree
// prune` on the bare repo clears exactly those. Bounded: at most ONE prune per
// proxy process (hasPrunedBareRepo) so a daemon retry storm cannot cascade prune
// calls; 5s timeout, non-fatal (any non-zero exit / timeout only logs).
// Observability goes into the warmupDiagnostic structured field (proxy stderr is
// occupied by MCP JSON-RPC under the B1 lazy-load architecture).
// Explicitly NOT a claim to prevent the Defect 1 first failure — this only
// shortens the residue window after a failure has already happened.

function deriveBareRepoFromAnchor(anchorPath) {
    // anchor = <...>/workdir/<repo>[/<nested>] — the .git file next to the repo
    // root points at <bare>/worktrees/<slot>. Walk up looking for a .git FILE
    // (worktree marker), read its gitdir, strip /worktrees/<name>.
    let dir = anchorPath;
    for (let i = 0; i < 5 && dir && dir !== path.dirname(dir); i++) {
        const gitFile = path.join(dir, '.git');
        try {
            const raw = readFileSync(gitFile, 'utf8').trim();
            const m = raw.match(/^gitdir:\s*(.+)$/);
            if (m) {
                const gitdir = m[1];
                // gitdir = <bare>/worktrees/<name>; we want <bare>.
                const wtIdx = gitdir.lastIndexOf('/worktrees/');
                if (wtIdx > 0) return gitdir.slice(0, wtIdx);
                if (gitdir.endsWith('.git')) return gitdir;
            }
        } catch { /* not here — keep walking */ }
        dir = path.dirname(dir);
    }
    return null;
}

async function tryPruneBareRepo(bareRepo) {
    if (!bareRepo) {
        S.lastBareRepoPruneDiag = { attempted: false, reason: 'bare_repo_unresolved' };
        stageLog('b0Prune', 'prune skipped: bare repo unresolved');
        return;
    }
    if (S.hasPrunedBareRepo) {
        S.lastBareRepoPruneDiag = { attempted: false, reason: 'already_pruned' };
        return;
    }
    S.hasPrunedBareRepo = true;
    const pruneStartedAt = Date.now();
    const outcome = await new Promise((resolve) => {
        const child = spawn('git', ['-C', bareRepo, 'worktree', 'prune'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            detached: false,
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve('timeout');
        }, 5000);
        child.on('error', () => { clearTimeout(timer); resolve('spawn_error'); });
        child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? 'ok' : `exit_${code}`); });
    });
    S.lastBareRepoPruneDiag = {
        attempted: true,
        bareRepo,
        outcome,
        durationMs: Date.now() - pruneStartedAt,
    };
    stageLog('b0Prune', `git worktree prune (${bareRepo}) -> ${outcome} in ${S.lastBareRepoPruneDiag.durationMs}ms`);
}

// SEE-1170 通道 3: on anchor stat failure, prune the bare repo once, then
// retry the stat before giving up. Returns { recovered, anchor }:
//   recovered=true  — stat succeeded after prune (对症: stale registration was
//                     the cause; keep this fact for the diagnostic)
//   recovered=false — still failing after prune (病因不明: explicitly recorded)
async function pruneThenRestat(anchorPath) {
    const bareRepo = deriveBareRepoFromAnchor(anchorPath);
    await tryPruneBareRepo(bareRepo);
    try {
        await stat(anchorPath);
        S.lastBareRepoPruneDiag = { ...S.lastBareRepoPruneDiag, statAfterPrune: 'recovered' };
        stageLog('b0Prune', `stat recovered after prune (${anchorPath})`);
        return { recovered: true, anchor: anchorPath };
    } catch (e) {
        S.lastBareRepoPruneDiag = {
            ...S.lastBareRepoPruneDiag,
            statAfterPrune: 'still_failing',
            statError: e.code || e.message,
        };
        stageLog('b0Prune', `stat still failing after prune (${anchorPath}: ${e.code || e.message}) — cause unclear`);
        return { recovered: false, anchor: null };
    }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function resolveWorktreeForSpawn() {
    // Marker anchor (KOL_PROJECT_GODOT wins — it also anchors the lease sidecar
    // path, so the two can never diverge). stat() must succeed; on failure we do
    // NOT fall through to fs discovery — that is exactly the 路径 B drift.
    if (process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT) {
        try { await stat(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT); return path.dirname(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT); }
        catch (e) {
            log(`resolveWorktreeForSpawn: marker anchor KOL_PROJECT_GODOT=${process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT} stat failed (${e.code || e.message}); attempting SEE-1170 bare-repo prune before giving up.`);
            const r = await pruneThenRestat(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT);
            if (r.recovered) return path.dirname(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT);
            log(`resolveWorktreeForSpawn: KOL_PROJECT_GODOT stat still failing after prune; refusing to drift to another worktree.`);
            return null;
        }
    }
    if (process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE) {
        try { await stat(process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE); return process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE; }
        catch (e) {
            log(`resolveWorktreeForSpawn: marker anchor KOL_WORKTREE=${process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE} stat failed (${e.code || e.message}); attempting SEE-1170 bare-repo prune before giving up.`);
            const r = await pruneThenRestat(process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE);
            if (r.recovered) return process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE;
            log(`resolveWorktreeForSpawn: KOL_WORKTREE stat still failing after prune; refusing to drift to another worktree.`);
            return null;
        }
    }

    // No env anchor at all (direct proxy run, no launcher parent). Only then is
    // fs discovery justified — and it still refuses the shared master checkout.
    const cwd = process.cwd();
    try {
        for (const entry of await readdir(cwd)) {
            if (entry.startsWith('.')) continue;
            const sub = path.join(cwd, entry);
            let st;
            try { st = await stat(sub); } catch { continue; }
            if (!st.isDirectory()) continue;
            if (await isGodotWorktree(sub)) return sub;
        }
    } catch { /* cwd unreadable — fall through */ }

    let dir = scriptDir();
    for (let i = 0; i < 16 && dir && dir !== path.dirname(dir); i++) {
        if (await isGodotWorktree(dir)) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

// True when `dir` is a Godot project root: has project.godot AND the
// godot-mcp launch toolchain (proving it is the agent's KingOfLikes-Godot
// checkout, not an unrelated Godot project).
//
// §4.5.3 T2 / K3 multi-location probe — accept every real layout the toolchain
// can run from, so worktree resolution never falls through onto the shared
// master:
//   (a) repo-root launch/   — standalone install / fork-as-addon at project root
//   (b) .dev/godot-mcp/launch — legacy KOL layout (transition window)
//   (c) addons/godot_mcp/launch — post-T4 KOL: addon+launch mounted as a
//       submodule under <project>/addons/godot_mcp
// Each is a separate marker; the probe is Monotone (any one suffices, none =
// not a godot-mcp worktree).
async function isGodotWorktree(dir) {
    try {
        await stat(path.join(dir, 'project.godot'));
        const inRepo = await stat(path.join(dir, 'launch')).catch(() => null);
        const legacy = await stat(path.join(dir, '.dev', 'godot-mcp', 'launch')).catch(() => null);
        const submod = await stat(path.join(dir, 'addons', 'godot_mcp', 'launch')).catch(() => null);
        return Boolean(inRepo || legacy || submod);
    } catch {
        return false;
    }
}

// SEE-1129 (instance selection layer): the worktree sidecar written by
// start-godot-editor.sh at spawn time. Ports are allocated per agent NAME
// (agent-ports.json), so a same-agent concurrent session slot resolves to the
// SAME port+LABEL. When this proxy's ensureEditor() finds the port busy it
// would otherwise adopt the holder's Godot instance — which has the HOLDER's
// project open — and serve the wrong worktree (godot_project get_info returns
// the holder's path, not this slot's). The sidecar records the exact worktree
// the holder editor opened, so the reuse path can detect a foreign holder.
// Returns the trimmed path string, or null when the sidecar is absent/empty
// (older holder, manual launch, or the editor self-exited and cleaned up).
function holderWorktreeSidecarPath() {
    // GODOT_EDITOR_LOG_FILE is `${dir}/godot-editor-<LABEL>.log`; the sidecar
    // mirrors that basename with a .worktree suffix. When the env is unset
    // (direct proxy run) there is no sidecar to consult — reuse proceeds.
    if (!EDITOR_LOG_FILE) return null;
    return EDITOR_LOG_FILE.replace(/\.log$/, '.worktree');
}

async function readHolderWorktree() {
    const sidecar = holderWorktreeSidecarPath();
    if (!sidecar) return null;
    try {
        const raw = await readFile(sidecar, 'utf8');
        const v = raw.trim();
        return v.length > 0 ? v : null;
    } catch {
        return null;
    }
}

// SEE-1129 principle #1/#2 (Owner's three principles): the reuse decision is
// AGENT-scoped, not worktree-scoped. Ports are allocated per agent NAME, so a
// holder on this proxy's GODOT_PORT is, by construction, the SAME agent — and
// same-agent MUST reuse (principle #1/#2), never error. Cross-agent contention
// (principle #5) only arises on a misconfigured/duplicate port mapping. The
// holder's agent name lives in ITS worktree's lease sidecar
// (<holderWorktree>/.godot/mcp-lease.json field "agent"). Resolve the holder
// worktree via the MULTICA_DIR .worktree sidecar, then read its lease. Returns
// null when unverifiable (no .worktree sidecar, holder worktree missing, lease
// absent/malformed) — the predicate treats null as "reuse" for back-compat.
async function readHolderAgent() {
    const holderWorktree = await readHolderWorktree();
    if (!holderWorktree) return null;
    try {
        const raw = await readFile(path.join(holderWorktree, '.godot', 'mcp-lease.json'), 'utf8');
        const lease = JSON.parse(raw);
        const a = typeof lease.agent === 'string' ? lease.agent.trim() : '';
        return a.length > 0 ? a : null;
    } catch {
        return null;
    }
}

// Build args for configure / start helpers: [agent-name?] --port <GODOT_PORT>
// <extra...>. Passing --port explicitly makes the port deterministic even when
// the launcher was driven by --port override rather than KOL_AGENT_NAME.
function buildHelperArgs(extra) {
    const args = [];
    const agentName = process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || '';
    if (agentName) args.push(agentName);
    args.push('--port', String(GODOT_PORT));
    args.push(...extra);
    return args;
}

// SEE-1292 respawn fix: read {state, port} from a worktree's lease sidecar
// (.godot/mcp-lease.json). Returns null when absent/unreadable — the caller
// treats that as "not active" and reactivates via configure.
async function readWorktreeLeaseState(worktree) {
    try {
        const raw = await readFile(path.join(worktree, '.godot', 'mcp-lease.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return { state: parsed.state, port: parsed.port };
    } catch {
        return null;
    }
}

// Run a bash helper script fully detached from the MCP stdio pipes. The proxy's
// stdin/stdout carry JSON-RPC; any stray byte from a child corrupts the
// handshake (SEE-1045). stdin/stdout are ignored; stderr is captured (tail
// kept) for spawn_failed diagnostics. env inherits KOL_AGENT_NAME / KOL_WORKTREE
// / KOL_PROJECT_GODOT / GODOT_PORT from the launcher. Returns
// { rc, stderrTail, stderrFull }. stderrTail is truncated to
// DIAGNOSTIC_STDERR_TAIL for the JSON payload; stderrFull is the complete
// stream (no truncation) and is what gets persisted to disk by
// persistSpawnStderr — the truncation exists only because the daemon does not
// store the tool_result payload, so a fat stderr there is wasted anyway.
function runScript(scriptPath, args) {
    return new Promise((resolve) => {
        let stderrTail = '';
        let captured = 0;
        const child = spawn('bash', [scriptPath, ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env },
        });
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                const s = typeof chunk === 'string' ? chunk : chunk.toString();
                stderrTail += s;
                captured += s.length;
                // SEE-1152: forward child-script stage lines (configure/start/prepare)
                // onto the proxy's own stderr so a single log captures the whole
                // cold-start timeline. Lines already carry their own [component]
                // prefix (e.g. [configure-mcp-port]) and [stage=...] tokens, so
                // we pass them through untouched rather than re-wrapping.
                if (STAGE_LOG_ENABLED && s.includes('[stage=')) {
                    for (const line of s.split('\n')) {
                        if (line.includes('[stage=')) process.stderr.write(line + '\n');
                    }
                }
            });
        }
        child.on('error', (err) => {
            const msg = `spawn error: ${err.message}`;
            resolve({ rc: -1, stderrTail: msg, stderrFull: msg });
        });
        child.on('close', (code) => {
            const tail = captured > DIAGNOSTIC_STDERR_TAIL
                ? stderrTail.slice(-DIAGNOSTIC_STDERR_TAIL)
                : stderrTail;
            resolve({ rc: code ?? -1, stderrTail: tail, stderrFull: stderrTail });
        });
    });
}

// SEE-1164 改进 1: persist the FULL (un-truncated) stderr of a failing helper
// to ~/.multica/godot-editor/<runtime_id>.stderr.log so post-mortem analysis
// can read the exact die message + stage lines (PORT_PROBE_BEGIN/END etc.) that
// the daemon's `tool_result observed` line never stores. Path mirrors
// kol_lifecycle_path (runtime.lib.sh §L68): non-solo runtime_ids resolve to
// the per-slot directory form; an empty KOL_RUNTIME_ID (manual invocation)
// falls back to `unknown.stderr.log` rather than writing into the shared flat
// name (per-slot isolation beats conflation). Best-effort: any fs error is
// logged to proxy stderr, never thrown — the SpawnError must still propagate
// to the agent.
async function persistSpawnStderr(source, rc, stderrFull) {
    if (!stderrFull) return;
    try {
        const dir = path.join(GODOT_MCP_HOME, 'godot-editor');
        await mkdir(dir, { recursive: true });
        const rid = process.env.GODOT_MCP_RUNTIME_ID || process.env.KOL_RUNTIME_ID || 'unknown';
        const file = path.join(dir, `${rid}.stderr.log`);
        const iso = new Date().toISOString();
        const block = `\n===== [${iso}] source=${source} rc=${rc} runtime_id=${rid} port=${GODOT_PORT} =====\n${stderrFull}\n`;
        await appendFile(file, block, 'utf8');
        log(`persisted helper stderr to ${file} (source=${source} rc=${rc}, ${stderrFull.length} chars)`);
    } catch (err) {
        console.error(`[godot-mcp-proxy] persistSpawnStderr failed (source=${source}): ${err && err.message}`);
    }
}

export {
    probeHolderCmdline,
    pidAlive,
    readLeaseSidecar,
    deriveBareRepoFromAnchor,
    tryPruneBareRepo,
    pruneThenRestat,
    resolveWorktreeForSpawn,
    isGodotWorktree,
    holderWorktreeSidecarPath,
    readHolderWorktree,
    readHolderAgent,
    buildHelperArgs,
    readWorktreeLeaseState,
    runScript,
    persistSpawnStderr,
};
