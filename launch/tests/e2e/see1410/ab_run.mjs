#!/usr/bin/env node
// SEE-1410 §SPEC-010 AB harness — fork lane cold-start deadlock (manual editor).
//
// Reproduction topology (closest to Revy's real-machine evidence):
//   1. A MANUAL editor (start-godot-editor.sh, no runtime record, no lease
//      sidecar) is started first on the slot's leased port.
//   2. A cold proxy is spawned against an isolated sandbox HOME; its fork
//      CLI child (startNpx at proxy boot) race-connects the editor WS and
//      occupies the addon's single slot.
//   3. tools/call → cold-start chain → gate / adopt / evict decisions run.
//
// Arms (§SPEC-010, same environment / same command):
//   ctrl : fork launch layer @ parent commit 04611b8 (isolated checkout)
//   fix  : fork launch layer @ this branch HEAD (the repair)
// Evidence per round: proxy stderr log, final proxy-state.json, harness
// trace, feeder warm verdict. Summary JSON to evidence/ab-summary.json.
// Run single round: node launch/tests/e2e/see1410/ab_run.mjs <arm> <round> <port> [--agent <label>]

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORK = path.resolve(HERE, '..', '..', '..', '..');    // launch/tests/e2e/see1410 → fork 根
const KOL_ROOT = path.resolve(FORK, '..', 'KingOfLikes-Godot');
const CTRL_ROOT = path.join(os.homedir(), 'see1410-ab-ctrl-worktree');
const EVIDENCE = path.join(HERE, 'evidence');
const WARMUP_MS = parseInt(process.env.AB_WARMUP_MS || '150000', 10);   // 冷启动窗口：本机编辑器 bind 实测 ~84s（Revy 复核），150s 留余量
const FAILED_EXIT_MS = parseInt(process.env.AB_FAILED_EXIT_MS || '120000', 10);
const R2_CAP_MS = parseInt(process.env.AB_R2_CAP_MS || '300000', 10);   // R2 硬顶：2×cold 语义按窗口比例放大（真实 2×300s）
const HARNESS_BUDGET_MS = parseInt(process.env.AB_BUDGET_MS || '780000', 10); // warmup(150s)+驱逐/收敛链+bind(~84s)+余量
const CTRL_COMMIT = '04611b8';

const [arm, roundStr, portStr] = process.argv.slice(2, 5);
if (!arm || !['ctrl', 'fix'].includes(arm) || isNaN(Number(portStr))) {
    console.error('usage: ab_run.mjs <ctrl|fix> <round> <port>');
    process.exit(2);
}
const round = Number(roundStr) || 1;
const PORT = portStr;
const AGENT = (arm === 'ctrl' ? 'ABC' : 'ABF') + round;
const armRoot = arm === 'ctrl' ? CTRL_ROOT : FORK;

const EV = { arm, round, trace: [], proxyExit: null, warmOk: null, finalState: null, ctrlRootReady: false };
const t0 = Date.now();
const sbHome = fs.mkdtempSync(path.join(os.tmpdir(), `ab-${arm}-${round}-`));
// 非 solo runtime id（lane form）：proxy 会写 slot-form proxy-state（§SPEC-010
// 交付物）；编辑器日志走 kol_lifecycle_path 的 directory form 同名 .log。
const KOL_RUNTIME = `${AGENT}-lane`;
const EDITOR_LOG = path.join(sbHome, '.multica', 'godot-editor', `${KOL_RUNTIME}.log`);
const trace = (m) => { EV.trace.push(`+${Date.now() - t0}ms ${m}`); };

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 60000, env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function shOk(cmd, args, opts = {}) {
    try { run(cmd, args, opts); return true; } catch { return false; }
}

function killWorktreeEditors() {
    // 先按端口杀（Windows 侧残留 editor 的进程 CommandLine 未必含 worktree
    // 目录名，stop 脚本走 Get-NetTCPConnection 归属更可靠），再按目录名兜底；
    // 终态以「端口 free」为准（Windows 侧 stop 是异步的，带上限 predicate 轮询）。
    for (let attempt = 0; attempt < 3; attempt++) {
        // 按 listen 端口找 Windows 侧 owner 并杀（不依赖 sidecar/lease 记录）。
        try {
            const ps = `$c=Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Output ('killed ' + $c.OwningProcess) } else { Write-Output 'none' }`;
            run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000 });
        } catch { /* none */ }
        try {
            run('bash', [path.join(armRoot, 'launch', 'stop-godot-editor.sh'), '--port', PORT], { timeout: 30000 });
        } catch { /* rc!=0：端口本就空闲 */ }
        try {
            const dirName = WT_ROOT.split('/').filter(Boolean).pop();
            const ps = `(Get-CimInstance Win32_Process -Filter "Name like 'Godot%'" | Where-Object { $_.CommandLine -like '*${dirName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; 'done')`;
            run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000 });
        } catch { /* none running */ }
        // 端口 free 判定：起一个临时 Windows 侧 listener 成功即 free（自带
        // 释放），失败说明仍被占——等待后重试。
        try {
            run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', `
$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, ${PORT});
$l.Start(); Write-Output 'probe-free'; $l.Stop();`], { timeout: 15000 });
            return; // listener 成功 = 端口 free
        } catch { /* 仍被占 */ }
        try { execFileSync('sleep', ['3']); } catch { /* sync sleep */ }
    }
    trace('WARNING: port still busy after 3 kill attempts');
}

let WT_ROOT = '';
const proxyEnv = {
    ...process.env,
    GODOT_MCP_HOME: path.join(sbHome, '.multica'),
    HOME: sbHome,
    GODOT_PORT: PORT,
    GODOT_HOST: '172.17.192.1',
    KOL_AGENT_NAME: AGENT,
    KOL_WORKTREE: '',
    KOL_PROJECT_GODOT: '',
    GODOT_MCP_WARMUP_TIMEOUT_MS: String(WARMUP_MS),
    GODOT_MCP_FAILED_EXIT_MS: String(FAILED_EXIT_MS),
    GODOT_MCP_RECOVERING_HARD_CAP_MS: String(R2_CAP_MS),
    GODOT_EDITOR_LOG_FILE: EDITOR_LOG,
    KOL_RUNTIME_ID: KOL_RUNTIME,
    // AB 判据需要观测 gate 全貌；环境注入 marker 与 SEE-1292 无关。
    GODOT_MCP_ENV_INJECTED: '1',
};

const fsWrap = {
    setWorktree(p) { WT_ROOT = p; proxyEnv.KOL_WORKTREE = p; proxyEnv.KOL_PROJECT_GODOT = path.join(p, 'project.godot'); },

    // 隔离 KOL worktree + submodule 对齐 arm。
    prepareWorktree() {
        const wtRoot = path.join(os.tmpdir(), `ab-wt-${arm}-${round}`);
        fsWrap.setWorktree(wtRoot);
        const ready = fs.existsSync(path.join(wtRoot, 'project.godot'));
        if (!ready) {
            try { run('git', ['-C', KOL_ROOT, 'worktree', 'remove', wtRoot, '--force'], { timeout: 60000 }); } catch { /* absent */ }
            run('git', ['-C', KOL_ROOT, 'worktree', 'add', wtRoot, 'HEAD'], { timeout: 120000 });
            run('git', ['-C', wtRoot, 'submodule', 'update', '--init', 'addons/godot_mcp'], { timeout: 180000 });
        }
        const sub = path.join(wtRoot, 'addons', 'godot_mcp');
        try { run('git', ['-C', sub, 'remote', 'add', 'origin', 'file://' + FORK], { timeout: 15000 }); } catch { /* exists */ }
        run('git', ['-C', sub, 'fetch', '--all'], { timeout: 120000 });
        const ref = arm === 'ctrl' ? CTRL_COMMIT : process.env.GODOT_MCP_FIX_REF || 'HEAD';
        if (arm === 'ctrl') {
            // ctrl arm 的 submodule 对齐 parent commit；fix arm 直接 fork HEAD。
            run('git', ['-C', sub, 'checkout', CTRL_COMMIT], { timeout: 60000 });
        } else if (!ready || !fs.existsSync(path.join(sub, 'launch', 'tests', 'e2e', 'see1410'))) {
            run('git', ['-C', sub, 'checkout', ref], { timeout: 60000 });
        }
        EV.ctrlRootReady = arm === 'ctrl' ? fs.existsSync(path.join(CTRL_ROOT, 'launch', 'godot-mcp-proxy.mjs')) : null;
    },

    async ensureCtrlRootWorktree() {
        // 对照组 arm 根：独立 checkout 04611b8（fork 仓库第二个 worktree），一次创建多轮复用。
        const ready = fs.existsSync(path.join(CTRL_ROOT, 'launch', 'godot-mcp-proxy.mjs'));
        const correct = shOk('git', ['--git-dir', path.join(CTRL_ROOT, '.git'), 'rev-parse', '--verify', `HEAD^0`], { cwd: CTRL_ROOT });
        const headSha = (() => {
            try { return run('git', ['-C', FORK, 'rev-parse', CTRL_COMMIT]).trim(); } catch { return ''; }
        })();
        let curSha = '';
        try { curSha = run('git', ['-C', CTRL_ROOT, 'rev-parse', 'HEAD']).trim(); } catch { /* absent */ }
        if (!ready || curSha !== headSha) {
            try { run('git', ['-C', FORK, 'worktree', 'remove', CTRL_ROOT, '--force'], { timeout: 60000 }); } catch { /* absent */ }
            run('git', ['-C', FORK, 'worktree', 'add', CTRL_ROOT, CTRL_COMMIT], { timeout: 120000 });
        }
        trace(`ctrl root ready (${CTRL_ROOT})`);
    },

    // rev2 §SPEC-010 复现场景：手工编辑器（无 runtime record、无 sidecar）。
    // CLI 将对它完成 WS 握手（占用事件先于任何里程碑到达）。
    async startManualEditor() {
        // 编辑器 addon 从 project.godot 读端口——先 configure 到本槽端口。
        run('bash', [path.join(armRoot, 'launch', 'configure-mcp-port.sh'), '--port', PORT, '--project-godot', path.join(WT_ROOT, 'project.godot')], { env: proxyEnv, timeout: 30000 });
        const started = spawn('bash', [path.join(armRoot, 'launch', 'start-godot-editor.sh'), '--port', PORT, '--worktree', WT_ROOT], {
            env: proxyEnv,
            cwd: armRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        started.stdout.on('data', (d) => { out += d.toString(); });
        started.stderr.on('data', (d) => { out += d.toString(); });
        // 事件驱动等真编辑器 bind（编辑器 agent log 的 Server listening 行）。
        const bound = await new Promise((resolve) => {
            const deadline = Date.now() + 180000;
            const iv = setInterval(() => {
                try {
                    logTail = fs.readFileSync(EDITOR_LOG, 'utf8');
                    if (/Server listening/.test(logTail.slice(-6000))) { clearInterval(iv); resolve(true); return; }
                } catch { /* not yet */ }
                if (Date.now() > deadline) { clearInterval(iv); resolve(false); }
            }, 2000);
        });
        if (!bound) trace(`WARNING: manual editor bind not observed within 180s (out: ${out.slice(-300)})`);
        else trace('manual editor bound');
        // Revy 现场形态补齐：sidecar 缺失（旧版 start 脚本/手工起动的编辑器
        // 没有留下归因文件）。port 绑定依赖 sidecar，故 bind 完成后移除——
        // proxy 视角即「port 上有一个无任何身份证据的编辑器」。sidecar 有两处：
        // wt/.godot/mcp-lease*（lease 本体）与 GODOT_MCP_HOME 侧 *.worktree
        // （kol_lifecycle_path 的归因文件，proxy 的 readHolderWorktree 读它）。
        try {
            fs.rmSync(path.join(WT_ROOT, '.godot', 'mcp-lease.json'), { force: true });
            fs.rmSync(path.join(WT_ROOT, '.godot', 'mcp-lease.json.lock'), { force: true });
            const home = proxyEnv.GODOT_MCP_HOME;
            for (const d of [home, path.join(home, 'godot-editor')]) {
                for (const f of fs.readdirSync(d)) {
                    if (f.endsWith('.worktree')) fs.rmSync(path.join(d, f), { force: true });
                }
            }
            trace('sidecar removed (manual no-identity form)');
        } catch { /* best-effort */ }
        return { started, bound, out };
    },

    // SEE-1410: 事后从 stderr 全文判定「墙钟路径驱逐/冷重启」是否发生
    //（R2 hard cap 的 forceColdRestart / 恢复轮 stop-first / evict 序列）。
    watchR2Evicted(stderrChunks) {
        const blob = Buffer.concat(stderrChunks).toString('utf8');
        return blob.includes('forcing cold restart (R2)') || blob.includes('EVICT_BEGIN');
    },

    readProxyState() {
        // proxy-state.mjs 双形态落点：slot form 与 legacy form（§命名随
        // persistGiveUpStatus 双形态规则）。sandbox HOME 两个目录都探。
        const label = process.env.KOL_RUNTIME_ID || proxyEnv.KOL_RUNTIME_ID;
        const dirs = [
            path.join(sbHome, '.multica', 'godot-editor'),
            path.join(sbHome, '.multica'),
            path.join(sbHome, '.config', 'godot-mcp', 'godot-editor'),
            path.join(sbHome, '.config', 'godot-mcp'),
        ];
        for (const dir of dirs) {
            for (const f of [`${label}.proxy-state.json`, `godot-editor-${AGENT}.proxy-state.json`]) {
                try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* next */ }
            }
        }
        return null;
    },
};

let logTail = '';
let manualProc = null;
let proxy = null;
let feeder = null;

try {
    EV.proxyEnvLabel = AGENT;
    trace(`arm=${arm} round=${round} port=${PORT}`);
    // 1. worktree + submodule 对齐 arm（vendored addon 侧 = 编辑器插件）。
    fsWrap.prepareWorktree();
    if (arm === 'ctrl') await fsWrap.ensureCtrlRootWorktree();
    fs.mkdirSync(path.dirname(EDITOR_LOG), { recursive: true });

    // 2. phase 1：手工编辑器（Revy 现场形态：无 runtime record、无 sidecar、
    //    写 agent log 而非 runtime log → proxy 的里程碑通道天然不可得，而
    //    CLI 握手事件真实发生——rev2「事件优先于墙钟推测」的验收形态）。
    const manual = await fsWrap.startManualEditor();
    manualProc = manual.started;
    EV.manualBound = manual.bound;
    if (!manual.bound) throw new Error('manual editor failed to bind — harness environment broken');

    // 3. 冷 proxy + feeder（s5 骨架）。
    trace('cold proxy spawning');
    proxy = spawn('node', [path.join(armRoot, 'launch', 'godot-mcp-proxy.mjs')], { cwd: armRoot, env: proxyEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const errChunks = [];
    const proxyOut = [];
    proxy.stderr.on('data', (d) => { errChunks.push(d); });
    // MCP 响应走 proxy stdout（MCP stdio 协议：response 在 stdout，诊断在 stderr）。
    proxy.stdout.on('data', (d) => { proxyOut.push(d.toString()); });
    feeder = spawn(process.execPath, ['-e', `
        const p = process;
        // MCP stdio：initialize 握手 → initialized 通知 → 周期 tools/call。
        // 注意写自己的 STDOUT（feeder 的 stdout 已 pipe 到 proxy.stdin）——
        // 写 stdin（s5 模板的 bug）等于对着无人读取的管道自言自语。
        const out = (o) => { try { p.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
        out({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
        setTimeout(() => out({ jsonrpc: '2.0', method: 'notifications/initialized' }), 300);
        let id = 2;
        const send = () => out({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } });
        setTimeout(send, 800);
        const iv = setInterval(send, 4000);
        setTimeout(() => { clearInterval(iv); process.exit(0); }, ${HARNESS_BUDGET_MS - 20000});
    `], { env: proxyEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    feeder.stdout.pipe(proxy.stdin);

    // 4. AB 主判据观测：对照组（04611b8）应出现「事件已发生仍被墙钟路径
    //    驱逐」（R2 hard cap / EVICT 杀掉 CLI 正握着活会话的手工编辑器），
    //    实验组应零驱逐直接收敛。r2Evicted 由轮末从 stderr 全文判定。

    // 4. 观测窗口：proxy 退出 / budget / warm 响应（提前收敛无谓等待）。
    const warmPromise = new Promise((resolve) => {
        const deadline = Date.now() + HARNESS_BUDGET_MS;
        const iv = setInterval(() => {
            // id=2 的 tools/call 收到非 retryable 结果即 warm（proxy 每 4s 重试，
            // 冷启动收敛时第一个 get_info result 就是 WARM 敲钉）。
            for (const line of proxyOut.join('').split('\n')) {
                if (!line.includes('"id":2')) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.error && msg.error.data && msg.error.data.retryable) continue;
                clearInterval(iv);
                EV.warmOk = !msg.error;
                EV.warmResponse = msg;
                resolve(!msg.error);
                return;
            }
        }, 2000);
    });
    const exitPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('budget'), HARNESS_BUDGET_MS);
        proxy.on('exit', (c) => { clearTimeout(timer); EV.proxyExit = c; resolve(`exit(${c})`); });
    });
    const stopper = await Promise.race([warmPromise.then(() => (EV.warmOk ? 'warm' : 'warm-fail')), exitPromise]);
    trace(`stop=${stopper} warmOk=${EV.warmOk}`);

    await new Promise((r) => { setTimeout(r, 4000); r(); });
    EV.finalState = fsWrap.readProxyState()?.state || 'unknown';
    EV.stderr = Buffer.concat(errChunks).toString('utf8');
    // AB 主判据：本代是否发生「墙钟路径驱逐/冷重启」（对活编辑器的误杀链）。
    EV.r2Evicted = fsWrap.watchR2Evicted(errChunks);
    EV.stderrTail = EV.stderr.slice(-4000);
    EV.proxyOut = proxyOut.join('').slice(-2000);
    try { feeder.kill('SIGKILL'); } catch { /* gone */ }
    try { proxy.kill('SIGKILL'); } catch { /* gone */ }
} catch (e) {
    EV.harnessError = String(e && e.message ? e.message : e);
} finally {
    try { execFileSync('bash', ['-c', 'true']); } catch { /* noop */ }
    if (proxy) { try { proxy.kill('SIGKILL'); } catch { /* gone */ } }
    if (feeder) { try { feeder.kill('SIGKILL'); } catch { /* gone */ } }
    if (manualProc) { try { manualProc.kill('SIGKILL'); } catch { /* gone */ } }
    killWorktreeEditors();
    try { run('git', ['-C', KOL_ROOT, 'worktree', 'remove', WT_ROOT, '--force'], { timeout: 60000 }); } catch { /* best-effort */ }
    try { fs.rmSync(sbHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// 5. 落证与总结。
try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const dir = path.join(EVIDENCE, `${arm}-${round}`);
    fs.mkdirSync(dir, { recursive: true });
    if (EV.stderr) fs.writeFileSync(path.join(dir, 'proxy-stderr.log'), EV.stderr);
    if (EV.proxyOut) fs.writeFileSync(path.join(dir, 'proxy-response.log'), EV.proxyOut);
    // proxy-state：runtime_id 由 proxy 派生（workdir-hash/slot 规则），按内容
    // 找 sandbox HOME 下的实际 state 文件整份拷贝（§SPEC-010 交付物）。
    const home = proxyEnv.GODOT_MCP_HOME;
    const findState = (root) => {
        const hits = [];
        const walk = (d) => {
            for (const f of fs.readdirSync(d)) {
                const p = path.join(d, f);
                const s = fs.statSync(p);
                if (s.isDirectory()) walk(p);
                else if (f.includes('proxy-state')) hits.push(p);
            }
        };
        try { walk(root); } catch { /* absent */ }
        return hits;
    };
    const hits = findState(home);
    if (hits.length > 0) {
        fs.copyFileSync(hits[0], path.join(dir, 'proxy-state.json'));
        if (!EV.finalState || EV.finalState === 'unknown') {
            EV.finalState = JSON.parse(fs.readFileSync(hits[0], 'utf8')).state || 'unknown';
        }
    }
    const st = fsWrap.readProxyState();
    if (st && !hits.length) fs.writeFileSync(path.join(dir, 'proxy-state.json'), JSON.stringify(st, null, 1));
    trace(`final state=${EV.finalState} state_files=${hits.length}`);
} catch { /* best-effort */ }

EV.elapsedMs = Date.now() - t0;
console.log(JSON.stringify({
    arm: EV.arm, round: EV.round, port: PORT, agent: AGENT,
    stallBound: EV.stallBound ?? null,
    r2Evicted: EV.r2Evicted ?? null,
    manualBound: EV.manualBound ?? null,
    proxyExit: EV.proxyExit,
    warmOk: EV.warmOk,
    finalState: EV.finalState,
    elapsedMs: EV.elapsedMs,
    ctrlRootReady: EV.ctrlRootReady,
    harnessError: EV.harnessError ?? null,
    trace: EV.trace.slice(-12),
}, null, 1));
