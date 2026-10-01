#!/usr/bin/env bash
# SEE-1338 spec v2.1 §2 (D1) — issue-id resolution + runtime_id_v2 keying.
#
# runtime_id_v2 = "<agent>-i<issue_number>" (e.g. Atlas-i1338). The issue id
# is the platform-stable identity (jerry 09-23 裁决: agent id + issue id 键控
# 端口) — unlike the worktree slot hash it survives slot churn (SEE-1338 单日
# 8 个 slot 目录实证) and drive changes (D: 换盘案例). Resolution chain reuses
# the existing Multica CLI surfaces only (no new platform API coupling):

KOL_SLOT_FALLBACK="${KOL_SLOT_FALLBACK:-solo}"
#
#   Path 0/1: MULTICA_TASK_ID → `multica issue run-messages <task_id>` first
#             message's issue_id (the auto-pr-on-stop.sh precedent);
#   Path 2:   MULTICA_AGENT_ID → `multica agent tasks` status=running +
#             work_dir==PWD match;
#   All fail  → empty → "<agent>-solo" (manual launch, unchanged semantics).
#
# Resolution happens ONCE per process group: the launcher calls
# mcp_resolve_issue_id, caches the result into KOL_RUNTIME_ID, and exports it
# — the proxy / helpers / editor cmdline / lease sidecar inherit it through
# the existing env pipeline (never re-spawns the multica CLI per tools/call).
# Extreme fallback: the issue id carries no decimal number (platform format
# change) → sha256(issue_uuid)[:8] as "-x<8hex>" so key uniqueness never
# regresses.

# mcp_runtime_id_v2_regex: accepts BOTH v2 ("<agent>-i<num>" /
# "<agent>-x<8hex>") and the v1 legacy slot-hash form (migration window reads
# old, writes new — spec §2.4 自然排水).
mcp_runtime_id_v2_regex() {
    printf '%s\n' '^[A-Za-z][A-Za-z0-9_-]*-(i[0-9]{1,10}|x[0-9a-f]{8}|solo|[0-9a-f]{8,})$'
}

# mcp_issue_number_from_id <issue_uuid-or-key>: extract the numeric suffix for
# the v2 key ("01a0c8b5-...-SEE-1338" style UUIDs or "SEE-1338" keys both →
# 1338 when a decimal run is present); empty output otherwise.
mcp_issue_number_from_id() {
    local id="${1:-}"
    [[ -n "$id" ]] || return 0
    local num
    num="$(printf '%s\n' "$id" | grep -oE '[0-9]+$' | tail -1)"
    if [[ -n "$num" && "$num" =~ ^[0-9]{1,10}$ ]]; then
        printf '%s\n' "$num"
        return 0
    fi
    return 0
}

# mcp_issue_key_hash <issue_uuid>: sha256[:8] fallback when no decimal run
# exists — guarantees key uniqueness without regressing (spec §2.1).
mcp_issue_key_hash() {
    local id="${1:-}"
    [[ -n "$id" ]] || return 0
    printf '%s' "$id" | sha256sum 2>/dev/null | cut -c1-8
}

# mcp_resolve_issue_id [workdir]: print the issue UUID (or empty). Uses ONLY
# env + the existing CLI surfaces; a CLI failure degrades to empty (→ -solo),
# never to a wrong id. Caches per-invocation via KOL_ISSUE_ID env when set.
mcp_resolve_issue_id() {
    # Env override wins (test seams / explicit pinning).
    if [[ -n "${KOL_ISSUE_ID:-}" ]]; then
        printf '%s\n' "$KOL_ISSUE_ID"
        return 0
    fi
    local workdir="${1:-$PWD}"
    # Path 0/1: task id → run-messages first message's issue_id.
    if [[ -n "${MULTICA_TASK_ID:-}" ]]; then
        local rid
        rid="$(multica issue run-messages "$MULTICA_TASK_ID" --output json 2>/dev/null \
            | node -e '
                let d = "";
                process.stdin.on("data", (c) => { d += c; });
                process.stdin.on("end", () => {
                    try {
                        const msgs = JSON.parse(d);
                        if (Array.isArray(msgs) && msgs.length > 0 && msgs[0] && msgs[0].issue_id) {
                            process.stdout.write(msgs[0].issue_id);
                        }
                    } catch (e) {}
                });
            ' 2>/dev/null || true)"
        if [[ -n "$rid" ]]; then
            printf '%s\n' "$rid"
            return 0
        fi
    fi
    # Path 2: agent id → running task whose work_dir matches this workdir.
    if [[ -n "${MULTICA_AGENT_ID:-}" ]]; then
        local rid
        rid="$(multica agent tasks "$MULTICA_AGENT_ID" --output json 2>/dev/null \
            | node -e '
                let d = "";
                process.stdin.on("data", (c) => { d += c; });
                process.stdin.on("end", () => {
                    try {
                        const tasks = JSON.parse(d);
                        const list = Array.isArray(tasks) ? tasks
                            : (tasks && Array.isArray(tasks.tasks)) ? tasks.tasks : [];
                        const wd = process.env.MCP_RESOLVE_WORKDIR || "";
                        for (const t of list) {
                            if (t && (t.status === "running") &&
                                t.work_dir && wd && (t.work_dir === wd || wd.startsWith(t.work_dir + "/"))) {
                                if (t.issue_id) { process.stdout.write(t.issue_id); return; }
                            }
                        }
                    } catch (e) {}
                });
            ' 2>/dev/null || true)"
        if [[ -n "$rid" ]]; then
            printf '%s\n' "$rid"
            return 0
        fi
    fi
    return 0
}

# mcp_derive_runtime_id_v2 <agent_name> [workdir]: print
# "<agent>-i<issue_number>" / "<agent>-x<8hex>" / "<agent>-solo".
# issue UUID resolution is env-controlled for testability (KOL_ISSUE_ID).
mcp_derive_runtime_id_v2() {
    local agent="${1:-}" workdir="${2:-$PWD}"
    local issue_id key
    issue_id="${KOL_ISSUE_ID:-$(mcp_resolve_issue_id "$workdir" || true)}"
    if [[ -z "$agent" ]]; then
        # No agent name: bare issue key (or solo) — degenerate but unique.
        key="$(mcp_issue_number_from_id "$issue_id")"
        [[ -n "$key" ]] || key="x$(mcp_issue_key_hash "$issue_id")"
        [[ -n "$issue_id" ]] && printf '%s\n' "i${key}" || printf '%s\n' "$KOL_SLOT_FALLBACK"
        return 0
    fi
    if [[ -z "$issue_id" ]]; then
        printf '%s\n' "${agent}-${KOL_SLOT_FALLBACK}"
        return 0
    fi
    key="$(mcp_issue_number_from_id "$issue_id")"
    if [[ -n "$key" ]]; then
        printf '%s\n' "${agent}-i${key}"
        return 0
    fi
    printf '%s\n' "${agent}-x$(mcp_issue_key_hash "$issue_id")"
}

# --- legacy KOL_* aliases (SEE-1268 §4.5.3 T2) ---
kol_issue_number_from_id() { mcp_issue_number_from_id "$@"; }
kol_issue_key_hash() { mcp_issue_key_hash "$@"; }
kol_resolve_issue_id() { mcp_resolve_issue_id "$@"; }
kol_derive_runtime_id_v2() { mcp_derive_runtime_id_v2 "$@"; }
kol_runtime_id_v2_regex() { mcp_runtime_id_v2_regex; }
