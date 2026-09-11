#!/usr/bin/env bash
# SEE-1148 P2: dynamic port allocation + the reuse/evict decision tree.
#
# Sourced (not executed). The caller provides die() and (optionally) a log
# sink. This lib owns the L2 port-grant layer:
#   - the dynamic pool 6560-6609 (physically isolated from the legacy
#     per-agent reserved pool 6551-6556 in agent-ports.json — the two ranges
#     never overlap, so migration-era runtimes never mis-kill each other);
#   - per-port mkdir arbitration (no global lock; the loser moves to the next
#     candidate);
#   - a registry flock short critical section (flock -n 9) for the
#     read-modify-write that records the grant;
#   - the 60s cross-runtime cooldown (same-runtime reuse skips it);
#   - the reuse/evict decision tree the proxy walks when a port is busy.
#
# Layering contract (Atlas §2.2): the SIDECAR is the source of truth for a
# worktree's bound port; the REGISTRY is an acceleration layer. A registry
# entry alone NEVER blocks an allocation — only a live /dev/tcp (or
# PowerShell) probe proving the port is actually bound does.
#
# Port ranges:
#   legacy reserved 6551-6556 (agent-ports.json, old path — untouched here)
#   dynamic        6560-6609 (this lib, new path)
#
# Concurrency primitive: per-port exclusive directory
#   held-port/<port>/
# created with mkdir (atomic EEXIST on the same filesystem). Inside it a
# `meta` file records the holder runtime_id + a `pid` file the proxy PID.
# The holder's clean exit removes the dir (release); the reaper is the
# backstop that sweeps dirs whose proxy PID is provably dead.
#
# PID validation (Atlas §2.3): a recorded proxy_pid is "alive" only when BOTH
# `kill -0 <pid>` succeeds AND /proc/<pid>/exe resolves to a node binary —
# guarding against PID reuse by an unrelated process after the real proxy
# died. On Windows the proxy is a WSL node process, so /proc is authoritative.

# Dynamic pool bounds. The legacy reserved range (6551-6556) is intentionally
# NOT exported here — this lib never allocates from it.
PORT_DYNAMIC_MIN=6560
PORT_DYNAMIC_MAX=6609

# Cross-runtime cooldown after a port is released before a DIFFERENT runtime
# may re-grant it. Same-runtime reuse (respawn) skips the cooldown entirely.
PORT_COOLDOWN_SEC=60

# Decision-tree tunables (Atlas §2.3). The bash lib does not consume these —
# they are the single source the Node proxy mirrors for the wait-for-release /
# respawn / takeover loops, kept here so the shell + Node layers agree.
PORT_RESPAWN_WINDOW_MS=8000     # base respawn window; caller doubles per round
PORT_TAKEOVER_TIMEOUT_MS=300000 # PID-alive same-runtime hot takeover cap
PORT_PROBE_INTERVAL_MS=1000     # wait-for-release poll cadence
export PORT_RESPAWN_WINDOW_MS PORT_TAKEOVER_TIMEOUT_MS PORT_PROBE_INTERVAL_MS

# Resolve powershell.exe once (same pattern as the launcher) so the port probe
# can see a Windows-bound editor port that WSL `ss` cannot.
_ARBITER_POWERSHELL=""
if command -v powershell.exe >/dev/null 2>&1; then
    _ARBITER_POWERSHELL="powershell.exe"
elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then
    _ARBITER_POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
fi

# Directory that holds the per-port arbitration dirs. Tests override via
# KOL_PORT_HELD_DIR. MUST be a machine-global path (Atlas Final Review D6+D7):
# port arbitration is a CROSS-RUNTIME coordination primitive — two slots of
# the same agent run in different worktrees, so a per-worktree ${SCRIPT_DIR}
# held dir lets both mkdir-succeed on the SAME dynamic port (~10s editor-bind
# hot window). The proxy also invokes this lib via `bash -c 'source ...'`
# where SCRIPT_DIR is undefined → ${SCRIPT_DIR}/held-port resolved to
# /held-port and every busy port verdict degraded to `evict`. ${HOME} is
# always set in a login/cron/systemd context, so ~/.multica is the one path
# every caller (launcher, proxy, reaper backstop) shares on one machine.
port_arbiter_held_dir() {
    printf '%s\n' "${KOL_PORT_HELD_DIR:-${HOME}/.multica/godot-mcp-held}"
}

# --- port_arbiter_port_bound <port> -------------------------------------------
# Probe whether the port is actually bound by ANY holder (Windows editor or
# otherwise). Returns 0 when bound, 1 when free / undeterminable-free.
# SEE-1242 B-2: /dev/tcp connect probe FIRST (millisecond-scale; it reaches
# both Linux-side listeners on 127.0.0.1 and the Windows editor's listener on
# the WSL vEthernet gateway IP — GODOT_HOST mirrors what the client connects
# to, per SEE-1070 "WSL trusts /dev/tcp, not ss"). PowerShell
# (Get-NetTCPConnection) remains as the fallback for hosts where /dev/tcp
# cannot probe (e.g. restricted WSL1), because a Windows listener was
# previously invisible to `ss`. When nothing is available, assume FREE
# (never block startup on an undeterminable probe). Atlas Final Review LOW-3:
# a PowerShell failure (non-zero exit / no output) is ALSO treated as free —
# this is safe because the mkdir arbitration in port_arbiter_try_acquire is
# the second gate: a port that is genuinely bound but read as free still
# cannot be double-granted (EEXIST on the same-port held dir, or the holder's
# live proxy PID in the meta). The probe only ever narrows false-evict, never
# widens a real collision.
port_arbiter_port_bound() {
    local p="$1"
    # /dev/tcp connect probe against the resolved host (the addon binds the
    # WSL vEthernet IP; GODOT_HOST mirrors what the client connects to) AND
    # loopback (a Linux-side proxy/listener binds 127.0.0.1). Either hit =
    # bound; both misses = free-ish (mkdir arbitration is the second gate).
    # SEE-1242 B-2: each probe is wrapped in a hard timeout — a Windows host
    # that silently DROPS the SYN (firewall / no listener on the gateway IP)
    # never sends RST, and an unwrapped /dev/tcp would hang forever. A
    # timeout-miss reads as free: the mkdir arbitration is the second gate
    # (narrows false-evict, never widens a real collision — LOW-3).
    local host="${GODOT_HOST:-127.0.0.1}"
    if [[ "$host" != "127.0.0.1" ]]; then
        if timeout "${PORT_PROBE_TIMEOUT_SEC:-1}" bash -c "exec 3<>/dev/tcp/127.0.0.1/${p}" 2>/dev/null; then
            exec 3>&- 3<&- 2>/dev/null || true
            return 0
        fi
    fi
    if timeout "${PORT_PROBE_TIMEOUT_SEC:-1}" bash -c "exec 3<>/dev/tcp/${host}/${p}" 2>/dev/null; then
        exec 3>&- 3<&- 2>/dev/null || true
        return 0
    fi
    if [[ -n "${_ARBITER_POWERSHELL:-}" ]]; then
        if "$_ARBITER_POWERSHELL" -NoProfile -Command \
            "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" \
            2>/dev/null; then
            return 0
        fi
        return 1
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -H -tln 2>/dev/null | grep -qE ":${p}\\b" && return 0
        return 1
    fi
    return 1
}

# --- port_arbiter_pid_alive <pid> ---------------------------------------------
# kill -0 + /proc/<pid>/exe node check. Returns 0 only when the PID exists AND
# is a node process (anti PID-reuse). On a system without /proc (defensive),
# falls back to kill -0 alone.
#
# KOL_PORT_ARBITER_TEST_PID_NODE (test seam, SEE-1152 registry-sweep tests):
# a space-separated pid list force-treated as node WITHOUT the /proc exe
# readlink. A sandboxed test cannot make its own PID readlink to "node"
# (its /proc/self/exe is bash), so without this seam the "live node entry is
# KEPT" case is untestable through the real reaper binary. The seam lives in
# THIS function (not in the reaper) so reaper and arbiter stay on one
# liveness implementation — Atlas 子步骤约束4. Production never sets it.
port_arbiter_pid_alive() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    if [[ -n "${KOL_PORT_ARBITER_TEST_PID_NODE:-}" ]]; then
        local _tn
        for _tn in ${KOL_PORT_ARBITER_TEST_PID_NODE}; do
            [[ "$pid" == "$_tn" ]] && return 0
        done
    fi
    if [[ -e "/proc/${pid}/exe" ]]; then
        local exe
        exe="$(readlink "/proc/${pid}/exe" 2>/dev/null || echo "")"
        [[ "$exe" == *node* ]] || return 1
    fi
    return 0
}

# --- port_arbiter_decide <port> <runtime_id> ----------------------------------
# The reuse/evict decision tree for a busy port. Prints ONE of:
#   free            — port not bound; caller may grant it
#   reuse           — holder proxy alive, SAME runtime → hot takeover path
#   respawn         — holder proxy dead, SAME runtime id → wait-for-release
#                     (respawn window); evict only if the window expires
#   evict           — holder proxy dead, runtime id mismatch/missing →
#                     immediate evict (kill editor, cold-start), no wait
#   busy_foreign    — holder proxy alive, DIFFERENT runtime → editor_busy
#                     retryable
# Reads the holder identity from the per-port held dir meta + pid files; a
# held dir whose recorded PID is dead is treated as STALE (proxy died without
# releasing) → its runtime match decides respawn vs evict.
port_arbiter_decide() {
    local port="$1" rid="$2"
    local held holder_rid holder_pid
    held="$(port_arbiter_held_dir)/${port}"
    if ! port_arbiter_port_bound "$port"; then
        # Not bound at the OS level — the port is grantable regardless of any
        # stale held-dir residue (registry is an acceleration layer, not truth).
        printf 'free\n'
        return 0
    fi
    holder_rid=""
    holder_pid=""
    if [[ -f "${held}/meta" ]]; then
        holder_rid="$(sed -n 's/^runtime_id=//p' "${held}/meta" 2>/dev/null | head -1)"
    fi
    if [[ -f "${held}/pid" ]]; then
        holder_pid="$(tr -d '[:space:]' < "${held}/pid" 2>/dev/null || echo "")"
    fi
    local alive=0
    [[ -n "$holder_pid" ]] && port_arbiter_pid_alive "$holder_pid" && alive=1
    if (( alive == 1 )); then
        if [[ -n "$rid" && "$holder_rid" == "$rid" ]]; then
            printf 'reuse\n'
        else
            printf 'busy_foreign\n'
        fi
        return 0
    fi
    # Proxy PID dead (or unreadable). Same runtime id → this is a respawn in
    # progress; a mismatched / missing id is a cross-runtime stale holder.
    if [[ -n "$rid" && -n "$holder_rid" && "$holder_rid" == "$rid" ]]; then
        printf 'respawn\n'
    else
        printf 'evict\n'
    fi
    return 0
}

# --- port_arbiter_try_acquire <port> <runtime_id> <proxy_pid> -----------------
# Attempt to grant ONE port to a runtime via per-port mkdir arbitration.
# Honors the cross-runtime cooldown: if the held dir exists, its meta
# released_at / mtime is within PORT_COOLDOWN_SEC, and the holder runtime_id
# differs from the requester, the port is still cooling — try the next
# candidate. Same-runtime re-acquire always succeeds (respawn skips cooldown).
# Returns 0 (granted) or 1 (contended / cooling).
port_arbiter_try_acquire() {
    local port="$1" rid="$2" proxy_pid="$3"
    local held now holder_rid rel_mtime age
    held="$(port_arbiter_held_dir)/${port}"
    if mkdir "$held" 2>/dev/null; then
        printf 'runtime_id=%s\n' "$rid" > "${held}/meta"
        printf '%s\n' "$proxy_pid" > "${held}/pid"
        return 0
    fi
    # Held dir exists — inspect the holder. Same runtime: a respawn reclaiming
    # its own still-warm port (the prior holder released via the backstop but
    # the dir lingered). Take it over.
    holder_rid=""
    [[ -f "${held}/meta" ]] && holder_rid="$(sed -n 's/^runtime_id=//p' "${held}/meta" 2>/dev/null | head -1)"
    if [[ -n "$rid" && "$holder_rid" == "$rid" ]]; then
        rm -rf "$held" 2>/dev/null || true
        if mkdir "$held" 2>/dev/null; then
            printf 'runtime_id=%s\n' "$rid" > "${held}/meta"
            printf '%s\n' "$proxy_pid" > "${held}/pid"
            return 0
        fi
        return 1
    fi
    # Cross-runtime: honor the cooldown — a freshly-released port stays off
    # limits to a different runtime for PORT_COOLDOWN_SEC.
    rel_mtime="$(stat -c %Y "$held" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    age=$(( now - rel_mtime ))
    if (( age < PORT_COOLDOWN_SEC )); then
        return 1   # cooling — loser moves to the next candidate
    fi
    # Cooldown expired and the holder is a different runtime whose proxy is
    # dead (the dir would have been removed on a clean release): stale —
    # reclaim it.
    local holder_pid=""
    [[ -f "${held}/pid" ]] && holder_pid="$(tr -d '[:space:]' < "${held}/pid" 2>/dev/null || echo "")"
    if [[ -n "$holder_pid" ]] && port_arbiter_pid_alive "$holder_pid"; then
        return 1   # genuinely held by a live different runtime
    fi
    rm -rf "$held" 2>/dev/null || true
    if mkdir "$held" 2>/dev/null; then
        printf 'runtime_id=%s\n' "$rid" > "${held}/meta"
        printf '%s\n' "$proxy_pid" > "${held}/pid"
        return 0
    fi
    return 1
}

# --- port_arbiter_release <port> ----------------------------------------------
# Release a granted port: stamp released_at in the meta (for the cooldown
# window) then remove the held dir. Idempotent.
port_arbiter_release() {
    local port="$1"
    local held
    held="$(port_arbiter_held_dir)/${port}"
    [[ -d "$held" ]] || return 0
    printf 'released_at=%s\n' "$(date +%s)" >> "${held}/meta" 2>/dev/null || true
    rm -rf "$held" 2>/dev/null || true
    return 0
}

# --- port_arbiter_ensure <runtime_id> <proxy_pid> ------------------------------
# Allocate a port for a runtime from the dynamic pool. Per-port mkdir
# arbitration (no global lock): try each candidate in order, the loser moves
# to the next. Once a port is granted, record the grant in the registry under
# a SHORT flock critical section (flock -n 9 — a contended registry write
# never blocks the grant, because the sidecar/held-dir is the truth and the
# registry is only an acceleration layer). Prints the granted port; returns 1
# when the pool is exhausted.
port_arbiter_ensure() {
    local rid="$1" proxy_pid="$2"
    local port
    mkdir -p "$(port_arbiter_held_dir)" 2>/dev/null || true
    # Same-runtime reuse FIRST (Atlas Final Review MEDIUM-3): a warm restart
    # of the same slot must reclaim its OWN held port before scanning the
    # pool, otherwise every restart burns a fresh port and the pool drifts
    # toward exhaustion. try_acquire's same-runtime branch releases the
    # reclaim instantly (cooldown skipped). A dir whose recorded PID is dead
    # is a stale reclaim (respawn re-grabbing its own still-warm port) — also
    # valid to take over.
    if [[ -n "$rid" ]]; then
        local _h _hrid
        for _h in "$(port_arbiter_held_dir)"/*/; do
            [[ -d "$_h" ]] || continue
            port="$(basename "$_h")"
            [[ "$port" =~ ^[0-9]+$ ]] || continue
            (( port >= PORT_DYNAMIC_MIN && port <= PORT_DYNAMIC_MAX )) || continue
            _hrid=""
            [[ -f "${_h}meta" ]] && _hrid="$(sed -n 's/^runtime_id=//p' "${_h}meta" 2>/dev/null | head -1)"
            [[ "$_hrid" == "$rid" ]] || continue
            if port_arbiter_try_acquire "$port" "$rid" "$proxy_pid"; then
                port_arbiter_registry_record "$rid" "$port" "$proxy_pid" 2>/dev/null || true
                printf '%s\n' "$port"
                return 0
            fi
        done
    fi
    for (( port = PORT_DYNAMIC_MIN; port <= PORT_DYNAMIC_MAX; port++ )); do
        # Skip ports actually bound by a foreign (non-registry) holder.
        if port_arbiter_port_bound "$port"; then
            local decision
            decision="$(port_arbiter_decide "$port" "$rid")"
            [[ "$decision" == "free" ]] || continue
        fi
        if port_arbiter_try_acquire "$port" "$rid" "$proxy_pid"; then
            # Registry is the acceleration layer: record the grant under a
            # short non-blocking flock. A lost lock only skips the registry
            # write — the held dir + sidecar remain the truth.
            port_arbiter_registry_record "$rid" "$port" "$proxy_pid" 2>/dev/null || true
            printf '%s\n' "$port"
            return 0
        fi
    done
    return 1
}

# --- port_arbiter_registry_record <rid> <port> <proxy_pid> --------------------
# Record a granted port in the registry inside a SHORT non-blocking flock
# critical section (exec 9>LOCK; flock -n 9). fd 9 never crosses an exec; the
# critical section spawns no long-lived process. A lost lock skips the write
# (registry is best-effort acceleration, never a grant gate). Reuses the P1
# registry path + mktemp+mv atomic publish — no new lock mechanism.
port_arbiter_registry_record() {
    local rid="$1" port="$2" proxy_pid="$3"
    command -v node >/dev/null 2>&1 || return 0
    local dir="${HOME}/.multica"
    local path="${dir}/godot-port-registry.json"
    local lock="${path}.lock"
    mkdir -p "$dir" 2>/dev/null || return 0
    : > "$lock" 2>/dev/null || return 0
    exec 9>"$lock"
    if ! flock -n 9; then
        exec 9>&-
        return 0   # contended — skip the acceleration write, grant already holds
    fi
    local tmp
    tmp="$(mktemp "${dir}/.godot-port-registry.XXXXXX.tmp")"
    REG_PATH="$path" REG_RID="$rid" REG_PORT="$port" REG_PID="$proxy_pid" \
    node -e '
        const fs = require("fs");
        const out = { schema_version: 1, updated_at: new Date().toISOString(), entries: {} };
        try {
            const cur = JSON.parse(fs.readFileSync(process.env.REG_PATH, "utf8"));
            if (cur && cur.entries && typeof cur.entries === "object") out.entries = cur.entries;
        } catch (e) {}
        const prev = (out.entries[process.env.REG_RID] && typeof out.entries[process.env.REG_RID] === "object")
            ? out.entries[process.env.REG_RID] : {};
        out.entries[process.env.REG_RID] = Object.assign({}, prev, {
            port: Number(process.env.REG_PORT),
            proxy_pid: Number(process.env.REG_PID),
            heartbeat_at: new Date().toISOString(),
        });
        fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n", "utf8");
    ' "$tmp" 2>/dev/null || true
    chmod 0644 "$tmp" 2>/dev/null || true
    mv "$tmp" "$path" 2>/dev/null || true
    exec 9>&-
    return 0
}
