#!/usr/bin/env bash
# SEE-1148 P1: registry file for per-runtime MCP port ownership.
#
# P1 scope: WRITE-ONLY — every write is an append/refresh of one entry keyed
# by runtime_id. No dynamic port allocation yet (Atlas gate). P2 will read
# the same file to drive allocation, so the schema is shaped for that:
#   {
#     "schema_version": 2,
#     "updated_at": "<ISO8601>",
#     "entries": {
#       "<runtime_id>": {
#         "port": <int>,
#         "agent": "<Name>",
#         "label": "<lowercase>",
#         "worktree": "<abs path>",
#         "lease_id": "<uuid>",
#         "proxy_pid": <int|null>,
#         "heartbeat_at": "<ISO8601>|null"
#       }
#     }
#   }
#
PORT_REGISTRY_SCHEMA_VERSION=1
PORT_REGISTRY_FILENAME="godot-port-registry.json"

# Storage: ${GODOT_MCP_PORT_REGISTRY_PATH_OVERRIDE:-${GODOT_MCP_HOME}/godot-port-registry.json}
# (canonical form; the legacy KOL_PORT_REGISTRY_PATH_OVERRIDE alias is mapped in
# env.sh when sourced — scripts that do not source env.sh fall back to the
# legacy read here). The override exists so the reaper's registry-sweep tests
# can run the REAL reaper binary against a sandbox registry without relocating
# HOME (relocating HOME breaks node/git discovery in some runtimes). Production
# callers never set it.
#
# F11 (Atlas P1 FAIL 修订决策): no /root fallback. HOME unset is an
# environment anomaly — die loudly at source time rather than writing the
# registry to an unexpected path (e.g. /.multica as root) that the rest of
# the toolchain will never read back. Callers that need a controlled
# sandbox set HOME explicitly (or use the override above).
if [[ -n "${GODOT_MCP_PORT_REGISTRY_PATH_OVERRIDE:-}" || -n "${KOL_PORT_REGISTRY_PATH_OVERRIDE:-}" ]]; then
    PORT_REGISTRY_PATH="${GODOT_MCP_PORT_REGISTRY_PATH_OVERRIDE:-${KOL_PORT_REGISTRY_PATH_OVERRIDE}}"
    PORT_REGISTRY_DIR="$(dirname "$PORT_REGISTRY_PATH")"
else
    if [[ -z "${HOME:-}" ]]; then
        echo "[port-registry.lib.sh] FATAL: HOME is unset; refusing to pick a registry path." >&2
        exit 1
    fi
    PORT_REGISTRY_DIR="${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}"
    PORT_REGISTRY_PATH="${PORT_REGISTRY_DIR}/${PORT_REGISTRY_FILENAME}"
fi

# Echo the canonical registry path. Callers MUST NOT hardcode it.
port_registry_path() {
    printf '%s\n' "$PORT_REGISTRY_PATH"
}

# Atomically upsert one entry into the registry, keyed by runtime_id.
# Preserves every other field and every other entry — the whole file is
# read, the entry is shallow-merged, then the file is written back.
#
# Concurrency: mktemp + chmod + mv make the *publish* step atomic, but the
# read-modify-write inside node is NOT serialized. Revy P1 review §A3+A4
# (HIGH) showed that 5 concurrent writers to the same rid lose 4 of 5
# writers' fields under the mktemp+mv-only pattern. Fix: take a flock on
# a dedicated lockfile for the entire read-modify-write-publish critical
# section. flock is BLOCKING here: concurrent callers serialize naturally,
# so no field is lost. Cost is bounded by the actual write time (~50ms in
# the worst case where 5 writers all want to write at the same instant);
# the proxy heartbeat fires at 2s intervals and the launcher fires once
# per cold-start, so contention is rare and the queue depth is shallow.
#
# Args:
#   <runtime_id>   — required, the map key
#   <kv pairs>     — key=value pairs to merge into the entry (port, agent,
#                    label, worktree, lease_id, proxy_pid, heartbeat_at).
#                    Missing keys keep their previous value.
#
# Stdout: nothing on success. Dies only on a fatal write error OR a held
# lock (caller decides whether to retry).
port_registry_upsert() {
    local rid="$1"; shift
    [[ -n "$rid" ]] || die "port_registry_upsert: runtime_id required."
    mkdir -p "$PORT_REGISTRY_DIR"
    local lock_path="${PORT_REGISTRY_PATH}.lock"
    # Touch the lockfile so flock has a stable inode (flock on a path that
    # doesn't exist yet still works on Linux, but a stable inode makes the
    # release semantics unambiguous on shared filesystems).
    : > "$lock_path" 2>/dev/null || true
    exec 9>"$lock_path"
    # BLOCKING flock: serialize concurrent writers. die only on a fatal
    # write error, never on contention. The critical section is short
    # (read + write + mv), so queue depth is bounded by write time.
    flock 9 || {
        exec 9>&-
        die "port_registry_upsert: flock on ${lock_path} failed (filesystem error)."
    }
    # From here to the matching 9>&- is the critical section.
    local tmp
    tmp="$(mktemp "${PORT_REGISTRY_DIR}/.godot-port-registry.XXXXXX.tmp")"
    # Snapshot existing file (if any), merge, write. Pure node JSON so we
    # never shell-quote user fields. node handles atomic read-modify-write
    # inside one process; the mv at the end is the publish barrier.
    REG_PATH="$PORT_REGISTRY_PATH" REG_RID="$rid" \
    REG_PAIRS="$*" \
    node -e '
        const fs = require("fs");
        const path = process.env.REG_PATH;
        const rid = process.env.REG_RID;
        const pairs = process.env.REG_PAIRS || "";
        const out = { schema_version: 2, updated_at: new Date().toISOString(), entries: {} };
        // Read existing.
        try {
            const raw = fs.readFileSync(path, "utf8");
            const cur = JSON.parse(raw);
            if (cur && typeof cur === "object" && cur.entries && typeof cur.entries === "object") {
                out.entries = cur.entries;
            }
        } catch (e) { /* missing or malformed — start fresh */ }
        // Merge new fields into the entry.
        const prev = (out.entries[rid] && typeof out.entries[rid] === "object") ? out.entries[rid] : {};
        const next = Object.assign({}, prev);
        for (const tok of pairs.split(/\s+/)) {
            if (!tok) continue;
            const eq = tok.indexOf("=");
            if (eq <= 0) continue;
            const k = tok.slice(0, eq);
            const v = tok.slice(eq + 1);
            // Type coercion for known numeric fields.
            if (k === "port" || k === "proxy_pid") {
                const n = Number(v);
                next[k] = Number.isFinite(n) ? n : null;
            } else {
                next[k] = v;
            }
        }
        out.entries[rid] = next;
        fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n", "utf8");
    ' "$tmp"
    chmod 0644 "$tmp"
    mv "$tmp" "$PORT_REGISTRY_PATH"
    # Release the lock and close the fd.
    exec 9>&-
}

# Atomically DELETE one entry from the registry, keyed by runtime_id.
# No-op (returns 0) when the registry is missing or the entry does not exist.
# A malformed registry is left UNTOUCHED (returns 1) — the caller reports it
# rather than destroying forensic bytes.
#
# Concurrency: the SAME flock protocol as port_registry_upsert (blocking
# flock on ${PORT_REGISTRY_PATH}.lock, fd 9). The reaper's registry sweep
# deletes through this function so a delete can never interleave with a
# concurrent proxy heartbeat upsert — no new lock is introduced.
port_registry_delete() {
    local rid="$1"
    [[ -n "$rid" ]] || die "port_registry_delete: runtime_id required."
    [[ -f "$PORT_REGISTRY_PATH" ]] || return 0   # nothing to delete from
    local lock_path="${PORT_REGISTRY_PATH}.lock"
    : > "$lock_path" 2>/dev/null || true
    exec 9>"$lock_path"
    flock 9 || {
        exec 9>&-
        die "port_registry_delete: flock on ${lock_path} failed (filesystem error)."
    }
    local tmp rc
    tmp="$(mktemp "${PORT_REGISTRY_DIR}/.godot-port-registry.XXXXXX.tmp")"
    set +e
    REG_PATH="$PORT_REGISTRY_PATH" REG_RID="$rid" \
    node -e '
        const fs = require("fs");
        let cur;
        try { cur = JSON.parse(fs.readFileSync(process.env.REG_PATH, "utf8")); }
        catch (e) { process.exit(3); }   // missing or malformed — leave untouched
        if (!cur || typeof cur !== "object" || !cur.entries || typeof cur.entries !== "object") {
            process.exit(3);
        }
        if (!(process.env.REG_RID in cur.entries)) { process.exit(4); }   // entry absent
        delete cur.entries[process.env.REG_RID];
        cur.updated_at = new Date().toISOString();
        fs.writeFileSync(process.argv[1], JSON.stringify(cur, null, 2) + "\n", "utf8");
        process.exit(0);
    ' "$tmp"
    rc=$?
    set -e
    if (( rc == 0 )); then
        chmod 0644 "$tmp"
        mv "$tmp" "$PORT_REGISTRY_PATH"
    else
        rm -f "$tmp" 2>/dev/null || true
    fi
    exec 9>&-
    # rc==4 (entry absent) is a no-op success; rc==3 (malformed) is reported.
    (( rc == 4 )) && return 0
    return "$rc"
}

# Echo the JSON-encoded value of a single field on a single entry.
# Empty string when the entry or field does not exist.
port_registry_get() {
    local rid="$1" field="$2"
    [[ -n "$rid" && -n "$field" ]] || return 0
    [[ -f "$PORT_REGISTRY_PATH" ]] || return 0
    REG_RID="$rid" REG_FIELD="$field" \
    node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                const e = (o.entries || {})[process.env.REG_RID];
                const v = e ? e[process.env.REG_FIELD] : undefined;
                process.stdout.write(v === null || v === undefined ? "" : String(v));
            } catch (err) {
                process.stdout.write("");
            }
        });
    ' < "$PORT_REGISTRY_PATH" 2>/dev/null || true
}

# Echo "alive" / "stale" / "" (no entry) for a given runtime_id, based on
# whether its heartbeat_at is within HEARTBEAT_STALE_MS.
port_registry_runtime_state() {
    local rid="$1" heartbeat now_ms hb_ms age_ms
    [[ -n "$rid" ]] || return 0
    heartbeat="$(port_registry_get "$rid" "heartbeat_at")"
    [[ -n "$heartbeat" ]] || return 0
    now_ms="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null)" || return 0
    hb_ms="$(node -e 'process.stdout.write(String(Date.parse(process.argv[1])))' "$heartbeat" 2>/dev/null)" || return 0
    age_ms=$(( now_ms - hb_ms ))
    # 60s staleness threshold — generous enough for a held proxy connection
    # across a slow step; tight enough that a crashed proxy is visible quickly.
    if (( age_ms < 60000 )); then
        printf 'alive\n'
    else
        printf 'stale\n'
    fi
}
