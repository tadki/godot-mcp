#!/usr/bin/env node
// SEE-1325 H2 / SEE-1328 阶段一 — launch 配置双轨 fail-fast 校验器（纯函数 + CLI）。
//
// 判定链（§SPEC-011/012，仅当磁盘签名命中 KOL 部署形态时硬约束生效）：
//   1. 磁盘签名（非 env 证据）：repo root 有 project.godot 且 .dev/env/kol-mcp.env
//      存在，且 shim 的 realpath 不落在共享 master 检出内（S3 仅锚 shim，
//      理由见 detectKolSignature 内注）。
//   2. 注入健康度：GODOT_MCP_HOME 必须位于 $HOME 之下且 ≠ 内置默认
//      ~/.config/godot-mcp（NEUTRAL 默认 = daemon 注入通道被绕过）。
//   3. 执行路径（LAUNCHER_PATH / FORK_CLI）禁 /mnt/ 字面量；SHARED_MASTER 数据
//      路径不校验；GODOT_MCP_ALLOW_DRVFS_PATHS=1 逃生门（caller 负责
//      DRDFS_ESCAPE=1 stage log）。
// marker（GODOT_MCP_ENV_INJECTED）只进诊断日志，绝不改变判定。
// 诊断文案显式指向平台根治项：daemon /tmp/multica-mcp-*/mcp-config.json 模板
// 硬编码 D 盘 launcher/hindsight（平台立项，fork 侧 fail-fast 是止血）。
//
// CLI:
//   node config-validate.mjs --repo-root <dir> --shim <path> --launcher <path>
//        --fork-cli <path> --home <dir> --godot-mcp-home <dir>
//        [--shared-master <dir>] [--marker <v>] [--allow-drvfs]
// Exit code 0（ok）/ 2（hard fail）。≤2s 墙钟由纯同步实现保证。

import fs from 'node:fs';
import path from 'node:path';

export const SHIM_STAGE_LINE = '[godot-mcp-shim] stage=CONFIG_VALIDATE';
// 模板串不得内嵌 DRDFS_ESCAPE 字面量：launcher 以 case *DRDFS_ESCAPE* glob 判定，
// 占位符会导致非 escape 场景每次误发 DRDFS_ESCAPE stage log（SEE-1328 D1）。
export const LAUNCHER_STAGE_LINE =
    '[godot-mcp-launcher] stage=CONFIG_VALIDATE';
export const DRDFS_STAGE_LINE = '[godot-mcp-launcher] stage=DRDFS_ESCAPE msg="GODOT_MCP_ALLOW_DRVFS_PATHS=1 escape active"';

// 内置默认 GODOT_MCP_HOME（NEUTRAL 默认 = daemon 注入通道被绕过）。
function neutralDefault() {
    return path.join(process.env.HOME || '/', '.config', 'godot-mcp');
}

function isUnder(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDrdfs(p) {
    return typeof p === 'string' && p.startsWith('/mnt/');
}

// 磁盘签名（S1-S3）。SHARED_MASTER 为空/缺失 → probe-fail 语义保守跳过 S3，
// 与 owner-order "master 共享拒绝防御 fail-open 禁止" 的区分点：这里 S3 缺
// 锚点时退化为主判 S1+S2（两个事实源仍在，非 fail-open 到不校验）。
function detectKolSignature(input) {
    const hasProject = input.repoRoot && fs.existsSync(path.join(input.repoRoot, 'project.godot'));
    const hasEnvFile = input.repoRoot && fs.existsSync(path.join(input.repoRoot, '.dev', 'env', 'kol-mcp.env'));
    let outsideSharedMaster = true;
    if (input.sharedMaster && fs.existsSync(input.sharedMaster)) {
        // S3 只锚 shim：真实 daemon 分裂态里被硬编码拉起的是 D 盘 master 的
        // launcher —— 用 launcher 归位会把它误判成 NON_KOL，guard 永不触发。
        outsideSharedMaster = !isUnder(input.scriptPath, input.sharedMaster);
    }
    return { isKol: Boolean(hasProject && hasEnvFile && outsideSharedMaster), hasProject, hasEnvFile, outsideSharedMaster };
}

function homeHealth(input) {
    const home = input.godotMcpHome;
    if (!home) return false;
    // 判定用真实 $HOME（input.home），非注入后的 env —— 与 shim 内置默认
    // ~/.config/godot-mcp 的比较防的是"NEUTRAL 默认漏网"。
    if (!isUnder(home, input.home)) return false;
    const neutral = input.home === (process.env.HOME || '/')
        ? neutralDefault()
        : path.join(input.home, '.config', 'godot-mcp');
    if (path.resolve(home) === path.resolve(neutral)) return false;
    return true;
}

export function validateLaunchConfig(input) {
    const sig = detectKolSignature(input);
    const diagnostics = {
        signature: sig,
        godotMcpHome: input.godotMcpHome || '',
        envInjectedMarker: input.envInjectedMarker || '',
        rootCause: 'daemon /tmp/multica-mcp-*/mcp-config.json template hardcodes the D-drive launcher/hindsight paths — platform-side fix pending (see Atlas escalation); this guard is stopgap fail-fast',
    };
    if (!sig.isKol) {
        return { ok: true, rc: 0, reason: 'NON_KOL', escape: '', diagnostics };
    }
    // 逃生门：仅豁免 DRDFS 执行路径，HOME 健康度照判（§SPEC-012）。
    const drdfsExec = isDrdfs(input.launcherPath) || isDrdfs(input.forkCli);
    if (drdfsExec && !input.allowDrvfsPaths) {
        return {
            ok: false, rc: 2, reason: 'DRDFS_EXEC_PATH', escape: '',
            diagnostics: { ...diagnostics, reason: 'execution path (LAUNCHER_PATH/FORK_CLI) must not live under /mnt/ — daemon template hardcodes the D-drive launcher; platform root-cause fix pending (daemon mcp-config template convergence)' },
        };
    }
    if (!homeHealth(input)) {
        return {
            ok: false, rc: 2, reason: 'HOME_HEALTH_UNSAFE', escape: drdfsExec ? 'DRDFS_ESCAPE' : '',
            diagnostics: { ...diagnostics, reason: 'GODOT_MCP_HOME injection is unhealthy (not under $HOME or equal to the built-in neutral default) while the KOL deployment signature holds — the daemon-spawned chain bypassed .dev/env/kol-mcp.env; fix is the platform daemon mcp-config template (hardcoded D-drive paths), this rc-2 stopgap points there' },
        };
    }
    return { ok: true, rc: 0, reason: 'KOL_HEALTHY', escape: drdfsExec ? 'DRDFS_ESCAPE' : '', diagnostics };
}

// ---- CLI（供 bash 侧双入口调用）--------------------------------------------------
function main(argv) {
    const arg = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--allow-drvfs') { arg.allowDrvfs = true; continue; }
        if (!k.startsWith('--')) continue;
        arg[k.slice(2)] = argv[++i] ?? '';
    }
    // §SPEC-012 逃生门是 env 语义（GODOT_MCP_ALLOW_DRVFS_PATHS=1）：shim/launcher
    // 双入口都不透传 --allow-drvfs，CLI 必须同时读 env，否则逃生门在真实链上失效。
    const r = validateLaunchConfig({
        repoRoot: arg['repo-root'],
        scriptPath: arg.shim,
        launcherPath: arg.launcher,
        forkCli: arg['fork-cli'],
        godotMcpHome: arg['godot-mcp-home'],
        home: arg.home || process.env.HOME,
        sharedMaster: arg['shared-master'] || '',
        envInjectedMarker: arg.marker || '',
        allowDrvfsPaths: arg.allowDrvfs || process.env.GODOT_MCP_ALLOW_DRVFS_PATHS === '1',
    });
    const line = r.escape === 'DRDFS_ESCAPE'
        ? DRDFS_STAGE_LINE
        : `${LAUNCHER_STAGE_LINE} ok=${r.ok} reason=${r.reason}`;
    process.stderr.write(`${line}\n`);
    if (!r.ok) {
        process.stderr.write(`[config-validate] FATAL: ${r.diagnostics.reason}\n`);
        process.stderr.write(`[config-validate] diagnostics: ${JSON.stringify(r.diagnostics)}\n`);
        process.exit(r.rc);
    }
    process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}
