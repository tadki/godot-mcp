#!/usr/bin/env bash
# test_see1356_d1_warm_gate.sh — SEE-1356 D1 regression pin (QA FAIL defect).
#
# The warm-flush gate's `!logTailAvailable` bypass used to be unconditional:
# in the fork lane probeOk is structurally true (SEE-1338 P1 removed the
# probe), and at proxy start the editor log does not exist YET — so a no-addon
# worktree was judged WARM ~4ms in (QA evidence: `warmup mode: cold` then
# `[stage=WARM]` 4ms later). Post-fix the bypass serves the legacy lane only
# (real wsProbe evidence); fork lane + no log tail = insufficient evidence →
# the gate stays closed → T2 RECOVERING at the warmup window → FAILED_EXIT
# family semantics instead of a fake warm.
#
# Form under test (sandboxed, short windows, bounded waits):
#   fork lane (GODOT_MCP_FORK_CLI → real fork CLI) + no editor log at all
#   (GODOT_EDITOR_LOG_FILE unset, nothing ever listens) + tools/call held.
#   Assert: NO `[stage=WARM]` and no warm snapshot while the cold window is
#   open; the T2 boundary lands the snapshot in `recovering` with the
#   T1→T2 transition ledger (the D2 vocabulary pin rides the same form).
#
# Run: bash launch/tests/scripts/test_see1356_d1_warm_gate.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PROXY="$REPO/launch/godot-mcp-proxy.mjs"

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }
[[ -x "$PROXY" ]] || { echo "FAIL: proxy missing: $PROXY"; exit 1; }
[[ -x "$REPO/server/dist/cli.js" ]] || { echo "FAIL: fork CLI missing (D1 gate should have built it): $REPO/server/dist/cli.js"; exit 1; }

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

SB="$(mktemp -d)"
cleanup() { [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null; rm -rf "$SB"; }
trap cleanup EXIT
mkdir -p "$SB/home/.multica" "$SB/scratch"
export HOME="$SB/home"
export GODOT_MCP_HOME="$SB/home/.multica"
# Minimal worktree: project.godot only, NO addons/, NO editor log source.
printf 'config_version=5\n\napplication:\n  config/features=PackedStringArray("4.6")\n' > "$SB/scratch/project.godot"
# Helper stubs (GODOT_MCP_*_SH overrides, config.mjs resolveHelper seam):
# the proxy's lazy ensureEditor chain must NOT spawn a real editor in this
# harness (a real editor would write root-owned .godot caches and leak an
# orphan process). configure/start are no-ops; the warmup loop then probes a
# port nothing listens on — exactly the D1 form under test.
printf '#!/usr/bin/env bash\nexit 0\n' > "$SB/stub-configure.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SB/stub-start.sh"
chmod +x "$SB/stub-configure.sh" "$SB/stub-start.sh"
# Runtime id mirrors the launcher's export so the snapshot lands at the slot
# path (the direct-proxy form bypasses the launcher's derivation).
RID="Bachi-1a2b3c4d"
PORT=6677

section "D1: fork lane + no log tail → gate must NOT open on zero evidence"
{
    # warmup window 2.5s; the held tools/call rides the cold window. stdin
    # stays open ~10s so the proxy is alive past T2 even under 4-way parallel
    # load (spawn chain latency delays the window start), then EOF shuts it
    # down (pipe EOF = the shutdown event, no fixed sleep kill).
    ( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"d1-pin"}}}'
      # SEE-1365: the cold-window pacing wait has no in-pipe event to subscribe
      # (initialize is answered by the proxy before any spawn log exists) — the
      # fixed window IS the under-test scenario construction (stdin pacing).
      sleep 1   # 竞态窗口语义（CLAUDE.md 边界）：stdin pacing 窗=被测场景构造
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}'
      # 竞态窗口语义（CLAUDE.md 边界）：cold-window stdin pacing 负向观察窗，即被测场景构造（同线标注不可行：行尾为管道续行）
      sleep 9 ) | env HOME="$HOME" GODOT_MCP_HOME="$GODOT_MCP_HOME" TMPDIR="$SB" \
        "GODOT_MCP_RUNTIME_ID=$RID" \
        KOL_AGENT_NAME=Bachi GODOT_HOST=127.0.0.1 "GODOT_PORT=$PORT" \
        GODOT_MCP_WARMUP_TIMEOUT_MS=2500 GODOT_MCP_FAILED_EXIT_MS=120000 \
        "GODOT_MCP_CONFIGURE_SH=$SB/stub-configure.sh" "GODOT_MCP_START_SH=$SB/stub-start.sh" \
        KOL_PROJECT_GODOT="$SB/scratch/project.godot" KOL_WORKTREE="$SB/scratch" \
        GODOT_MCP_FORK_CLI="$REPO/server/dist/cli.js" \
        timeout 20 node "$PROXY" >"$SB/proxy.out" 2>"$SB/proxy.err" &
    PROXY_PID=$!
    # Bounded event wait: poll the stderr tail for the WARM stage token with a
    # hard budget that outlives the warmup window (the CLAUDE.md predicate-
    # polling seam; the asserted fact is ABSENCE, so the budget is the wait).
    WARM_SEEN=0
    for _ in $(seq 1 40); do
        kill -0 "$PROXY_PID" 2>/dev/null || break
        if grep -q '\[stage=WARM\]' "$SB/proxy.err" 2>/dev/null; then WARM_SEEN=1; break; fi
        sleep 0.25
    done
    wait "$PROXY_PID" 2>/dev/null
    PROXY_RC=$?

    ok "D1a no [stage=WARM] with zero warm evidence (pre-fix: ~4ms)" "$([[ "$WARM_SEEN" == "0" ]] && echo 1 || echo 0)" "$(grep -c '\[stage=WARM\]' "$SB/proxy.err" 2>/dev/null || echo 0)"
    ok "D1b no 'editor warm detected' line" \
        "$(grep -qc 'editor warm detected' "$SB/proxy.err" 2>/dev/null && echo 0 || echo 1)"
    # The snapshot must NEVER claim warm: scan every persisted snapshot doc.
    WARM_SNAP="$(grep -l '"state": *"warm"' "$GODOT_MCP_HOME"/godot-editor/*.proxy-state.json 2>/dev/null | head -1)"
    ok "D1c no snapshot ever claims state=warm" "$([[ -z "$WARM_SNAP" ]] && echo 1 || echo 0)"
    # D2 rides the same form: past the warmup window the coarse state is
    # `recovering` with the T1→T2 transition ledger (real-chain form, not a
    # fixture-crafted doc).
    SNAP="$GODOT_MCP_HOME/godot-editor/$RID.proxy-state.json"
    STATE="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.state||""))}catch(e){process.stdout.write("")}' "$SNAP" 2>/dev/null)"
    ok "D2a snapshot past T2 boundary reads recovering (not warm/cold_idle)" \
        "$([[ "$STATE" == "recovering" ]] && echo 1 || echo 0)" "state=$STATE"
    TRIG="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((o.last_transitions||[]).map(t=>t.trigger).join(","))}catch(e){process.stdout.write("")}' "$SNAP" 2>/dev/null)"
    ok "D2b transition ledger carries T1_warming_enter→T2_recovering_enter" \
        "$([[ "$TRIG" == "T1_warming_enter,T2_recovering_enter" ]] && echo 1 || echo 0)" "triggers=$TRIG"
    # Give-up terminal vocabulary (D2①): force the FAILED_CLEAN family by
    # arming the fields the way giveUpAndRearm does is production-internal —
    # the real-chain give-up form is Revy's live driver; here the SNAPSHOT
    # trigger ledger is the pin. (The armed-give-up coarse read is unit-pinned
    # in launch/tests/unit/see1356-proxy-state.test.mjs.)
    echo "  [info] proxy rc=$PROXY_RC (stdin-EOF shutdown expected; nonzero rc from the T2/hold path is contract)"
}

# Positive-path control: NOT re-run here — spawning the bare proxy bypasses
# the launcher's ensureEditor plumbing (configure/start helpers, arbiter,
# render-stable feed), so a bare-proxy warm control would test the harness
# sandbox, not the gate. The legitimate warm path (readable log → milestones →
# gate opens) is owned by the fast-tier warm-family harnesses (see1110 e1/e2/
# e3, see1244 chains, see1077) — they run in the same push gate as this file.

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
