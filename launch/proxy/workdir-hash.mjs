// proxy/workdir-hash.mjs — SEE-1356 L2 (§SPEC-L2-01): proxy-side consumer of
// the kol_workdir_hash SSOT. The hash itself is computed ONLY by
// launch/runtime.lib.sh (slot 主口径 + sha256(realpath)[:8] fallback +
// hash_source provenance); this module shells out to that helper and caches
// the result per process — the proxy never derives a hash of its own.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime.lib.sh');

// resolveWorkdirHash(worktree) → { workdir_hash, hash_source } | null.
// Best-effort: a bash/helper failure returns null (callers degrade to
// snapshot_absent / no-hash presentation, never throw).
export function resolveWorkdirHash(worktree) {
    if (!worktree) return null;
    try {
        // Helper stdout contract: ONE line "<hash> <source>" ($()-safe).
        const out = execFileSync('bash', [
            '-c',
            'source "$1" && kol_workdir_hash "$2"',
            'wdhash', RUNTIME_LIB, String(worktree),
        ], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
        const [hash, source] = String(out).trim().split(/\s+/);
        if (!hash || !/^[0-9a-f]{1,64}$/.test(hash)) return null;
        return { workdir_hash: hash, hash_source: source === 'slot' || source === 'path' ? source : null };
    } catch {
        return null;
    }
}
