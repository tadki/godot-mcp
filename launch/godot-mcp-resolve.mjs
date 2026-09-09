// SEE-1085 usability: resolve how to launch @satelliteoflove/godot-mcp.
//
// Extracted from the proxy so the resolution logic (override → local install →
// npx cache walk → fallback) is unit-testable without booting the proxy.
//
// Why this exists: `npx -y @satelliteoflove/godot-mcp` pays ~2.9s of
// resolution/registry overhead per cold spawn (measured), vs ~0.3s for
// `node <bin>` on the same cached package — an order of magnitude. Fronti's
// 5.77s/5.80s initialize/tools-list cold handshake is this npx cost. Spawning
// `node <bin>` directly when the package is already on disk cuts the cold
// handshake from ~6s toward ~0.6s. npx content-addresses each specifier under
// an unstable hash (~/.npm/_npx/<hash>/...), so the path cannot be hardcoded;
// this resolver walks the cache and picks the newest entry.

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const GODOT_MCP_PKG = '@satelliteoflove/godot-mcp';

// SEE-1111 (cold-start one-shot): the owner's fork fixes the upstream cold-start
// 'Not connected' failure by making the server's QUICK_TIMEOUT_MS configurable
// (GODOT_MCP_QUICK_TIMEOUT_MS, default stays 30s upstream) and by connecting /
// reconnecting in the background so a tools/call forwarded at WARM waits for the
// WS instead of erroring instantly. The platform spawns the PROXY directly via
// an absolute D-drive path (it does NOT run godot-mcp-launcher.sh), so the
// launcher's fork wiring never applies in production — the resolver must prefer
// the fork itself. The fork is required (upstream has no GODOT_MCP_QUICK_TIMEOUT
// support), so it is NOT opt-in; KOL_GODOT_MCP_CMD remains the explicit override
// and the npx path stays the fallback when the fork is absent (offline / fresh
// machine / CI test harness).
const FORK_CLI = '/mnt/d/GodotProjects/forks/godot-mcp/server/dist/cli.js';
function resolveFork() {
    try {
        statSync(FORK_CLI);
        return { cmd: process.execPath, args: [FORK_CLI], source: `node ${FORK_CLI} (owner fork)` };
    } catch {
        return null;
    }
}

// Resolve the package's bin entry to an absolute path, or null. Accepts a
// pre-parsed package.json (avoids a second read in the cache-walk path).
function readBinEntry(pkgDir, pkgName, pkg) {
    if (!pkg) {
        try {
            pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
        } catch {
            return null;
        }
    }
    const binField = pkg && pkg.bin;
    const binRel = typeof binField === 'string'
        ? binField
        : (binField && typeof binField === 'object'
            ? (binField[pkgName] || Object.values(binField)[0])
            : null);
    if (typeof binRel !== 'string' || !binRel) return null;
    const binAbs = path.join(pkgDir, binRel);
    try {
        statSync(binAbs);
        return binAbs;
    } catch {
        return null;
    }
}

// Returns { cmd, args, source }. cmd is process.execPath (direct node) or 'npx'
// (fallback). args is the full argv tail to spawn. source is a human-readable
// provenance string the proxy logs once at startup.
//
// Resolution order:
//   1. KOL_GODOT_MCP_CMD override — 'npx' forces npx; any other non-empty value
//      is treated as a path to the bin entry and spawned as `node <path>`.
//      (Test seam + an operator escape hatch; always honored.)
//   2. OPT-IN auto-detection (KOL_DIRECT_GODOT_MCP=1): local node_modules via
//      require.resolve, then npx cache (~/.npm/_npx/<hash>/..., newest mtime
//      wins). Opt-in so test harnesses that inject a mock npx onto PATH (and
//      do not set KOL_GODOT_MCP_CMD) keep using their mock instead of an
//      unrelated cached package that happens to live on the same machine.
//      Production enables it (godot-mcp-launcher.sh sets it) to get the
//      ~2.5s cold-start speedup.
//   3. `npx -y <pkg>` fallback (default, and also when opt-in finds nothing).
export function resolveGodotMcpCommand() {
    const override = (process.env.KOL_GODOT_MCP_CMD || '').trim();
    if (override) {
        if (override === 'npx') {
            return { cmd: 'npx', args: ['-y', GODOT_MCP_PKG], source: 'npx (KOL_GODOT_MCP_CMD=npx)' };
        }
        return { cmd: process.execPath, args: [override], source: `node ${override} (KOL_GODOT_MCP_CMD)` };
    }

    // SEE-1111: prefer the owner fork (90s quick-timeout + background reconnect)
    // so a tools/call forwarded at WARM connects instead of erroring 'Not
    // connected'. Required — upstream has no equivalent. Fall through when absent.
    // OPT-OUT (test seam): KOL_DIRECT_GODOT_MCP=0 means the caller explicitly
    // wants the npx/PATH path — test harnesses that inject a mock npx onto PATH
    // (and never set KOL_GODOT_MCP_CMD) rely on the proxy spawning their mock,
    // not the real fork (which would try to drive a real editor the mock
    // listener is not). Honoring the opt-out keeps those tests on their mock.
    if (process.env.KOL_DIRECT_GODOT_MCP !== '0') {
        const fork = resolveFork();
        if (fork) return fork;
    }

    // (2) opt-in auto-detection: cache walk only when explicitly enabled.
    if (process.env.KOL_DIRECT_GODOT_MCP === '1') {
        // (2a) local install up the require chain.
        try {
            const require = createRequire(import.meta.url);
            const pkgJsonPath = require.resolve(`${GODOT_MCP_PKG}/package.json`);
            const dir = path.dirname(pkgJsonPath);
            const bin = readBinEntry(dir, GODOT_MCP_PKG);
            if (bin) return { cmd: process.execPath, args: [bin], source: `node ${bin} (local install)` };
        } catch {
            // not locally installed — fall through
        }

        // (2b) npx cache. Newest mtime wins so a version bump (new hash) is
        // preferred over a stale entry, matching what `npx -y` would re-fetch.
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const npxRoot = path.join(home, '.npm/_npx');
        let best = null;
        let bestMtime = 0;
        try {
            for (const entry of readdirSync(npxRoot)) {
                const dir = path.join(npxRoot, entry, 'node_modules', GODOT_MCP_PKG);
                const pkgJsonPath = path.join(dir, 'package.json');
                let st;
                try {
                    st = statSync(pkgJsonPath);
                } catch {
                    continue;
                }
                let pkg;
                try {
                    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
                } catch {
                    continue;
                }
                const bin = readBinEntry(dir, GODOT_MCP_PKG, pkg);
                if (!bin) continue;
                const mtime = st.mtimeMs || 0;
                if (mtime > bestMtime) {
                    bestMtime = mtime;
                    best = {
                        cmd: process.execPath,
                        args: [bin],
                        source: `node ${bin} (npx-cache ${pkg.version || '?'})`,
                    };
                }
            }
        } catch {
            // no npx cache dir — fall through to npx
        }
        if (best) return best;
        // opt-in cache walk found nothing — fall through to npx anyway.
    }

    // (3) fallback: spawn via npx (resolves PATH; first run populates the cache).
    return { cmd: 'npx', args: ['-y', GODOT_MCP_PKG], source: 'npx -y' };
}
