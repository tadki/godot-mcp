// SEE-1129 (instance selection layer): pure reuse-path decision predicate.
//
// Owner's three principles for godot-mcp instance selection (verbatim):
//   1. "一个 agent 一个 editor" — same agent reuses its existing Godot instance.
//   2. "同 agent 二次用同一个 editor 不报'已被使用'" — same-agent hit = reuse,
//      never an in-use error; ONLY cross-agent contention errors.
//   5. cross-agent grabbing the same editor = error, not a misconnect.
//
// Ports are allocated per agent NAME (agent-ports.json), so two session slots
// of the SAME agent resolve to the SAME port. The decision the proxy must make
// when it finds the port busy is therefore AGENT-scoped, not worktree-scoped:
//   * holder.agent === ourAgent  -> 'reuse'  (principle #1/#2)
//   * holder.agent !== ourAgent  -> 'foreign' (principle #5, cross-agent error)
//   * holder.agent unverifiable  -> 'reuse'  (back-compat: older holder / manual
//                                            launch wrote no agent field, or
//                                            the sidecar is absent/malformed)
//
// The worktree argument is retained for diagnostics only — a same-agent holder
// may legitimately have a DIFFERENT worktree open (a concurrent same-agent slot
// serving that slot's project). Under the single-client WebSocket addon limit
// (SEE-1054, websocket_server.gd:122) the proxy cannot truly "reuse" another
// slot's live editor: the addon rejects a 2nd WS client with close 4001 and the
// editor_busy takeover path waits for the holder to release. The worktree check
// therefore does NOT gate reuse here — it is surfaced so the caller can report
// path-mismatch drift without refusing a same-agent reuse.
export function decideReuse(holderAgent, ourAgent, holderWorktree = null, ourWorktree = null) {
    // Unverifiable holder (no sidecar / no agent field / malformed) → reuse.
    if (holderAgent === null || holderAgent === undefined || holderAgent === '') return 'reuse';
    if (!ourAgent) return 'reuse';
    // Principle #1/#2: same agent always reuses, regardless of worktree.
    if (holderAgent === ourAgent) return 'reuse';
    // Principle #5: cross-agent contention → refuse (foreign).
    return 'foreign';
}

// Convenience: does this decision refuse the holder (principle #5)?
export function isForeign(decision) {
    return decision === 'foreign';
}
