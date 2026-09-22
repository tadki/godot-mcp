#!/usr/bin/env bash
# SEE-1129 boundary matrix cases #2 / #8 / #9 — startup stale-lease reaper.
#
# Scans every mcp-lease.json under a workspace root and reaps leases that claim
# to be "active" but whose owning process is gone (abnormal exit: SIGKILL, OOM,
# crash, daemon kill -9 — case #2), or whose sidecar is corrupt/half-written
# (case #8). Also sweeps the 9 (actually more) stale leases already on disk
# from prior crashed runs (case #9). For each reaped lease it additionally
# kills the orphaned Godot editor process the dead agent started (principle #3
# on startup, not just on clean task exit).
#
# "Stale active" detection (any one triggers reap):
#   A. configured_by_pid is set AND that PID is not alive (kill -0 fails).
#   B. the label's editor pidfile points at a dead PID, or the port has no
#      listener at all (state=active but port cold = nothing could be holding).
#   C. the sidecar JSON fails to parse / missing required fields (case #8).
#
# Sidecar schema version handling (SEE-1148 P1):
#   - schema_version=1 (legacy): parsed normally; participates in grace guard.
#   - schema_version=2 (P1): parsed normally; runtime_id/task_id are read
#     for logging, do not affect the grace decision.
#   - schema_version absent / pre-v1: QUARANTINED, never silently reaped and
#     never silently migrated. Pre-v1 sidecars are treated as opaque garbage
#     and moved aside (no field-shape inference). This is the safe default:
#     we cannot assume what an unknown older producer meant by its fields,
#     so we err on the side of preserving the original bytes for forensic
#     recovery rather than guessing. See quarantine-dir naming below.
#   - schema_version=99 / unknown future version: QUARANTINED with a log
#     line tagged `schema_version_unexpected` — does NOT crash, does NOT
#     reaps silently. Operator can inspect the quarantine dir and decide.
#
# Layer contract: touches ONLY the release layer — reuses restore-godot-original.sh
# and stop-godot-editor.sh. The addon and proxy upstream protocol are untouched.
#
# Usage:
#   reap-stale-leases.sh                          # scan $HOME/multica_workspaces
#   reap-stale-leases.sh --root <workspace-root>  # scan a specific root
#   reap-stale-leases.sh --dry-run                # report only, no writes/kills
#   reap-stale-leases.sh -h|--help
#
# Safety: this script WRITES (lease transitions to released) and KILLS
# (orphaned editor PIDs) by default. Pass --dry-run first to see what
# would happen. The WARNING below is non-aborting — operator explicit
# confirmation pattern (cf. `git push --force`).
#
# Exit codes: 0 ok (always — staleness is normal, not an error).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mcp-sidecar.lib.sh
source "$SCRIPT_DIR/mcp-sidecar.lib.sh"
# shellcheck source=agent-ports.lib.sh
source "$SCRIPT_DIR/agent-ports.lib.sh"
# SEE-1148 P1: lifecycle file paths (directory + legacy flat).
# shellcheck source=runtime.lib.sh
source "$SCRIPT_DIR/runtime.lib.sh"
# SEE-1148 P2: arbiter PID-liveness standard (kill -0 + /proc/<pid>/exe node
# check) — the registry sweep reuses it verbatim so a registry entry is judged
# by the same rule the arbiter uses to judge a held dir (Atlas 子步骤约束4:
# PID 活性校验必须与 arbiter 同标准, 防 PID 复用误删).
# shellcheck source=port-arbiter.lib.sh
source "$SCRIPT_DIR/port-arbiter.lib.sh"
# Registry schema + flock protocol (port_registry_delete serializes against
# concurrent proxy heartbeat upserts via the shared .lock — no new lock).
# shellcheck source=port-registry.lib.sh
source "$SCRIPT_DIR/port-registry.lib.sh"
MULTICA_DIR="${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}"

print_usage() {
    cat <<'EOF'
Usage: reap-stale-leases.sh [--root <workspace-root>] [--dry-run] [-h|--help]

Scan for stale mcp-lease.json sidecars (state=active but owner gone, or corrupt)
and release them + kill their orphaned editor. Safe to run at every cold start.

Arguments:
  --root <path>   Workspace root to scan (default: $HOME/multica_workspaces).
  --dry-run       Report what would be reaped without writing/killing.
  -h, --help      Show this help.

Also sweeps $GODOT_MCP_HOME/godot-port-registry.json for entries whose proxy_pid is
dead (arbiter liveness standard: kill -0 + /proc/<pid>/exe must be node).
Deletes go through port-registry.lib.sh's flock protocol. Disable with
KOL_REAP_REGISTRY=0.

Also sweeps dead held-lock dirs: per-runtime launcher locks under
.dev/godot-mcp/launch/held/<runtime_id>/ and per-port arbiter grants under
$GODOT_MCP_HOME/godot-mcp-held/<port>/ (same arbiter liveness standard; live dirs
are never removed). Disable with KOL_REAP_HELD=0.
EOF
}

ROOT="${HOME}/multica_workspaces"
DRY_RUN=0
while (( $# > 0 )); do
    case "$1" in
        -h|--help) print_usage; exit 0 ;;
        --root) (( $# >= 2 )) || { echo "--root requires a value" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
        --root=*) ROOT="${1#--root=}"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

# node is required to validate JSON + read fields (matches mcp-sidecar.lib.sh).
command -v node >/dev/null 2>&1 || { echo "[reap-stale-leases] node not found; cannot validate sidecars; aborting (no-op)." >&2; exit 0; }
# Resolve powershell.exe: prefer PATH, else the well-known System32 location
# (same fallback as start-godot-editor.sh:37-40). The resident reaper runs under
# a systemd user timer whose PATH omits /mnt/c/...; without the fallback every
# Windows-process sweep silently goes blind (Revy D1, HIGH).
# KOL_REAP_DISABLE_PWSH=1 force-disables the Windows paths — for hermetic test
# suites only: with the fallback active a reaper run against a real WSL+Windows
# host does 3 live Get-CimInstance sweeps (~15s each on a busy machine), which
# would dominate the runtime of tests that invoke the reaper repeatedly.
POWERSHELL=""
if [[ "${KOL_REAP_DISABLE_PWSH:-0}" == "1" ]]; then
    HAVE_PWSH=0
elif command -v powershell.exe >/dev/null 2>&1; then
    POWERSHELL="powershell.exe"; HAVE_PWSH=1
elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then
    POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"; HAVE_PWSH=1
else
    HAVE_PWSH=0
fi

# Archi runbook §5.5 anchor: print pwsh resolution state on every invocation so
# owners can grep the resident-reaper journal for `pwsh=` to detect path-blindness
# (`journalctl --user -u godot-mcp-reaper.service | grep 'pwsh='`).
echo "[reap-stale-leases] root=${ROOT} dry_run=${DRY_RUN} pwsh=${HAVE_PWSH} path=${POWERSHELL:-none}"

# D5 (Revy P4, CRITICAL — Archi wrapper 方案, Atlas 裁定): WSL interop 的
# powershell.exe 会继承并消费调用 shell 的 stdin。per-lease while-read 循环
# (`while read < <(find ...)`) 的 fd 被循环体内的 powershell probe 吃光后循环
# 提前终止——reaper 每个 run 只处理第一条 lease。stdin 保护必须在单一入口
# 闭合（与 F13 正则单一源同理），未来新增调用点无法绕过。
# return 而非 exit：不吞调用方的 $? 判断（Atlas 提示）。
pwsh() { "$POWERSHELL" -NoProfile "$@" </dev/null; }

# SEE-1148 P1 follow-up (Revy review §A0, MEDIUM): require an explicit
# acknowledgement before a LIVE reap runs. Reaper writes (lease transition
# to released, sidecar state change) and kills (orphaned editor PIDs);
# those are the same actions a fresh shell session can take accidentally
# if DRY_RUN=0 leaks via `source` (a real failure observed during P1
# self-test — see Revy report §A0). Print a loud warning to stderr but
# do not abort: the operator's "dry-run first" workflow expects the
# warning AND the run, just like `git push --force`. Skip when the
# operator already opted into live mode by passing --dry-run=false via
# DRY_RUN=1 in the environment (some wrappers do that).
if (( DRY_RUN == 0 )); then
    if [[ "${KOL_REAP_RESIDENT:-0}" == "1" ]]; then
        # Atlas Final Review MEDIUM-4: a resident (systemd-timer) run is
        # unattended by definition — nobody is watching the journal to
        # Ctrl-C, so the 3s abort window is pure per-tick noise. The operator
        # already armed live mode explicitly via the mode file
        # (resident-reaper.sh exports KOL_REAP_RESIDENT=1).
        echo "[reap-stale-leases] resident live mode — skipping Ctrl-C abort window (unattended)." >&2
    else
    echo "[reap-stale-leases] WARNING: LIVE reap mode — will WRITE lease transitions and KILL orphaned editor PIDs." >&2
    echo "[reap-stale-leases] WARNING: pass --dry-run first to preview without side effects." >&2
    echo "[reap-stale-leases] WARNING: starting LIVE reap in 3s — press Ctrl-C to abort." >&2
    # A0 (Atlas P1 FAIL 修订决策): a 3s abort window with a loud message,
    # like `git push --force` / `rm -rf` confirmation. Operators who
    # accidentally invoke without --dry-run (the exact failure Revy's §A0
    # caught when `source` leaked DRY_RUN=0) get a chance to Ctrl-C.
    # Archi 加固版: trap INT/TERM so a signal DURING the sleep aborts
    # immediately (exit 130) instead of running the live reap anyway.
    trap 'echo "[reap-stale-leases] INTERRUPTED — aborting before any side effect." >&2; exit 130' INT TERM
    sleep 3
    trap - INT TERM
    fi
fi

REAPED=0
SKIPPED=0
TOTAL=0

# pid_alive <pid>: 0 if alive, 1 if dead/malformed. On WSL the recorded PID is
# the Windows Godot PID; a native kill -0 on it from WSL returns "No such
# process" even when the Windows process is live. So when powershell.exe is
# available, ask Windows whether the PID is a live process.
pid_alive() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    if (( HAVE_PWSH )); then
        # D5b (Revy P4): NO $?-based probe — with -ErrorAction SilentlyContinue
        # $? is true even when nothing matched, so "exit [bool]$?" always exits 0
        # and every PID reads as alive (staleness never triggers). The count probe
        # is the only correct form. < /dev/null per D5 below.
        # LOW-4 (Atlas Final Review): also fetch the process NAME in the same
        # probe so a PID reused by an unrelated Windows process is not read as
        # "editor alive". The sidecar's editor_pid is always a Godot process —
        # require the name to match godot*/Godot*; an empty name (Access
        # Denied on a protected process) falls through to count-only so we do
        # not false-negative on a real editor we cannot introspect. This is
        # the Windows-side twin of the launcher's /proc/<pid>/exe node check.
        local res n name
        res="$(pwsh -Command "\$p = Get-Process -Id $pid -ErrorAction SilentlyContinue; if (\$p) { Write-Output \"1 \$(\$p.ProcessName)\" } else { Write-Output '0 ' }" 2>/dev/null | tr -d '\r' | head -1)"
        n="${res%% *}"
        name="${res#* }"
        [[ "$n" == "1" ]] || return 1
        if [[ -n "$name" && "$name" != " " ]]; then
            case "${name,,}" in
                godot*) return 0 ;;
                *) return 1 ;;   # PID reused by a non-Godot process
            esac
        fi
        return 0   # count=1 but name unreadable — trust the count probe
    fi
    kill -0 "$pid" 2>/dev/null
}

# kill_editor_pid <pid>: stop a Windows (Stop-Process) or Unix (kill) editor pid.
kill_editor_pid() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 0
    if (( HAVE_PWSH )); then
        pwsh -Command "Stop-Process -Id $pid -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
    else
        kill "$pid" 2>/dev/null || true
    fi
}

# SEE-1316 (hardener): proxy-pid liveness. The recorded proxy_pid is a WSL-side
# node process, so the native kill -0 path is always correct here — the
# Windows/Get-Process branch of pid_alive does NOT apply (that one gates on a
# godot* process name, which a node proxy must not satisfy). PID reuse by a
# non-node process would defeat this check, same residual risk as the editor
# pidfile path; the WSL /proc exe check below closes it where /proc exists.
proxy_pid_alive() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    if [[ -r "/proc/$pid/exe" ]]; then
        # D5-style anti-PID-reuse: the exe target must be a node-ish binary
        # (node / nodejs). Readlink may fail transiently — fall back to kill -0.
        local exe
        exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
        if [[ -n "$exe" ]]; then
            case "${exe,,}" in
                *node*) return 0 ;;
                *) return 1 ;;   # PID reused by a non-node process
            esac
        fi
    fi
    kill -0 "$pid" 2>/dev/null
}

# Walk every mcp-lease.json under ROOT.
while IFS= read -r lease; do
    [[ -n "$lease" ]] || continue
    TOTAL=$((TOTAL+1))
    worktree_dir="$(dirname "$(dirname "$lease")")"   # .../<hash>/workdir/<repo-dirname>
    project_godot="${worktree_dir}/project.godot"

    # Read every field in one node invocation; invalid JSON -> node exits
    # non-zero, which we catch as "corrupt" (case #8). NOTE: this block runs
    # WITHOUT set -e (disabled locally) so a corrupt sidecar's non-zero node
    # exit is handled by the rc check below instead of aborting the whole scan.
    set +e
    fields="$(node -e '
        const fs = require("fs");
        let raw;
        try { raw = fs.readFileSync(process.argv[1], "utf8"); }
        catch (e) { process.stderr.write("unreadable:"+e.message+"\n"); process.exit(3); }
        let o;
        try { o = JSON.parse(raw); }
        catch (e) { process.stderr.write("unparseable:"+e.message+"\n"); process.exit(4); }
        const need = ["schema_version","port","agent","state","lease_id","worktree","configured_by_pid"];
        for (const k of need) {
            if (!(k in o)) { process.stderr.write("missing:"+k+"\n"); process.exit(5); }
        }
        // SEE-1148 P1 schema_version gate: sidecars from this repo ship as v1
        // or v2. Anything else is either a foreign tool or a pre-rollback artifact
        // — quarantine instead of guessing the field layout. v2 added runtime_id /
        // task_id, so older code paths that read these fields do not break; the
        // gate is informational here, not destructive.
        const sv = Number(o.schema_version);
        if (!(sv === 1 || sv === 2)) {
            process.stderr.write("schema_version_unexpected:"+String(o.schema_version)+"\n");
            process.exit(6);
        }
        process.stdout.write(JSON.stringify({
            schema_version: sv,
            runtime_id: String(o.runtime_id||""),
            task_id: String(o.task_id||""),
            state: String(o.state||""), port: String(o.port||""), agent: String(o.agent||""),
            pid: o.configured_by_pid==null?"":String(o.configured_by_pid),
            proxy_pid: o.proxy_pid==null?"":String(o.proxy_pid),
            worktree: String(o.worktree||""),
            configured_at: o.configured_at==null?"":String(o.configured_at),
            intentional_release: o.intentional_release===true
        }));
    ' "$lease" 2>"${TMPDIR:-/tmp}/.reap-err.$$")"
    rc=$?
    set -e
    err_msg="$(cat "${TMPDIR:-/tmp}/.reap-err.$$" 2>/dev/null || true)"; rm -f "${TMPDIR:-/tmp}/.reap-err.$$" 2>/dev/null || true

    if (( rc != 0 )); then
        # Case #8: corrupt / half-written / missing fields. Quarantine the bad
        # sidecar (rename to .corrupt-<ts>) so a fresh configure can write a
        # clean one, and report. Never silently delete (operator may want to
        # inspect).
        #
        # SEE-1240 D1 (MEDIUM, QA): the quarantine branch used to rename on
        # EVERY non-zero rc — including rc=3 "unreadable", which covers ENOENT
        # (the file was concurrently renamed by another reaper / the stop hook
        # between find and read) and transient IO errors. A read failure says
        # NOTHING about the file's content: if a concurrent configure has
        # already written a fresh, fully-valid lease at the same path, the
        # unconditional mv quarantined THAT valid active lease (observed live
        # 2026-09-05: two .corrupt-* files with complete parseable JSON, the
        # editor then fell back to port 6550 — exactly the cross-agent port
        # clash WS-2 exists to prevent). Verdict accounting per rc:
        #   rc=3 (unreadable / ENOENT / EACCES / transient IO) → SKIP, never
        #        rename. The next sweep re-reads whatever is at the path then.
        #   rc=4/5/6 (real parse failure / missing fields / unknown schema) →
        #        the CONTENT is provably bad → quarantine as before.
        #
        # SEE-1338 QA defect #2 (LOW): the qa machine STILL quarantined valid
        # leases with complete parseable JSON. Root cause: ANY other node
        # failure (exec/env startup failure, resource pressure) also exits
        # non-zero with an EMPTY err_msg — and fell straight into the
        # quarantine rename. Quarantine now requires an AUTHORITATIVE reason:
        # the node probe itself must name the content defect (unparseable: /
        # missing: / schema_version_unexpected:). Any other failure (empty or
        # foreign stderr) is treated like rc=3 — a transient environment
        # failure is not evidence about the file's content.
        if [[ "$err_msg" == unreadable:* ]]; then
            echo "[reap-stale-leases] READ-FAILED sidecar ($err_msg): $lease — NOT quarantining (D1: read failure ≠ corruption; re-read next sweep)"
            SKIPPED=$((SKIPPED+1))
            continue
        fi
        case "$err_msg" in
            unparseable:*|missing:*|schema_version_unexpected:*) ;;
            *)
                echo "[reap-stale-leases] NODE-FAILED sidecar probe (rc=$rc, err='${err_msg:0:120}'): $lease — NOT quarantining (transient exec failure ≠ corruption; re-read next sweep)"
                SKIPPED=$((SKIPPED+1))
                continue
                ;;
        esac
        echo "[reap-stale-leases] CORRUPT sidecar ($err_msg): $lease"
        if (( DRY_RUN )); then echo "  -> (dry-run) would quarantine"; SKIPPED=$((SKIPPED+1)); continue; fi
        ts="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo stale)"
        mv "$lease" "${lease}.corrupt-${ts}" 2>/dev/null || true
        REAPED=$((REAPED+1))
        continue
    fi

    state="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).state||"")' "$fields" 2>/dev/null || echo "")"
    [[ "$state" == "$SIDECAR_STATE_ACTIVE" ]] || { SKIPPED=$((SKIPPED+1)); continue; }  # released/other — leave alone

    port="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).port||"")' "$fields" 2>/dev/null || echo "")"
    agent="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).agent||"")' "$fields" 2>/dev/null || echo "")"
    cfg_pid="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).pid||"")' "$fields" 2>/dev/null || echo "")"
    lease_wt="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).worktree||"")' "$fields" 2>/dev/null || echo "")"
    configured_at="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).configured_at||"")' "$fields" 2>/dev/null || echo "")"
    # SEE-1148 P1: extract runtime_id (schema v2 field, empty for v1) so the
    # cleanup below can remove directory-form lifecycle files.
    runtime_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runtime_id||"")' "$fields" 2>/dev/null || echo "")"
    intentional_release="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).intentional_release?"true":"")' "$fields" 2>/dev/null || echo "")"
    # SEE-1316 (hardener): the owning proxy's PID (proxy self-registers on warm;
    # null on pre-fix sidecars → the proxy-dead branch is skipped for those).
    proxy_pid="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).proxy_pid||"")' "$fields" 2>/dev/null || echo "")"
    if [[ -z "$runtime_id" ]]; then
        # v1 sidecar — derive runtime_id from worktree so the directory-form
        # files (possibly already written by a P1 re-run on the same slot) are
        # still found.
        runtime_id="$(kol_derive_runtime_id "$agent" "$lease_wt")"
    fi

    # Resolve the editor PID for this runtime (the actual Godot process, not the
    # configure-script PID). Falls back to configure PID when no pidfile.
    #
    # F3 二次修复 (Revy P1 复测 §editor_pid): read via kol_lifecycle_path so a
    # P1 slot resolves the DIRECTORY-form (per-runtime) pidfile, not the
    # legacy FLAT (per-label) one. The flat file is shared across concurrent
    # slots of the same agent — reading it here would make slot1's reaper
    # evaluate staleness against slot2's PID.
    label="$(echo "$agent" | tr '[:upper:]' '[:lower:]')"
    editor_pid=""
    pid_path="$(kol_lifecycle_path ".pid" "$label" "$runtime_id")"
    if [[ -f "$pid_path" ]]; then
        editor_pid="$(tr -d '[:space:]' <"$pid_path" 2>/dev/null || echo "")"
    fi
    [[ -n "$editor_pid" ]] || editor_pid="$cfg_pid"

    # Stale? A: configure PID dead AND editor pidfile dead/absent.
    cfg_dead=0; ed_dead=0
    [[ -z "$cfg_pid" ]]     || { pid_alive "$cfg_pid"     || cfg_dead=1; }
    [[ -z "$editor_pid" ]]  || { pid_alive "$editor_pid" || ed_dead=1; }
    # B: port cold (no listener) while lease claims active.
    port_cold=0
    if [[ -n "$port" ]] && command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | awk '$4 ~ ":'"$port"'$"{found=1} END{exit !found}' || port_cold=1
    fi

    is_stale=0
    reason=""

    # SEE-1134 release-after-start guard: never reap a FRESH lease. During
    # multi-agent concurrent cold-start, another agent's configure-mcp-port.sh
    # runs this reaper globally while THIS lease's editor is still resolving its
    # Windows PID (start-godot-editor.sh writes 'pending' to the pidfile until
    # CIM reports the real PID). 'pending' fails the ^[0-9]+$ regex in
    # pid_alive → looks dead, and configured_by_pid is ALWAYS dead post-exit
    # (it is the configure shell, SIDE_PID=$$). Without this guard the
    # concurrent reaper releases a perfectly good active lease → the editor
    # reads no port → falls back to 6550 → port clash. The only signal that
    # distinguishes "fresh, editor still resolving" from "stale, prior crash"
    # is HOW LONG AGO the lease was written, so configured_at is the gate.
    KOL_REAP_GRACE_S="${KOL_REAP_GRACE_S:-120}"
    # SEE-1148 P3 (§2.5): a lease stamped intentional_release=true by a cleanly-
    # exited proxy SKIPS the fresh-lease grace. The grace exists to protect an
    # editor that is still resolving its PID during cold-start; a deliberate
    # proxy exit is the opposite signal — the slot is done. Reclaim on this
    # sweep instead of waiting out 120s of idle editor nobody is using.
    if [[ "$intentional_release" == "true" ]]; then
        echo "[reap-stale-leases] intentional_release (grace skipped): agent=${agent:-?} port=${port:-?} lease=$lease"
    elif [[ -n "$configured_at" ]]; then
        cfg_epoch="$(date -u -d "$configured_at" +%s 2>/dev/null || echo "")"
        now_epoch="$(date -u +%s 2>/dev/null || echo "")"
        if [[ -n "$cfg_epoch" && -n "$now_epoch" ]]; then
            age_s=$(( now_epoch - cfg_epoch ))
            if (( age_s >= 0 && age_s < KOL_REAP_GRACE_S )); then
                echo "[reap-stale-leases] ACTIVE-fresh (grace ${age_s}s < ${KOL_REAP_GRACE_S}s, kept): agent=${agent:-?} port=${port:-?} lease=$lease"
                SKIPPED=$((SKIPPED+1))
                continue
            fi
        fi
        # Unparseable configured_at or age >= grace: fall through to the PID
        # verdict below. (Malformed timestamp → no special protection, matches
        # pre-fix behavior; very old leases get reaped as before.)
    fi

    # NOTE: do NOT mix [[ ... ]] with (( ... )) inside the same test — bash
    # mis-parses `[[ -z "$x" || (( y )) ]]` (the (( ed_dead )) is treated as a
    # literal pattern, see C3 regression). Use arithmetic context exclusively
    # for the dead-flag checks and plain [[ ]] only for string emptiness.
    # SEE-1148 P3 (§2.5 第二层): intentional_release=true means the proxy that
    # owned this lease exited DELIBERATELY and left the editor idle. The editor
    # is still alive (ed_dead=0) and the port may still be listening, so none of
    # the crash-detection branches below would fire — but the slot is provably
    # unused (its proxy is gone by its own admission). Reclaim: kill the idle
    # editor + release the lease. This is the "正常退出秒级回收" path (T2).
    if [[ "$intentional_release" == "true" ]]; then
        is_stale=1; reason="intentional_release(proxy_exited,runtime=${runtime_id:-?})"
    elif [[ -n "$proxy_pid" ]] && ! proxy_pid_alive "$proxy_pid"; then
        # SEE-1316 (hardener) — reaper contract closure: the lease records its
        # OWNING proxy's PID (proxy self-registers on warm via
        # sidecar_set_proxy_pid). When that PID is dead, the lease has no
        # client-side owner even though the editor itself may still be alive
        # and the port listening — none of the crash branches above can match
        # that shape (cfg_pid is the long-dead configure shell, editor alive,
        # port hot), so a SIGKILLed/abandoned proxy used to strand the editor
        # until the addon's own 45s-stale-client / 120s lease paths ran out.
        # Guarded by the fresh-lease grace above (a just-configured slot whose
        # proxy has not self-registered yet is NOT reaped here: the grace runs
        # before this branch and its SKIP continues out of the loop).
        is_stale=1; reason="proxy_pid_dead(proxy=${proxy_pid},editor=${editor_pid:-none},runtime=${runtime_id:-?})"
    elif (( cfg_dead == 1 )) && { [[ -z "$editor_pid" ]] || (( ed_dead == 1 )); }; then
        is_stale=1; reason="owner_pid_dead(cfg=${cfg_pid:-none},editor=${editor_pid:-none})"
    elif [[ -n "$editor_pid" ]] && (( ed_dead == 1 && cfg_dead == 1 )); then
        is_stale=1; reason="editor+cfg_pid_dead"
    elif [[ -n "$port" ]] && (( port_cold == 1 )) && { [[ -z "$editor_pid" ]] || (( ed_dead == 1 )); }; then
        # active lease, port has no listener, no live editor -> definitely stale.
        is_stale=1; reason="port_cold_no_listener(port=${port})"
    fi

    if (( ! is_stale )); then
        SKIPPED=$((SKIPPED+1))
        echo "[reap-stale-leases] ACTIVE-but-live (kept): agent=${agent:-?} port=${port:-?} lease=$lease"
        continue
    fi

    echo "[reap-stale-leases] STALE ($reason): agent=${agent:-?} port=${port:-?} lease=$lease"
    if (( DRY_RUN )); then echo "  -> (dry-run) would release + kill editor pid=${editor_pid:-none}"; REAPED=$((REAPED+1)); continue; fi

    # Kill the orphaned editor first (principle #3: nobody-using-it editor exits).
    if [[ -n "$editor_pid" ]] && (( ed_dead == 0 )); then
        kill_editor_pid "$editor_pid"
        echo "  -> killed editor pid=$editor_pid"
    else
        echo "  -> editor pid=${editor_pid:-none} already gone"
    fi
    # Release the lease sidecar.
    if [[ -f "$project_godot" ]]; then
        KOL_PROJECT_GODOT="$project_godot" "$SCRIPT_DIR/restore-godot-original.sh" --project-godot "$project_godot" >/dev/null 2>&1 || true
        echo "  -> released sidecar (state=released)"
    else
        # project.godot missing — directly flip the sidecar to released via the lib.
        sidecar_write_released "${worktree_dir}/project.godot" 2>/dev/null || true
        echo "  -> released sidecar (project.godot-absent fast path)"
    fi
    # Clean pid/worktree sidecars so the next start is clean.
    # SEE-1148 P1: also clean the directory-form runtime_id files when the
    # sidecar carries one (schema_version >= 2 records runtime_id explicitly;
    # for v1 we fall back to deriving it from the agent label).
    #
    # F3 二次修复 (Revy P1 复测, 方案A): the legacy FLAT files are keyed by the
    # agent label, which is SHARED across concurrent slots of the same agent
    # (godot-editor-bachi.pid serves both Bachi-fe7bb0db and Bachi-12345678).
    # An 8-hex runtime_id identifies a P1 slot — and a P1 slot NEVER writes the
    # legacy flat files (start-godot-editor.sh writes the directory form via
    # kol_lifecycle_path). So a P1-slot reaper must NEVER delete the legacy
    # flat files: doing so clobbers a CONCURRENT slot's pre-P1 artifact. The
    # 8-hex regex gate was insufficient precisely because both slots are 8-hex
    # yet share one label. Legacy flat cleanup is deferred to a one-time P4
    # migration sweep, not a per-reap action. Directory-form files are
    # per-runtime, always safe to delete.
    RUNTIME_ID_REGEX="$(kol_runtime_id_regex)"
    if [[ -n "${runtime_id:-}" ]] && [[ "${runtime_id}" =~ ${RUNTIME_ID_REGEX} ]]; then
        : # P1 slot: only clean directory-form files below, never legacy flat.
    elif [[ -n "$label" ]]; then
        rm -f "${MULTICA_DIR}/godot-editor-${label}.pid" "${MULTICA_DIR}/godot-editor-${label}.worktree" 2>/dev/null || true
    fi
    if [[ -n "${runtime_id:-}" ]]; then
        rm -f "${MULTICA_DIR}/godot-editor/${runtime_id}.pid" "${MULTICA_DIR}/godot-editor/${runtime_id}.worktree" 2>/dev/null || true
    fi
    REAPED=$((REAPED+1))
done < <(find "$ROOT" -name 'mcp-lease.json' -type f 2>/dev/null || true)

# SEE-1134 residue-editor sweep: an editor can be alive on a tracked port
# while NO lease sidecar mentions that port at all. Causes: the agent crashed
# before configure-mcp-port.sh wrote the sidecar, or the sidecar was lost
# (corrupt + reaper quarantined it but the editor is still up), or the editor
# outlived the lease that owned it (lease released but process never got the
# quit signal because the proxy dropped mid-call). Owner feedback: "6550 端口
# 没人用也没识别出来没有关". The reaper's per-lease loop never sees them (no
# sidecar to iterate) — must scan the port directly.
#
# Safety: only kill if the cmdline carries --kol-mcp-lease, the same gate that
# arms the editor-side lease in plugin.gd._setup_lease(). User-pulled editors
# don't carry the flag → they are NEVER touched by this pass. We also bail
# out if any ACTIVE sidecar mentions the port (the port's owner is some other
# agent; we have no business killing it).
#
# Tracked ports = the addon default (6550) + every entry in .agents.
# Sourcing agent-ports.lib.sh populates AGENT_PORTS. SEE-1240 WS-1: the
# default_port field is GONE from agent-ports.json (dead config — the addon
# hardcodes its own DEFAULT_PORT=6550 and reads nothing from this file), so
# the reaper carries the constant inline: 6550 stays tracked so a residue
# orphan editor bound to the addon default is still swept.
TRACKED_PORTS=(6550)
for _ap_name in "${!AGENT_PORTS[@]}"; do
    TRACKED_PORTS+=("${AGENT_PORTS[$_ap_name]}")
done
# SEE-1148 P1 migration window: the port range is growing from 6550-6556 to
# 6551-6609 (per-runtime ports). Old reapers (pre-P1, still running in
# concurrent slots) only know agent-ports.json; this reaper additionally
# sweeps the full future range so a residue orphan on a not-yet-allocated
# port is still caught. Zero-crossover holds: both reapers only KILL on the
# --kol-mcp-lease cmdline gate + no-active-lease-claim, so extra tracked
# ports cannot touch a legitimate holder.
for _p in $(seq 6551 6609); do
    TRACKED_PORTS+=("$_p")
done
# Dedup so we only scan each port once (default + per-agent overlap is rare
# but harmless to guard against — avoids double-kill log noise on the residue
# pass).
TRACKED_PORTS=($(printf '%s\n' "${TRACKED_PORTS[@]}" | sort -u))

# Has-lease-claim: any active mcp-lease.json anywhere under ROOT mentioning the
# given port. Empty means no agent currently owns it.
port_has_active_lease() {
    local port="$1"
    while IFS= read -r lease; do
        [[ -n "$lease" ]] || continue
        set +e
        local f
        # NOTE: no bare `return` inside the -e body — top-level return is a
        # SyntaxError on node 25, which silently failed every probe (stderr was
        # swallowed by 2>/dev/null) and made every port look unclaimed → the
        # residue pass killed ACTIVE-lease editors. Use a flag + if instead.
        f="$(node -e '
            const fs = require("fs");
            let hit = false;
            try {
                const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                hit = String(o.port||"") === process.argv[2] && String(o.state||"") === "active";
            } catch (_) {}
            if (hit) process.stdout.write("active");
        ' "$lease" "$port" 2>/dev/null)"
        set -e
        [[ "$f" == "active" ]] && return 0
    done < <(find "$ROOT" -name 'mcp-lease.json' -type f 2>/dev/null || true)
    return 1
}

# list_kol_lease_pids_on_port <port>: echo Windows PIDs (one per line) that
# own the given LISTENING socket on Windows AND whose cmdline carries the
# --kol-mcp-lease flag. SEE-1148 P1: P1 editors additionally carry
# --kol-mcp-runtime=<runtime_id> (a second flag, alongside --kol-mcp-lease),
# so the jurisdiction check accepts either flag — migration window requires
# both flags to be recognized, otherwise P1-spawned editors on residue ports
# would be invisible to this pass. Linux-side fallback scans /proc/*/cmdline.
list_kol_lease_pids_on_port() {
    local port="$1"
    if (( HAVE_PWSH )); then
        pwsh -Command "
            \$conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue;
            if (-not \$conn) { exit; }
            \$conn | ForEach-Object {
                \$pid = \$_.OwningProcess;
                \$p = Get-CimInstance Win32_Process -Filter \"ProcessId = \$pid\" -ErrorAction SilentlyContinue;
                if (\$p -and \$p.CommandLine -and (\$p.CommandLine -like '*--kol-mcp-lease*' -or \$p.CommandLine -like '*--kol-mcp-runtime*')) {
                    Write-Output \$pid;
                }
            }
        " 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
    else
        return 0
    fi
}

RESIDUE_KILLED=0
for port in "${TRACKED_PORTS[@]}"; do
    # Build the comma-separated port list for ss (kept here for the rare pure
    # Linux case; the Windows path uses Get-NetTCPConnection per port above).
    [[ -n "$port" ]] || continue
    # If any active lease claims this port, the editor belongs to someone.
    if port_has_active_lease "$port"; then
        continue
    fi
    # No claim → any godot-editor on the port is a residue orphan.
    mapfile -t residue_pids < <(list_kol_lease_pids_on_port "$port" | sort -u)
    for rpid in "${residue_pids[@]}"; do
        [[ -n "$rpid" ]] || continue
        echo "[reap-stale-leases] RESIDUE editor on port=${port} (no active lease claims it; cmdline carries --kol-mcp-lease); pid=${rpid}"
        if (( DRY_RUN )); then
            echo "  -> (dry-run) would kill pid=${rpid}"
            RESIDUE_KILLED=$((RESIDUE_KILLED+1))
            continue
        fi
        kill_editor_pid "$rpid"
        echo "  -> killed pid=${rpid}"
        RESIDUE_KILLED=$((RESIDUE_KILLED+1))
    done
done

# SEE-1137 headless orphan sweep: agents run one-shot debug/probe scripts as
# `godot --headless -s foo.gd` (smoke tests, perf probes). When the enclosing
# agent Bash call hits its timeout (590s) or the run is aborted, the WSL side
# dies but the spawned Windows Godot process is NOT in the WSL process group —
# it outlives the run as a CPU-burning orphan (observed live: 16 such processes
# with 2000-3600s cumulative CPU). The residue pass above only sweeps EDITORS
# (cmdline must carry --kol-mcp-lease), so headless orphans were invisible.
#
# Sweep rule: cmdline carries --headless, does NOT carry --kol-mcp-lease (lease
# editors are never headless in this repo, and user-pulled editors/tests have
# neither flag), and age >= KOL_REAP_HEADLESS_GRACE_M minutes (default 30 —
# long enough for the slowest GUT/perf run, well under the hours-long orphans
# seen live). Editors (no --headless) and the remote-debug game child
# (no --headless) are untouched.
KOL_REAP_HEADLESS_GRACE_M="${KOL_REAP_HEADLESS_GRACE_M:-30}"
HEADLESS_KILLED=0
list_headless_orphans() {
    local grace_m="$1"
    if (( HAVE_PWSH )); then
        pwsh -Command "
            \$cutoff = (Get-Date).AddMinutes(-$grace_m);
            Get-CimInstance Win32_Process -Filter \"Name like '%godot%'\" | Where-Object {
                \$_.CommandLine -match '--headless' -and
                \$_.CommandLine -notmatch 'kol-mcp-lease' -and
                \$_.CommandLine -notmatch 'kol-mcp-runtime' -and
                \$_.CreationDate -lt \$cutoff
            } | ForEach-Object { Write-Output \$_.ProcessId }
        " 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
    else
        # Linux: scan /proc for headless godot cmdlines older than grace.
        # Exclude both --kol-mcp-lease AND --kol-mcp-runtime so a P1-tagged
        # headless probe is the residue pass's problem (cmdline gate), not
        # this sweep's.
        local now cutoff_mtime pid start_ticks
        now="$(date +%s)"
        for pdir in /proc/[0-9]*; do
            pid="${pdir#/proc/}"
            [[ -r "$pdir/cmdline" ]] || continue
            cmdline="$(tr '\0' ' ' <"$pdir/cmdline" 2>/dev/null || true)"
            [[ "$cmdline" == *godot* ]] || continue
            [[ "$cmdline" == *--headless* ]] || continue
            [[ "$cmdline" == *kol-mcp-lease* ]] && continue
            [[ "$cmdline" == *kol-mcp-runtime* ]] && continue
            start_ticks="$(awk '{print $22}' "$pdir/stat" 2>/dev/null || echo 0)"
            [[ "$start_ticks" =~ ^[0-9]+$ ]] || continue
            boot_time="$(awk '/btime/{print $2}' /proc/stat 2>/dev/null || echo 0)"
            hertz=100
            start_epoch=$(( boot_time + start_ticks / hertz ))
            age_m=$(( (now - start_epoch) / 60 ))
            (( age_m >= grace_m )) && echo "$pid"
        done
    fi
}
if (( HAVE_PWSH )) || [[ -d /proc ]]; then
    mapfile -t headless_pids < <(list_headless_orphans "$KOL_REAP_HEADLESS_GRACE_M" | sort -u)
    for hpid in "${headless_pids[@]}"; do
        [[ -n "$hpid" ]] || continue
        echo "[reap-stale-leases] HEADLESS-ORPHAN pid=${hpid} (age >= ${KOL_REAP_HEADLESS_GRACE_M}m, cmdline --headless without --kol-mcp-lease)"
        if (( DRY_RUN )); then
            echo "  -> (dry-run) would kill pid=${hpid}"
            HEADLESS_KILLED=$((HEADLESS_KILLED+1))
            continue
        fi
        kill_editor_pid "$hpid"
        echo "  -> killed pid=${hpid}"
        HEADLESS_KILLED=$((HEADLESS_KILLED+1))
    done
fi

# SEE-1148 P3 T23 (P0 取证 可疑点 #3): GUI Godot with NO LISTEN socket orphan.
# A GUI editor (non-headless) whose addon never came up (or failed to bind)
# listens on NOTHING — the residue sweep can't see it (no tracked port), the
# headless sweep can't see it (not --headless), and the per-lease loop can't
# see it (no sidecar). P0 caught one live (PID 2800: GUI, no lease flag, zero
# LISTEN entries) sitting outside every existing sweep.
#
# Orphan rule (ALL must hold):
#   - cmdline carries NO --kol-mcp-lease  (lease-managed editors are elsewhere)
#   - cmdline carries NO --headless       (those are the headless sweep's job)
#   - process holds NO LISTEN socket on any port
#   - age >= KOL_REAP_GUI_ORPHAN_GRACE_M (default 60m — far above any warmup)
#   - PID absent from every registry entry's proxy/editor pid AND from every
#     active lease's configured_by_pid (it belongs to no known session)
#
# SAFETY (Atlas P3 constraint): this is the one orphan class that cannot prove
# its own attribution from the cmdline — it might be a MANUALLY-pulled editor
# the owner is using (P0 explicitly flagged PID 2800 for human confirmation).
# So this sweep is REPORT-ONLY unless the operator opts in per-run with
# KOL_REAP_GUI_ORPHAN=1 (after confirming the listed PIDs are not theirs).
# Even when enabled it echoes the full evidence line to the console BEFORE
# killing, so there is always a forensic record.
KOL_REAP_GUI_ORPHAN="${KOL_REAP_GUI_ORPHAN:-0}"
KOL_REAP_GUI_ORPHAN_GRACE_M="${KOL_REAP_GUI_ORPHAN_GRACE_M:-60}"
GUI_ORPHAN_KILLED=0

# pid_in_any_record <pid>: 0 if the pid appears in any registry proxy/editor
# pid field OR any active lease configured_by_pid; 1 otherwise. Best-effort —
# a parse failure means "not found" (we err toward reporting, not killing).
pid_in_any_record() {
    local target="$1"
    # registry: $GODOT_MCP_HOME/godot-port-registry.json
    local reg="${MULTICA_DIR}/godot-port-registry.json"
    if [[ -f "$reg" ]]; then
        local hit
        hit="$(REG="$reg" T="$target" node -e '
            const fs=require("fs");
            let hit=false;
            try {
                const o=JSON.parse(fs.readFileSync(process.env.REG,"utf8"));
                for (const e of Object.values(o.entries||{})) {
                    if (!e) continue;
                    for (const k of ["proxy_pid","editor_pid","pid"]) {
                        if (String(e[k]||"") === process.env.T) { hit=true; break; }
                    }
                    if (hit) break;
                }
            } catch(_) {}
            if (hit) process.stdout.write("1");
        ' 2>/dev/null)"
        [[ "$hit" == "1" ]] && return 0
    fi
    # active leases: configured_by_pid match
    while IFS= read -r lease; do
        [[ -n "$lease" ]] || continue
        local cpid
        cpid="$(node -e '
            try { const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
                  if (String(o.state||"")==="active") process.stdout.write(String(o.configured_by_pid==null?"":o.configured_by_pid));
            } catch(_) {}
        ' "$lease" 2>/dev/null)"
        [[ -n "$cpid" && "$cpid" == "$target" ]] && return 0
    done < <(find "$ROOT" -name 'mcp-lease.json' -type f 2>/dev/null || true)
    return 1
}

# list_gui_nolisten_orphans <grace_m>: echo PIDs of non-headless, no-lease-flag
# Godot processes that hold no LISTEN socket and are older than grace_m.
list_gui_nolisten_orphans() {
    local grace_m="$1"
    if (( HAVE_PWSH )); then
        pwsh -Command "
            \$cutoff = (Get-Date).AddMinutes(-$grace_m);
            \$listeners = @{};
            Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \$listeners[\$_.OwningProcess] = \$true };
            Get-CimInstance Win32_Process -Filter \"Name like '%godot%'\" | Where-Object {
                \$_.CommandLine -notmatch 'kol-mcp-lease' -and
                \$_.CommandLine -notmatch 'kol-mcp-runtime' -and
                \$_.CommandLine -notmatch '--headless' -and
                -not \$listeners.ContainsKey(\$_.ProcessId) -and
                \$_.CreationDate -lt \$cutoff
            } | ForEach-Object { Write-Output \$_.ProcessId }
        " 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
    else
        # Linux: /proc scan. Build the set of LISTEN-owning pids from ss, then
        # keep non-headless no-lease godot procs older than grace not in it.
        local listen_pids now pid start_ticks cmdline
        listen_pids="$(ss -tlnp 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
        now="$(date +%s)"
        for pdir in /proc/[0-9]*; do
            pid="${pdir#/proc/}"
            [[ -r "$pdir/cmdline" ]] || continue
            cmdline="$(tr '\0' ' ' <"$pdir/cmdline" 2>/dev/null || true)"
            [[ "$cmdline" == *godot* ]] || continue
            [[ "$cmdline" == *--headless* ]] && continue
            [[ "$cmdline" == *kol-mcp-lease* ]] && continue
            [[ "$cmdline" == *kol-mcp-runtime* ]] && continue
            echo "$listen_pids" | grep -qx "$pid" && continue   # holds a LISTEN socket
            start_ticks="$(awk '{print $22}' "$pdir/stat" 2>/dev/null || echo 0)"
            [[ "$start_ticks" =~ ^[0-9]+$ ]] || continue
            local boot_time hertz start_epoch age_m
            boot_time="$(awk '/btime/{print $2}' /proc/stat 2>/dev/null || echo 0)"
            hertz=100
            start_epoch=$(( boot_time + start_ticks / hertz ))
            age_m=$(( (now - start_epoch) / 60 ))
            (( age_m >= grace_m )) && echo "$pid"
        done
    fi
}

if (( HAVE_PWSH )) || [[ -d /proc ]]; then
    mapfile -t gui_orphan_pids < <(list_gui_nolisten_orphans "$KOL_REAP_GUI_ORPHAN_GRACE_M" | sort -u)
    for gpid in "${gui_orphan_pids[@]}"; do
        [[ -n "$gpid" ]] || continue
        # Skip any PID that a registry entry or active lease still references —
        # it belongs to a known session even if it currently listens on nothing.
        if pid_in_any_record "$gpid"; then
            continue
        fi
        # Console evidence BEFORE any action (P0: leave a forensic record).
        echo "[reap-stale-leases] GUI-ORPHAN-NO-LISTEN pid=${gpid} (age >= ${KOL_REAP_GUI_ORPHAN_GRACE_M}m, GUI godot, no --kol-mcp-lease, no LISTEN socket, in no registry/lease record)"
        if (( DRY_RUN )) || [[ "$KOL_REAP_GUI_ORPHAN" != "1" ]]; then
            echo "  -> (report-only) would kill pid=${gpid}; set KOL_REAP_GUI_ORPHAN=1 after confirming it is not a manual editor"
            GUI_ORPHAN_KILLED=$((GUI_ORPHAN_KILLED+1))
            continue
        fi
        kill_editor_pid "$gpid"
        echo "  -> killed pid=${gpid}"
        GUI_ORPHAN_KILLED=$((GUI_ORPHAN_KILLED+1))
    done
fi

# SEE-1152 (Owner directive, Atlas 子步骤 目标2): dead registry entry sweep.
# The port registry is an acceleration layer (port-arbiter.lib.sh:17), not
# truth — but dead entries accumulate forever because a proxy's clean exit
# only releases its lease sidecar, never its registry row. Each entry is
# judged by the ARBITER's own liveness standard (port_arbiter_pid_alive:
# kill -0 + /proc/<pid>/exe must be node) so a PID recycled by a non-node
# process counts as DEAD and is removed, while a PID recycled by an
# unrelated node process is conservatively KEPT. Deletes go through
# port_registry_delete, which takes the same blocking flock the proxy
# heartbeat upsert takes — the sweep can never interleave with a live
# heartbeat write. dry-run reports without deleting. Default ON; disable
# with KOL_REAP_REGISTRY=0.
REGISTRY_REAPED=0
REGISTRY_KEPT=0
REGISTRY_SKIPPED=0
if [[ "${KOL_REAP_REGISTRY:-1}" == "1" ]]; then
    _reg_path="$(port_registry_path)"
    if [[ ! -f "$_reg_path" ]]; then
        echo "[reap-stale-leases] registry sweep: no registry file at ${_reg_path} (nothing to do)"
    else
        # Enumerate rid+proxy_pid pairs in one node read. Malformed JSON →
        # empty list + rc!=0 → we report and skip the sweep (never guess at
        # field layout on a file we could not parse).
        set +e
        _reg_pairs="$(node -e '
            const fs = require("fs");
            let o;
            try { o = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
            catch (e) { process.exit(3); }
            if (!o || typeof o !== "object" || !o.entries || typeof o.entries !== "object") process.exit(3);
            for (const [rid, e] of Object.entries(o.entries)) {
                if (!e || typeof e !== "object") continue;
                const pid = (e.proxy_pid === null || e.proxy_pid === undefined) ? "" : String(e.proxy_pid);
                process.stdout.write(rid + "\t" + pid + "\n");
            }
        ' "$_reg_path" 2>/dev/null)"
        _reg_rc=$?
        set -e
        if (( _reg_rc != 0 )); then
            echo "[reap-stale-leases] registry sweep: registry unparseable at ${_reg_path} — left untouched (rc=${_reg_rc})"
        else
            while IFS=$'\t' read -r rid pid; do
                [[ -n "$rid" ]] || continue
                if [[ -z "$pid" ]]; then
                    # No proxy_pid recorded — nothing to validate; keep (the
                    # entry may be a pre-heartbeat grant record).
                    REGISTRY_KEPT=$((REGISTRY_KEPT+1))
                    continue
                fi
                if port_arbiter_pid_alive "$pid"; then
                    REGISTRY_KEPT=$((REGISTRY_KEPT+1))
                    continue
                fi
                echo "[reap-stale-leases] REGISTRY-DEAD runtime_id=${rid} proxy_pid=${pid} (kill -0 fails or /proc/<pid>/exe is not node)"
                if (( DRY_RUN )); then
                    echo "  -> (dry-run) would delete registry entry ${rid}"
                else
                    if port_registry_delete "$rid"; then
                        echo "  -> deleted registry entry ${rid}"
                    else
                        echo "  -> delete FAILED for ${rid} (registry left as-is)" >&2
                    fi
                fi
                REGISTRY_REAPED=$((REGISTRY_REAPED+1))
            done <<< "$_reg_pairs"
        fi
    fi
else
    REGISTRY_SKIPPED=1
fi

# SEE-1152 (Owner directive, Atlas 综合补丁 目标1): dead held-lock dir sweep.
# Two held-dir families can outlive their owner (SIGKILL before the trap /
# release path ran):
#   1. per-runtime launcher lock  ${SCRIPT_DIR}/held/<runtime_id>/   (pid file)
#   2. per-port arbiter grant     $(port_arbiter_held_dir)/<port>/   (pid file)
# Judged by the SAME arbiter liveness standard as the registry sweep
# (port_arbiter_pid_alive) — a PID recycled by a non-node process counts as
# DEAD and its dir is removed. A live dir is NEVER removed. dry-run reports
# only. The launcher's own stale-recovery (godot-mcp-launcher.sh:638-642) is
# the primary path and stays untouched; this sweep is the cross-runtime
# backstop. Default ON; disable with KOL_REAP_HELD=0.
HELD_REAPED=0
HELD_KEPT=0
HELD_SKIPPED=0
if [[ "${KOL_REAP_HELD:-1}" == "1" ]]; then
    for _held_root in "${SCRIPT_DIR}/held" "$(port_arbiter_held_dir)"; do
        [[ -d "$_held_root" ]] || continue
        for _hdir in "$_held_root"/*/; do
            [[ -d "$_hdir" ]] || continue
            _hname="$(basename "$_hdir")"
            _hpid=""
            [[ -f "${_hdir}pid" ]] && _hpid="$(tr -d '[:space:]' < "${_hdir}pid" 2>/dev/null || echo "")"
            if [[ -n "$_hpid" ]] && port_arbiter_pid_alive "$_hpid"; then
                HELD_KEPT=$((HELD_KEPT+1))
                continue
            fi
            echo "[reap-stale-leases] HELD-DEAD dir=${_hdir} pid=${_hpid:-<none>} (kill -0 fails or /proc/<pid>/exe is not node)"
            if (( DRY_RUN )); then
                echo "  -> (dry-run) would delete held dir ${_hdir}"
            else
                rm -rf "$_hdir" && echo "  -> deleted held dir ${_hdir}" || echo "  -> delete FAILED for ${_hdir}" >&2
            fi
            HELD_REAPED=$((HELD_REAPED+1))
        done
    done
else
    HELD_SKIPPED=1
fi

echo "[reap-stale-leases] summary: total=${TOTAL} reaped=${REAPED} skipped=${SKIPPED} residue_killed=${RESIDUE_KILLED} headless_killed=${HEADLESS_KILLED} gui_orphan_killed=${GUI_ORPHAN_KILLED:-0} registry_reaped=${REGISTRY_REAPED} registry_kept=${REGISTRY_KEPT} held_reaped=${HELD_REAPED} held_kept=${HELD_KEPT} dry_run=${DRY_RUN}"
exit 0
