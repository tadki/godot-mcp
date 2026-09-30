// proxy/runtime-id.mjs — the slot-form runtime_id predicate, single source of
// truth (SEE-1356 batch-2 cleanup, hardener observation ③: the dual-form
// naming rule was hand-copied as the same regex in giveup/log/proxy-state).
//
// A real slot runtime_id looks like `<label>-<8..12 hex>` (the
// mcp_runtime_id_regex family); the '*' wildcard, -solo/manual runs and empty
// values fall back to the legacy flat name so the two file families never
// collide (SEE-1240 WS-5 / L5 / L6 all share this rule).
export const SLOT_RUNTIME_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/;

export function isSlotRuntimeId(runtimeId) {
    return Boolean(runtimeId) && runtimeId !== '*' && !runtimeId.endsWith('-solo') && SLOT_RUNTIME_ID_RE.test(runtimeId);
}
