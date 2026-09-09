// SEE-1129 sidecar-guard real-machine fix (sub-step e43cdc73).
//
// The reuse short-circuit in ensureEditor() must decide, when the port is
// already busy, whether the EXISTING holder is THIS slot's editor (safe to
// reuse) or an UNTRUSTED holder that must be evicted before spawn.
//
// "This slot's editor" requires the holder to carry a .worktree sidecar AND
// for that sidecar's recorded worktree to equal the worktree this proxy
// resolved. The pre-fix M3 back-compat branch ("sidecar missing → reuse")
// was the design error Atlas confirmed: on the real machine the absent-sidecar
// case is a pre-#499 spawned holder (or a same-agent concurrent slot), and
// reusing it is exactly the path misdirection Archi reproduced
// (godot_project get_info returned c508560b, not 7a634b21).
//
// Returns one of:
//   'reuse'   — holder is provably THIS slot's editor (sidecar present + worktree match)
//   'evict'   — holder is untrusted: sidecar absent, OR worktree mismatch
//
// This predicate is WORKTREE-scoped (does the holder serve OUR worktree?),
// complementing the agent-scoped see1129-reuse-predicate.mjs (which is checked
// FIRST — a cross-agent holder is refused before this is even consulted).
export function decideSidecarGuard(holderWorktree, ourWorktree) {
    // No worktree for this slot → cannot prove a match; fall back to eviction
    // (the spawn path writes a fresh sidecar). This is rare (proxy unresolved).
    if (!ourWorktree) return 'evict';
    // Holder carries no .worktree sidecar → pre-#499 / manual holder: untrusted.
    if (!holderWorktree) return 'evict';
    // Holder sidecar points at a different worktree → a different slot's editor
    // (same-agent concurrent slot, or stale leftover): untrusted.
    if (holderWorktree !== ourWorktree) return 'evict';
    // Sidecar present and worktree matches → THIS slot's editor.
    return 'reuse';
}
