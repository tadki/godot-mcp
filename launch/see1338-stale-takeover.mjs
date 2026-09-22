// SEE-1338 §SPEC-GM1b — stale-proxy takeover decision (pure, no IO).
//
// The 150-machine incident (SEE-1338): a previous session's godot-mcp proxy
// kept holding the editor's single WS client slot after its session died.
// The new session's proxy could never recover from it:
//   * arbiter 'busy_foreign' → retryable editor_busy forever (form A);
//   * arbiter 'reuse' → a full PORT_TAKEOVER_TIMEOUT_MS (300s) wait per call,
//     then the same editor_busy loop (form C);
// because every lane refuses to touch a LIVE holder.
//
// A live holder is only takeable when it is PROVABLY a leftover godot-mcp
// proxy bound to OUR port: /proc cmdline must match the proxy script and the
// proxy's own environ must carry our port. Anything less (unreadable cmdline,
// port mismatch, no pid) is a NO — a foreign editor or an unrelated process
// is never killed. Same-runtime holders are only takeable in the escalated
// mode (allowSameRuntime), which callers may pass ONLY after a proven
// non-release (e.g. the takeover window expired with the slot still held) —
// a same-runtime holder that is alive and serving is a legitimate concurrent
// slot, not residue.

import process from 'node:process';

export function decideStaleProxyTakeover({
    holderPid = null,
    holderRuntimeId = '',
    ourRuntimeId = '',
    holderCmdline = '',
    holderPort = null,
    ourPort = null,
    allowSameRuntime = false,
}) {
    if (!Number.isInteger(holderPid) || holderPid <= 0) {
        return { takeover: false, reason: 'NO_HOLDER_PID' };
    }
    if (holderPid === process.pid) {
        return { takeover: false, reason: 'SELF' };
    }
    if (!holderCmdline || !/godot-mcp-proxy/.test(holderCmdline)) {
        return { takeover: false, reason: 'CMDLINE_NOT_PROXY' };
    }
    if (!Number.isInteger(holderPort) || !Number.isInteger(ourPort) || holderPort !== ourPort) {
        return { takeover: false, reason: 'PORT_MISMATCH' };
    }
    if (ourRuntimeId && holderRuntimeId === ourRuntimeId) {
        if (!allowSameRuntime) return { takeover: false, reason: 'SAME_RUNTIME_LIVE' };
        return { takeover: true, reason: 'SAME_RUNTIME_NONRELEASE_STALE' };
    }
    return { takeover: true, reason: holderRuntimeId ? 'FOREIGN_RUNTIME_STALE' : 'UNMARKED_STALE_PROXY' };
}
