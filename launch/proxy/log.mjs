// proxy/log.mjs — stderr logging helpers (extracted from godot-mcp-proxy.mjs,
// SEE-1334 Phase 0a). stageLog honors the KOL_STAGE_LOG kill switch and stamps
// [t=+Nms] against the proxy start time in shared state.
import { EOL } from 'node:os';
import { S } from './state.mjs';
import { STAGE_LOG_ENABLED } from './config.mjs';

export function log(msg) {
    process.stderr.write(`[godot-mcp-proxy] ${msg}${EOL}`);
}

// SEE-1152 (Owner): end-to-end cold-start stage timing. Every emit carries
//   [stage=<NAME>]           machine-greppable stage token
//   [t=+Nms]                 milliseconds since proxy start (startedAt)
//   [ts=<iso8601>]           absolute wall-clock (UTC)
// Default ON (KOL_STAGE_LOG=off to silence). The stage names mirror the
// SEE-1110 warmup enum plus finer-grained spawn-path events the protocol
// cannot see (arbiterDecide, helper scripts, render-stable gate, npx CLI).
// Emitted to stderr only — never to stdout, so the JSON-RPC channel stays
// clean. Tests can grep stderr for `stage=` lines without parsing stdout.
export function stageLog(stage, msg = '') {
    if (!STAGE_LOG_ENABLED) return;
    const now = Date.now();
    const rel = now - S.startedAt;
    const iso = new Date(now).toISOString();
    const suffix = msg ? ` ${msg}` : '';
    process.stderr.write(`[godot-mcp-proxy] [stage=${stage}] [t=+${rel}ms] [ts=${iso}]${suffix}${EOL}`);
}
