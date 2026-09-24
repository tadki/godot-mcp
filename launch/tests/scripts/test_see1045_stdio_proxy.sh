#!/usr/bin/env bash
# SEE-1045 minimal repro: verify launcher -> proxy -> npx stdio chain.
#
# Mocks the helper scripts and npx so the launcher/proxy path runs without a
# real Godot editor. Feeds an `initialize` JSON-RPC message to the launcher and
# checks the mocked npx response makes it back through the proxy to stdout.
#
# Also covers the slow orphan-gate / setup delay that the real fresh-session
# path hits: even when the launcher spends time in the orphan gate or editor
# setup before exec'ing the proxy, the `initialize` handshake line must still
# reach the proxy.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1045_stdio_proxy.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/launch"
WRAPPER="$LAUNCH_DIR/godot-mcp-launcher.sh"
PROXY="$LAUNCH_DIR/godot-mcp-proxy.mjs"
RESOLVE="$LAUNCH_DIR/godot-mcp-resolve.mjs"

PASS=0; FAIL=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }

[[ -f "$WRAPPER" ]] || { echo "FATAL: $WRAPPER not found" >&2; exit 2; }
[[ -f "$PROXY" ]] || { echo "FATAL: $PROXY not found" >&2; exit 2; }

TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

find_free_port() {
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
}

# Build a stubbed launcher that skips editor setup and execs the real proxy.
make_stubbed_wrapper() {
    local dir="$TMPDIR/stub"
    mkdir -p "$dir"
    # shellcheck disable=SC2016
    awk '
        /^SCRIPT_DIR=".*"$/ { print "SCRIPT_DIR=\"" dir "\""; next }
        /^# --- Parse CLI ---/ && !ins {
            print "port_in_use() { return 0; }"
            print "listener_is_healthy() { return 0; }"
            ins = 1
        }
        { print }
    ' dir="$dir" "$WRAPPER" > "$dir/godot-mcp-launcher.sh"
    chmod +x "$dir/godot-mcp-launcher.sh"

    cat > "$dir/configure-mcp-port.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat > "$dir/start-godot-editor.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$dir"/*.sh
    cp "$PROXY" "$dir/godot-mcp-proxy.mjs"
        # SEE-1344: the proxy was decomposed (SEE-1334 Phase 0a) into launch/proxy/
    # modules plus top-level predicate modules — per-file copies go stale
    # silently. Vendor the full launch tree (top-level files + proxy/) so the
    # stub dir always carries the current module surface.
    (cd "$LAUNCH_DIR" && find . -maxdepth 1 -type f -exec cp {} "$dir/" \; && cp -r proxy "$dir/")
    # Keep the mock helpers deterministic: the real configure/start must not run.
    echo "$dir"
}

# Build a stubbed launcher with a slow orphan gate and a stdin thief probe.
# The probe is intentionally run with the script's detached stdin; if the FD
# preservation in the launcher fails, the proxy will never see initialize.
make_slow_wrapper() {
    local dir="$TMPDIR/stub_slow"
    mkdir -p "$dir"
    # shellcheck disable=SC2016
    awk '
        /^SCRIPT_DIR=".*"$/ { print "SCRIPT_DIR=\"" dir "\""; next }
        /^# --- Parse CLI ---/ && !ins {
            print "port_in_use() { return 0; }"
            print "listener_is_healthy() { sleep 1.5; return 0; }"
            ins = 1
        }
        { print }
    ' dir="$dir" "$WRAPPER" > "$dir/godot-mcp-launcher.sh"
    chmod +x "$dir/godot-mcp-launcher.sh"

    cat > "$dir/configure-mcp-port.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat > "$dir/start-godot-editor.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$dir"/*.sh
    # SEE-1344: the proxy was decomposed (SEE-1334 Phase 0a) into launch/proxy/
    # modules plus top-level predicate modules — per-file copies go stale
    # silently. Vendor the full launch tree (top-level files + proxy/) so the
    # stub dir always carries the current module surface.
    (cd "$LAUNCH_DIR" && find . -maxdepth 1 -type f -exec cp {} "$dir/" \; && cp -r proxy "$dir/")
    # Keep the mock helpers deterministic: the real configure/start must not run.
    echo "$dir"
}

# Mock npx: respond to initialize on stdin, stay alive until stdin closes.
MOCK_NPX="$TMPDIR/mock-npx.mjs"
cat > "$MOCK_NPX" <<'EOF'
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
            const resp = { jsonrpc: '2.0', id: msg.id, result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05' } };
            process.stdout.write(JSON.stringify(resp) + '\n');
        }
    } catch (e) {}
});
EOF

MOCK_NPX_DIR="$TMPDIR/mock_npx"
mkdir -p "$MOCK_NPX_DIR"
cat > "$MOCK_NPX_DIR/npx" <<EOF
#!/usr/bin/env bash
exec node "$MOCK_NPX" "\$@"
EOF
chmod +x "$MOCK_NPX_DIR/npx"

run_case() {
    local name="$1" wrapper_dir="$2" delay="${3:-0}"
    local port out err pid wait_after
    port=$(find_free_port)
    out="$TMPDIR/${name}.out"
    err="$TMPDIR/${name}.err"
    # Give slow orphan-gate / setup cases enough time to exec proxy and respond.
    wait_after=$(( delay + 3 ))
    # SEE-1344: the stub launcher's spawn chain gained a prepare-worktree step
    # (SEE-1342 sync) — under fast-par 4-way load its in-flight wait window
    # can push exec past delay+3s; the asserted chain (launcher→proxy→npx
    # stdio) is unchanged, only the observation window widens.
    wait_after=$(( delay + 6 ))

    # SEE-1344: the launcher now waits up to KOL_WORKTREE_WAIT_S=120s for a
    # private worktree to resolve; this chain test only needs the stdio path,
    # so pin an explicit scratch project.godot (skips the WORKTREE_WAIT tier
    # entirely — the asserted chain is launcher→proxy→npx, not resolution).
    local scratch="$TMPDIR/${name}-scratch"
    mkdir -p "$scratch"
    printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$scratch/project.godot"
    (
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}'
        sleep 5
    ) | env \
        "KOL_AGENT_NAME=Revy" \
        "GODOT_HOST=127.0.0.1" \
        "PATH=$MOCK_NPX_DIR:$PATH" \
        "KOL_GODOT_MCP_CMD=npx" \
        "KOL_PROJECT_GODOT=$scratch/project.godot" \
        "KOL_WORKTREE=$scratch" \
        bash "$wrapper_dir/godot-mcp-launcher.sh" --port "$port" \
        >"$out" 2>"$err" &
    pid=$!

    sleep "$wait_after"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    echo
    echo "===== $name stderr ====="
    cat "$err"
    echo "===== $name stdout ====="
    cat "$out"

    if grep -q '"id":1' "$out" && grep -q 'mock-godot-mcp' "$out"; then
        ok "$name: initialize response echoed back through launcher+proxy+mock-npx"
    else
        ko "$name: no initialize response on stdout; stdout=$(cat "$out" 2>/dev/null)"
    fi
    if grep -q 'DEBUG: stdin line received' "$err"; then
        ok "$name: proxy received stdin line"
    else
        ko "$name: proxy did not log stdin line receipt"
    fi
    if grep -q 'DEBUG: forwarded to npx stdin' "$err"; then
        ok "$name: proxy forwarded initialize to npx"
    else
        ko "$name: proxy did not forward initialize to npx"
    fi
}

STUB_DIR="$(make_stubbed_wrapper)"
SLOW_DIR="$(make_slow_wrapper)"

run_case "fast-reuse" "$STUB_DIR" 0
run_case "slow-orphan-gate" "$SLOW_DIR" 2

echo
if [[ $FAIL -eq 0 ]]; then
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
else
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
