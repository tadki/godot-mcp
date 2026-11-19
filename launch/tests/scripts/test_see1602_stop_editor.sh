#!/usr/bin/env bash
# SEE-1602 §SPEC-001 — hermetic regression for stop-godot-editor.sh false
# negatives (2026-11-19 A2 incident: WSL interop iostream exception made
# powershell Stop-Process fail, and the script reported "no live editor
# process" / "port free" / exit 0 while the Windows editor pid stayed alive).
#
# Contract under test (post-SEE-1602):
#   C1  probe failure or uncertain verdict is NEVER reported as "stopped" /
#       "port free", and never masks a live editor behind exit 0;
#   C2  failure paths exit non-zero, keep the pid lifecycle file (retryable
#       diagnostics) and print an actionable retry hint containing the pid;
#   C3  success paths keep the historical happy-path output ("port <p> free.",
#       "done.") and exit 0 only when the process probe confirms dead AND the
#       port probe confirms free.
#
# Hermetic by construction: all Windows-interop binaries (powershell.exe,
# tasklist.exe, taskkill.exe, netstat.exe, ss) are stubbed on PATH; no real
# process is ever signalled (the taskkill stub only flips a state file). Run
# against the current tree by default; set STOP_SCRIPT_UNDER_TEST to a copy of
# another revision to prove RED/GREEN (SEE-1602 evidence protocol).
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STOP_SCRIPT="${STOP_SCRIPT_UNDER_TEST:-$REPO/launch/stop-godot-editor.sh}"

if [[ ! -f "$STOP_SCRIPT" ]]; then
	echo "FATAL: stop script not found: $STOP_SCRIPT" >&2
	exit 2
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

STUB="$TMP/stub"
GMCP_HOME="$TMP/gmcp-home"
WORK="$TMP/work"
EMPTY_FALLBACK="$TMP/empty-fallback"
mkdir -p "$STUB" "$GMCP_HOME" "$WORK" "$EMPTY_FALLBACK"
# Hermetic guard: neutralize the product's real System32 fallback so probe
# availability is decided ONLY by the stubs (win_tool would otherwise reach
# the host's genuine interop on WSL hosts and leak real verdicts in).
export KOL_WIN_TOOL_FALLBACK_DIR="$EMPTY_FALLBACK"

PID=20888
PORT=6553
PID_FILE="$GMCP_HOME/godot-editor-bachi.pid"
TASKLIST_MODE_FILE="$TMP/tasklist-mode"
NETSTAT_MODE_FILE="$TMP/netstat-mode"
export SEE1602_TASKLIST_MODE_FILE="$TASKLIST_MODE_FILE"
export SEE1602_NETSTAT_MODE_FILE="$NETSTAT_MODE_FILE"

# --- stubs ---------------------------------------------------------------

# powershell.exe: deterministic interop-crash stand-in (the observed A2
# failure shape: stderr noise, no stdout, non-zero exit) — every PowerShell
# probe/kill channel is dead in every scenario, forcing the fallbacks.
cat >"$STUB/powershell.exe" <<'EOF'
#!/usr/bin/env bash
echo "Exception: ios_base::clear: unspecified iostream_category error" >&2
exit 1
EOF

# tasklist.exe: verdict comes from a mode file so a scenario can flip the
# "Windows world" mid-run (alive -> dead) without real signals. The optional
# countdown file (written by the "delay" taskkill mode) models asynchronous
# teardown: alive while it counts down, dead once it hits zero.
cat >"$STUB/tasklist.exe" <<'EOF'
#!/usr/bin/env bash
mode="$(cat "$SEE1602_TASKLIST_MODE_FILE" 2>/dev/null)"
if [[ -n "${SEE1602_COUNTDOWN_FILE:-}" && -f "$SEE1602_COUNTDOWN_FILE" ]]; then
	n="$(cat "$SEE1602_COUNTDOWN_FILE" 2>/dev/null || echo 0)"
	if [[ "$n" -gt 0 ]]; then
		echo $((n - 1)) >"$SEE1602_COUNTDOWN_FILE"
		echo '"Godot_v4.6.2-stable_win64","20888","Console","1","768,692 K"'
		exit 0
	fi
	# teardown landed: the world moved on — flip the mode file so every
	# downstream "follow" probe (netstat listener oracle) agrees.
	echo dead >"$SEE1602_TASKLIST_MODE_FILE"
	rm -f "$SEE1602_COUNTDOWN_FILE"
	echo "INFO: No tasks are running which match the specified criteria."
	exit 0
fi
case "$mode" in
	alive) echo '"Godot_v4.6.2-stable_win64","20888","Console","1","768,692 K"' ;;
	dead) echo "INFO: No tasks are running which match the specified criteria." ;;
	*) exit 1 ;;
esac
EOF

# taskkill.exe: "ok" simulates a successful forced kill by flipping the
# tasklist verdict to dead — never touches a real process. "delay" models the
# async Windows teardown observed live (kill returns first, death lands later).
cat >"$STUB/taskkill.exe" <<'EOF'
#!/usr/bin/env bash
if [[ "${SEE1602_TASKKILL_MODE:-}" == "ok" ]]; then
	echo dead >"$SEE1602_TASKLIST_MODE_FILE"
	echo "SUCCESS: The process with PID 20888 has been terminated."
	exit 0
fi
if [[ "${SEE1602_TASKKILL_MODE:-}" == "delay" ]]; then
	echo 2 >"$SEE1602_COUNTDOWN_FILE"
	echo "SUCCESS: The process with PID 20888 has been terminated."
	exit 0
fi
exit 1
EOF

# netstat.exe: Windows-side listener oracle. "follow" models reality (the
# listener exists while the editor process lives, countdown included for the
# async-teardown scenario); "listening"/"free" are fixed verdicts for
# scenarios where the port outlives the pid (path 2).
cat >"$STUB/netstat.exe" <<'EOF'
#!/usr/bin/env bash
mode="$(cat "$SEE1602_NETSTAT_MODE_FILE" 2>/dev/null)"
row() { printf '  TCP    172.17.192.1:6553     0.0.0.0:0      LISTENING     20888\n'; }
cdown_alive() {
	[[ -n "${SEE1602_COUNTDOWN_FILE:-}" && -f "$SEE1602_COUNTDOWN_FILE" ]] \
		&& [[ "$(cat "$SEE1602_COUNTDOWN_FILE" 2>/dev/null || echo 0)" -gt 0 ]]
}
if [[ "$mode" == "listening" ]]; then
	row
elif [[ "$mode" == "follow" ]]; then
	if cdown_alive || [[ "$(cat "$SEE1602_TASKLIST_MODE_FILE" 2>/dev/null)" == "alive" ]]; then
		row
	fi
fi
EOF

# ss: only installed to make the LAST port tier fail (probe-unavailable path).
cat >"$STUB/ss" <<'EOF'
#!/usr/bin/env bash
exit 2
EOF

chmod +x "$STUB"/powershell.exe "$STUB"/tasklist.exe "$STUB"/taskkill.exe \
	"$STUB"/netstat.exe "$STUB"/ss

# --- harness -------------------------------------------------------------

FAILURES=0

run_stop() {
	# $1 = scenario name; $2 = optional forced PATH (path6 strips host interop
	# so the System32-fallback tier is exercised deterministically).
	(
		cd "$WORK" || exit 97
		export PATH="$STUB:${2:-$PATH}"
		export GODOT_MCP_HOME="$GMCP_HOME"
		unset KOL_RUNTIME_ID KOL_AGENT_NAME KOL_MCP_PORT
		bash "$STOP_SCRIPT" Bachi
	) >"$TMP/out.log" 2>"$TMP/err.log"
	echo $?
}

assert_fail() {
	# C1/C2 shared failure contract: $1 scenario, $2 rc, $3 detail.
	# Both streams are asserted: success-shaped lines must not appear anywhere,
	# and the failure diagnostics (stderr) must carry the pid.
	local s="$1" rc="$2" detail="$3"
	cat "$TMP/out.log" "$TMP/err.log" >"$TMP/all.log"
	if [[ "$rc" -eq 0 ]]; then
		echo "FAIL [$s] exit code is 0 ($detail)"; FAILURES=$((FAILURES + 1)); return
	fi
	if grep -q "no live editor process found" "$TMP/all.log"; then
		echo "FAIL [$s] fake 'no live editor process found' success line ($detail)"
		FAILURES=$((FAILURES + 1)); return
	fi
	if grep -qE "^\\[stop-godot-editor\\] port ${PORT} free\\.$" "$TMP/all.log"; then
		echo "FAIL [$s] fake 'port ${PORT} free' success line ($detail)"
		FAILURES=$((FAILURES + 1)); return
	fi
	if grep -qE "^\\[stop-godot-editor\\] done\\.$" "$TMP/all.log"; then
		echo "FAIL [$s] bare 'done.' success line on failure ($detail)"
		FAILURES=$((FAILURES + 1)); return
	fi
	if ! grep -q "$PID" "$TMP/all.log"; then
		echo "FAIL [$s] pid diagnostic missing from output ($detail)"
		FAILURES=$((FAILURES + 1)); return
	fi
	if [[ ! -f "$PID_FILE" ]]; then
		echo "FAIL [$s] pid lifecycle file removed on failure — retry diagnostics lost ($detail)"
		FAILURES=$((FAILURES + 1)); return
	fi
	echo "PASS [$s] $detail (rc=$rc, pid diagnostics + lifecycle file retained)"
}

assert_success() {
	local s="$1" rc="$2" detail="$3"
	if [[ "$rc" -ne 0 ]]; then
		echo "FAIL [$s] expected exit 0, got $rc ($detail)"; FAILURES=$((FAILURES + 1)); return
	fi
	if ! grep -qE "^\\[stop-godot-editor\\] done\\.$" "$TMP/out.log"; then
		echo "FAIL [$s] missing 'done.' on success ($detail)"; FAILURES=$((FAILURES + 1)); return
	fi
	echo "PASS [$s] $detail (rc=0)"
}

reset_world() {
	# $1 = tasklist verdict; $2 = netstat verdict (optional, sticky).
	echo "$1" >"$TASKLIST_MODE_FILE"
	if [[ -n "${2:-}" ]]; then
		echo "$2" >"$NETSTAT_MODE_FILE"
	fi
	echo "$PID" >"$PID_FILE"
}

# --- §SPEC-001 path 1: interop crash, Windows pid still alive, port bound --
reset_world alive follow
export SEE1602_TASKKILL_MODE=fail # fallback kill channel cannot save it
rc="$(run_stop path1)"
assert_fail "path1-crash-pid-alive-port-bound" "$rc" \
	"interop crash + tasklist alive + port listening must fail loud with retry hint"

# --- §SPEC-001 path 2: kill probe says dead, but port still listening ------
reset_world dead listening
rc="$(run_stop path2)"
assert_fail "path2-port-still-listening" "$rc" \
	"process verdict dead but port still listening must not report free/success"

# --- §SPEC-001 path 3: every probe unavailable (tasklist broken, netstat
#     absent, ss failing) — nothing may be claimed stopped or free ----------
rm -f "$STUB/netstat.exe" # probe tier 2 unavailable
reset_world broken
rc="$(run_stop path3)"
assert_fail "path3-probes-unavailable" "$rc" \
	"all probes unavailable must exit non-zero without stopped/free claims"

# --- GREEN happy path: kill fallback works, port frees, lifecycle cleaned --
# (netstat stub was removed in path3; restore it with the full follow logic)
cat >"$STUB/netstat.exe" <<'EOF'
#!/usr/bin/env bash
mode="$(cat "$SEE1602_NETSTAT_MODE_FILE" 2>/dev/null)"
row() { printf '  TCP    172.17.192.1:6553     0.0.0.0:0      LISTENING     20888\n'; }
cdown_alive() {
	[[ -n "${SEE1602_COUNTDOWN_FILE:-}" && -f "$SEE1602_COUNTDOWN_FILE" ]] \
		&& [[ "$(cat "$SEE1602_COUNTDOWN_FILE" 2>/dev/null || echo 0)" -gt 0 ]]
}
if [[ "$mode" == "listening" ]]; then
	row
elif [[ "$mode" == "follow" ]]; then
	if cdown_alive || [[ "$(cat "$SEE1602_TASKLIST_MODE_FILE" 2>/dev/null)" == "alive" ]]; then
		row
	fi
fi
EOF
chmod +x "$STUB/netstat.exe"
reset_world alive follow
SEE1602_TASKKILL_MODE=ok # taskkill stub flips the tasklist verdict to dead
rc="$(run_stop path5)"
export SEE1602_TASKKILL_MODE=fail
assert_success "path5-happy-stop" "$rc" \
	"kill fallback + port probe agree -> exit 0, done., lifecycle cleaned"
if grep -qE "^\\[stop-godot-editor\\] port ${PORT} free\\.$" "$TMP/out.log"; then
	echo "PASS [path5] port free success line present"
else
	echo "FAIL [path5] missing 'port ${PORT} free.' success line"
	FAILURES=$((FAILURES + 1))
fi
if [[ -f "$PID_FILE" ]]; then
	echo "FAIL [path5] pid lifecycle file should be removed on success"
	FAILURES=$((FAILURES + 1))
fi

# --- GREEN idempotent no-op: nothing running, port free --------------------
echo dead >"$TASKLIST_MODE_FILE"
echo free >"$NETSTAT_MODE_FILE"
rm -f "$PID_FILE"
rc="$(run_stop path4)"
assert_success "path4-idempotent-noop" "$rc" \
	"no pid file + port free -> historical no-op success"

# --- §SPEC-001 path 6 (live A2 rerun finding): interop absent from PATH but
#     reachable via the System32 fallback — the unix kill branch must NOT
#     run, and `kill -0` on the Windows pid must never be read as "dead".
#     Stubs move to the KOL_WIN_TOOL_FALLBACK_DIR; PATH carries no interop.
FALLBACK="$TMP/win-fallback"
mkdir -p "$FALLBACK"
mv -f "$STUB/tasklist.exe" "$STUB/taskkill.exe" "$STUB/netstat.exe" "$STUB/powershell.exe" "$FALLBACK/"
reset_world alive follow
export KOL_WIN_TOOL_FALLBACK_DIR="$FALLBACK"
export SEE1602_TASKKILL_MODE=fail
rc="$(run_stop path6 "/usr/bin:/bin")"
export KOL_WIN_TOOL_FALLBACK_DIR="$EMPTY_FALLBACK"
mv -f "$FALLBACK/tasklist.exe" "$FALLBACK/taskkill.exe" "$FALLBACK/netstat.exe" "$FALLBACK/powershell.exe" "$STUB/"
assert_fail "path6-interop-path-stripped-fallback" "$rc" \
	"PATH-stripped interop resolved via System32 fallback -> windows probe path, no kill -0 false dead"
cat "$TMP/out.log" "$TMP/err.log" >"$TMP/all.log"
if grep -q "kill -0" "$TMP/all.log"; then
	echo "FAIL [path6] unix branch ran on a Windows pid (kill -0 false-dead)"
	FAILURES=$((FAILURES + 1))
else
	echo "PASS [path6] unix kill branch not taken for Windows pid"
fi
if grep -q "probe=alive" "$TMP/all.log"; then
	echo "PASS [path6] windows probe branch verdict present"
else
	echo "FAIL [path6] windows probe branch did not produce its verdict"
	FAILURES=$((FAILURES + 1))
fi

# --- GREEN async teardown: kill lands late, bounded poll must converge ------
COUNTDOWN="$TMP/kill-countdown"
export SEE1602_COUNTDOWN_FILE="$COUNTDOWN"
reset_world alive follow
export SEE1602_TASKKILL_MODE=delay
rc="$(run_stop path7)"
export SEE1602_TASKKILL_MODE=fail
unset SEE1602_COUNTDOWN_FILE
assert_success "path7-async-teardown-poll" "$rc" \
	"taskkill accepted but death lands 3 probes later -> bounded poll converges to exit 0"

# --- verdict ---------------------------------------------------------------
echo
echo "see1602 stop-editor regression: target=$STOP_SCRIPT"
if [[ "$FAILURES" -gt 0 ]]; then
	echo "RESULT: RED ($FAILURES assertion(s) failed) — contract violated by implementation under test"
	exit 1
fi
echo "RESULT: GREEN — all assertions passed"
exit 0
