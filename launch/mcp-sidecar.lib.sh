#!/usr/bin/env bash
# Helpers for reading / writing the per-worktree MCP lease sidecar file.
#
# SEE-1117 Direction 3: project.godot NEVER holds runtime lease state. The
# per-agent MCP port + lease lifecycle live in a sidecar JSON file at
# <worktree>/.godot/mcp-lease.json. .godot/ is already gitignored (line 1 of
# .gitignore), so the sidecar can never enter git — this is the core invariant
# that lets push-guard treat an active lease as a soft warning instead of a
# hard block.
#
# This lib is the single source of truth for the sidecar schema + atomic
# read/write primitives. configure-mcp-port.sh, restore-godot-original.sh,
# verify-godot-written-back.sh, and the hooks all source it so they agree on
# the exact format.
#
# JSON handling uses `node -e` (NOT jq) — jq may be unavailable in some
# runtimes (Archi doc §10 R3, Atlas review polish #2). The project already
# depends on node for hook JSON parsing.
#
# Sourced (not executed). Caller must define die().
#
# Sidecar schema (docs/SEE-1117-direction-3-sidecar-architecture.md §2.2.2, extended by
# SEE-1148 P1):
#   {
#     "schema_version": 2,
#     "port": <int>,
#     "agent": "<Name>",            # may be "" when configure used --port only
#     "label": "<lowercase>",       # may be ""
#     "state": "active"|"released",
#     "lease_id": "<uuid-v4>",
#     "worktree": "<abs path>",
#     "runtime_id": "<agent>-<hash8>|<agent>-solo",   # NEW in v2 — per-slot identity
#     "task_id": "<multica task id>|null",            # NEW in v2 — for log correlation
#     "configured_at": "<ISO8601>",
#     "configured_by_pid": <int|null>,
#     "released_at": "<ISO8601>|null",
#     "notes": "SEE-1117 sidecar lease"
#   }
#
# v1 backward compat: readers (sidecar_get, sidecar_state) tolerate any v1
# record that lacks runtime_id / task_id — they simply return "" for those
# fields. Writers always emit v2 (see SIDECAR_SCHEMA_VERSION). The reaper's
# schema_version gate (reap-stale-leases.sh) accepts both v1 and v2 active
# records; only a record with no parseable schema_version at all is rejected
# with a warning.

SIDECAR_SCHEMA_VERSION=2
SIDECAR_SCHEMA_VERSION_LEGACY=1
SIDECAR_NOTES="SEE-1117 sidecar lease"
SIDECAR_FILENAME="mcp-lease.json"
SIDECAR_REL_PATH=".godot/${SIDECAR_FILENAME}"

# State constants — kept as strings so callers can compare without quoting
# surprises. The schema uses the bare JSON strings "active" / "released".
SIDECAR_STATE_ACTIVE="active"
SIDECAR_STATE_RELEASED="released"

# Resolve the sidecar path for a given project.godot path (file or dir).
# Echoes <dir>/.godot/mcp-lease.json. Does NOT require the file to exist.
sidecar_path_for() {
    local project_godot="$1" target_dir
    if [[ -z "$project_godot" ]]; then
        die "sidecar_path_for: project.godot path is required."
    fi
    if [[ -d "$project_godot" ]]; then
        target_dir="$project_godot"
    else
        target_dir="$(dirname "$project_godot")"
    fi
    printf '%s/%s\n' "${target_dir%/}" "$SIDECAR_REL_PATH"
}

# Read a single field from the sidecar via node. Echoes the raw field value
# (string, number, or "" when absent / file missing / malformed). Never exits
# non-zero on a malformed sidecar — callers decide what "" means (verify treats
# a missing/unknown state as clean; configure treats it as "not active").
#
# The field name is JSON-stringified before interpolation so it cannot break
# out of the node expression (no shell/node injection from a caller-supplied
# field name).
#
# Usage: sidecar_get "$sidecar_path" "state"
sidecar_get() {
    local sidecar="$1" field="$2" json_field
    [[ -n "$field" ]] || return 0
    [[ -f "$sidecar" ]] || return 0
    json_field="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$field" 2>/dev/null)"
    [[ -n "$json_field" ]] || return 0
    node -e "
        let raw = '';
        process.stdin.on('data', c => raw += c);
        process.stdin.on('end', () => {
            try {
                const o = JSON.parse(raw);
                const v = o[${json_field}];
                process.stdout.write(v === null || v === undefined ? '' : String(v));
            } catch (e) {
                process.stdout.write('');
            }
        });
    " < "$sidecar" 2>/dev/null || true
}

# Atomically write the sidecar in the ACTIVE state with the given port.
# Arguments: <project_godot_path> <port> <agent_name_or_empty>
# Generates a fresh lease_id (uuid-v4 via node) and timestamp (ISO8601).
# Atomicity: write to mktemp, chmod 0644, then mv (rename) into place.
sidecar_write_active() {
    local project_godot="$1" port="$2" agent="${3:-}"
    [[ -n "$project_godot" ]] || die "sidecar_write_active: project.godot path required."
    [[ -n "$port" ]] || die "sidecar_write_active: port required."
    local sidecar worktree tmp
    sidecar="$(sidecar_path_for "$project_godot")"
    worktree="$(dirname "$sidecar")"          # the worktree root (= dirname of project.godot)
    worktree="${worktree%/.godot}"            # strip the /.godot suffix
    mkdir -p "$(dirname "$sidecar")"
    tmp="$(mktemp)"
    SIDE_WORKTREE="$worktree" SIDE_PORT="$port" SIDE_AGENT="$agent" \
    SIDE_PID="$$" SIDE_NOTES="$SIDECAR_NOTES" \
    SIDE_RUNTIME_ID="${KOL_RUNTIME_ID:-}" SIDE_TASK_ID="${KOL_TASK_ID:-}" \
    SIDE_KEEP_LEASE_ID="${KOL_KEEP_LEASE_ID:-}" \
    node -e '
        const crypto = require("crypto");
        const env = process.env;
        const out = {
            schema_version: 2,
            runtime_id: env.SIDE_RUNTIME_ID || "",
            task_id: env.SIDE_TASK_ID || "",
            port: Number(env.SIDE_PORT),
            agent: env.SIDE_AGENT || "",
            label: (env.SIDE_AGENT || "").toLowerCase(),
            state: "active",
            // SEE-1152: caller may pin a lease_id to preserve identity across a
            // stale-trace cleanup rewrite (configure fast-path hotfix). Empty →
            // generate fresh, the historical default.
            lease_id: env.SIDE_KEEP_LEASE_ID || crypto.randomUUID(),
            worktree: env.SIDE_WORKTREE || "",
            configured_at: new Date().toISOString(),
            configured_by_pid: Number(env.SIDE_PID) || null,
            released_at: null,
            notes: env.SIDE_NOTES || ""
        };
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    ' > "$tmp"
    chmod 0644 "$tmp"
    mv "$tmp" "$sidecar"
    echo "$sidecar"
}

# Atomically transition the sidecar to RELEASED state. Idempotent: no-op
# (exit 0) when the sidecar is absent or already released. Sets released_at.
# Returns 0 on success or no-op; dies only on a fatal write failure.
sidecar_write_released() {
    local project_godot="$1" sidecar state
    [[ -n "$project_godot" ]] || die "sidecar_write_released: project.godot path required."
    sidecar="$(sidecar_path_for "$project_godot")"
    [[ -f "$sidecar" ]] || return 0   # nothing to release
    state="$(sidecar_get "$sidecar" "state")"
    if [[ "$state" == "$SIDECAR_STATE_RELEASED" ]]; then
        return 0                       # already released
    fi
    local tmp
    tmp="$(mktemp)"
    REL_NOW="$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || printf '%s' '')" \
    node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                o.state = "released";
                o.released_at = process.env.REL_NOW || new Date().toISOString();
                process.stdout.write(JSON.stringify(o, null, 2) + "\n");
            } catch (e) {
                // Malformed sidecar — write a minimal released record so the
                // file still reflects lease-end. configure will overwrite it
                // on the next active lease.
                const minimal = {
                    schema_version: 2, port: 0, agent: "", label: "",
                    state: "released", lease_id: "",
                    worktree: "", configured_at: "",
                    runtime_id: "", task_id: "",
                    configured_by_pid: null,
                    released_at: process.env.REL_NOW || new Date().toISOString(),
                    notes: "SEE-1117 sidecar lease (restored from malformed)"
                };
                process.stdout.write(JSON.stringify(minimal, null, 2) + "\n");
            }
        });
    ' < "$sidecar" > "$tmp"
    chmod 0644 "$tmp"
    mv "$tmp" "$sidecar"
}

# Convenience: echo "active" / "released" / "" (absent or malformed).
sidecar_state() {
    local sidecar="$1"
    [[ -f "$sidecar" ]] || return 0
    sidecar_get "$sidecar" "state"
}

# SEE-1240 WS-8 retirement note: sidecar_write_override_cfg() (the WS-1
# override.cfg injection channel) is REMOVED. Godot 4.6.2's ProjectSettings
# loader does not read override.cfg when the project lives on a WSL UNC path
# (`\\wsl.localhost\...` — Fronti WS-3 实锤, same source as the SEE-1070
# Revy NO-GO), so the channel never worked in this deployment. Machine-level
# bind settings (bind_mode=1 / custom_bind_ip) returned to project.godot's
# static [godot_mcp] section — they are deployment-topology constants, not
# per-agent runtime state; the per-agent PORT stays sidecar-only.
