// SEE-1070 Stage 3 #6 — WS single-client contract: newcomer gets close 4001.
//
// The godot-mcp addon (addons/godot_mcp/websocket_server.gd) is a SINGLE-client
// WebSocket server. When a client already holds the bridge (the "incumbent"),
// any newcomer that opens a second WebSocket to the same port is rejected with a
// clean close code 4001 ("Another client is already connected") — it is never
// allowed to displace the live incumbent. This test verifies that contract
// against the REAL, LIVE editor addon instance.
//
// Real-machine preconditions (must hold when this script runs):
//   1. The Godot editor is open with the godot-mcp addon enabled, listening on
//      GODOT_PORT (Revy allocation = 6555).
//   2. An incumbent MCP client (the godot-mcp-proxy/npx bridge that Revy's own
//      tools ride on) is ALREADY connected on that port — i.e. the single-client
//      slot is occupied. This is the state the production bridge runs in while a
//      QA session is active.
//
// Why we test the LIVE addon and not a spawned dedicated instance:
//   MCPWebSocketServer / MCPLog are editor-only class_names (the addon is an
//   EditorPlugin) — they do NOT resolve in the game process (verified:
//   ClassDB.class_exists(...) == false in-game), so a dedicated server cannot be
//   hosted via godot_exec. The only running production instance is the editor's
//   own, which is exactly what end users exercise. Testing it directly is the
//   most faithful E2E of the contract.
//
// Contract under test (addons/godot_mcp/websocket_server.gd):
//   - CLOSE_CODE_ALREADY_CONNECTED = 4001  (L17)
//   - CLOSE_REASON_ALREADY_CONNECTED = "Another client is already connected" (L18)
//   - REJECT_TIMEOUT_MSEC = 5000  (L14) — hard cap on the reject lifecycle
//   - _accept_connection: incumbent alive & not stale -> _begin_reject (L110-124)
//   - _begin_reject: handshakes newcomer on a throwaway peer, incumbent untouched (L143-159)
//   - _process_rejecting_peers: once OPEN -> ws.close(4001, reason) (L178-183)
//
// Goal 1 (Atlas trigger 71a8d034): client B opens the same port while the
// incumbent (A) is connected -> B receives close 4001 within the reject timeout
// (does NOT hang), and A is unaffected (verified transitively: a third client C
// opened right after B is ALSO rejected with 4001 — if the incumbent had been
// displaced, C would instead connect OK, so C-gets-4001 proves A still holds the
// slot).
//
// Goal 2 (stale replacement, close 4002): documented in-script as an upstream
// constraint — see STALE_CONSTRAINT note near the bottom. Exercising it live
// would require idling the ACTIVE production incumbent >=45s, which severs the
// running QA session (the addon would replace it); not forced per Atlas's
// explicit allowance ("或文档化此场景为 upstream 约束（不强行测试）").
//
// Run: node .dev/godot-mcp/tests/e2e/godot-mcp/test_see1070_ws_single_client_4001.mjs
// Env: GODOT_HOST (default: WSL2 default gateway), GODOT_PORT (default: 6555).

import { spawnSync } from "node:child_process";

const GODOT_HOST = process.env.GODOT_HOST ?? detectWindowsHost();
const GODOT_PORT = process.env.GODOT_PORT ?? "6555";
const URL = `ws://${GODOT_HOST}:${GODOT_PORT}`;

// Mirror the addon's reject hard-cap (REJECT_TIMEOUT_MSEC = 5000) with slack for
// handshake + a frame or two of poll latency. A newcomer that has not received
// its 4001 close by this point is treated as a HANG (the exact failure mode the
// test exists to catch).
const REJECT_DEADLINE_MS = 8000;

const CLOSE_CODE_ALREADY_CONNECTED = 4001;
const CLOSE_REASON_ALREADY_CONNECTED = "Another client is already connected";

let PASS = 0, FAIL = 0;
const FAILS = [];
function ok(name, detail) { console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`); PASS++; }
function ko(name, detail) { console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); FAIL++; FAILS.push(`${name}: ${detail ?? ""}`); }
function sep(s) { console.log("\n================================================================\n" + s + "\n================================================================"); }

function detectWindowsHost() {
  try {
    const out = spawnSync("ip", ["route", "show", "default"], { encoding: "utf8" }).stdout ?? "";
    const m = out.match(/via\s+(\S+)/);
    if (m) return m[1];
  } catch { /* not WSL2 */ }
  return "localhost";
}

function tcpOpen(host, port, timeoutMs = 3000) {
  const r = spawnSync("node", ["-e", `
    const net = require("net");
    const s = net.connect(${port}, ${JSON.stringify(host)}, () => { process.stdout.write("open"); s.destroy(); });
    s.setTimeout(${timeoutMs}, () => { s.destroy(); });
    s.on("error", () => {});
    s.on("close", () => process.exit(0));
  `], { encoding: "utf8", timeout: timeoutMs + 2000 });
  return (r.stdout ?? "").includes("open");
}

/**
 * Open one raw WebSocket to the addon as a newcomer and resolve with what the
 * server did to it. Mirrors what a stray second MCP client experiences.
 *
 * Returns:
 *   { reachedOpen: bool, closeCode: int|null, closeReason: string,
 *     error: string|null, elapsedMs: int, hung: bool }
 *
 * `hung === true` means no close frame arrived within REJECT_DEADLINE_MS — the
 * exact non-behaviour Goal 1 forbids.
 */
function probeNewcomer(label) {
  return new Promise((resolve) => {
    const start = performance.now();
    const out = { reachedOpen: false, closeCode: null, closeReason: "", error: null, elapsedMs: 0, hung: false };
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(URL);
    } catch (e) {
      out.error = `WebSocket ctor threw: ${e.message}`;
      out.elapsedMs = Math.round(performance.now() - start);
      return resolve(out);
    }
    const finish = () => {
      if (settled) return;
      settled = true;
      out.elapsedMs = Math.round(performance.now() - start);
      resolve(out);
    };
    const guard = setTimeout(() => {
      out.hung = true;
      try { ws.close(); } catch {}
      finish();
    }, REJECT_DEADLINE_MS);

    ws.addEventListener("open", () => { out.reachedOpen = true; });
    ws.addEventListener("error", (ev) => {
      // undici fires `error` on abnormal disconnects; capture but let close
      // provide the authoritative code if one is available.
      out.error = ev?.message ?? (out.reachedOpen ? "socket error after open" : "socket error before open");
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(guard);
      out.closeCode = typeof ev?.code === "number" ? ev.code : null;
      out.closeReason = typeof ev?.reason === "string" ? ev.reason : "";
      finish();
    });
    // label is informational only (parallel probing not used here).
    void label;
  });
}

async function main() {
  console.log(`SEE-1070 #6 — WS single-client 4001 contract (target ${URL})`);

  // --- Precondition: editor addon alive on the port -------------------------
  sep("Precondition: editor addon listening on " + URL);
  if (tcpOpen(GODOT_HOST, GODOT_PORT)) {
    ok("addon TCP port open", `${GODOT_HOST}:${GODOT_PORT}`);
  } else {
    ko("addon TCP port open", `${GODOT_HOST}:${GODOT_PORT} not reachable — run with a live Godot editor (godot-mcp addon enabled) and an incumbent MCP client connected`);
    console.log("\nSUMMARY: PASS=" + PASS + " FAIL=" + FAIL);
    process.exit(1);
  }

  // --- Goal 1: newcomer B is rejected with 4001 -----------------------------
  sep("Goal 1: newcomer B -> close 4001 within reject deadline (no hang)");
  const b = await probeNewcomer("B");
  if (b.hung) {
    ko("B received close frame within " + REJECT_DEADLINE_MS + "ms", "HUNG — addon did not close the newcomer (would brick stray clients)");
  } else {
    ok("B received a close frame", `code=${b.closeCode} after ${b.elapsedMs}ms`);
  }
  const bCodeOk = b.closeCode === CLOSE_CODE_ALREADY_CONNECTED;
  bCodeOk
    ? ok("B close code == 4001 (CLOSE_CODE_ALREADY_CONNECTED)", `reason="${b.closeReason}"`)
    : ko("B close code == 4001", `got code=${b.closeCode} reason="${b.closeReason}" error=${b.error ?? "none"} (1006/1005 would mean a raw TCP drop, not the addon's coded reject)`);
  const bReasonOk = b.closeReason.includes("already connected");
  bReasonOk
    ? ok("B close reason carries addon's diagnostic text", `"${b.closeReason}"`)
    : ko("B close reason carries addon's diagnostic text", `reason="${b.closeReason}" (expected to include "already connected")`);
  // Completing the WS handshake before the close proves the addon ran its
  // reject handshake (accept_stream -> STATE_OPEN -> coded close), not an early
  // TCP reset. Some transports fold open+close into one tick; record but do not
  // fail on it — the coded 4001 is the authoritative signal.
  console.log(`  [INFO] B reached OPEN before close: ${b.reachedOpen}`);

  // --- A unaffected: a third client C is ALSO rejected with 4001 ------------
  // If B's probe had displaced the incumbent, the slot would now be empty (or
  // held by B), and C would connect OK. C getting 4001 proves the incumbent A
  // still holds the bridge — i.e. A is unaffected by B's rejection.
  sep("A unaffected: third client C -> also 4001 (incumbent still holds slot)");
  const c = await probeNewcomer("C");
  if (c.hung) {
    ko("C received close frame within " + REJECT_DEADLINE_MS + "ms", "HUNG — incumbent may have been displaced (slot no longer rejecting)");
  } else {
    ok("C received a close frame", `code=${c.closeCode} after ${c.elapsedMs}ms`);
  }
  const cCodeOk = c.closeCode === CLOSE_CODE_ALREADY_CONNECTED;
  cCodeOk
    ? ok("C close code == 4001 -> incumbent A still holds the slot (A unaffected)", `reason="${c.closeReason}"`)
    : ko("C close code == 4001", `got code=${c.closeCode} reason="${c.closeReason}" — if code is null/1006 and C stayed OPEN, the incumbent was displaced by B (A IS affected)`);
  if (!cCodeOk && c.reachedOpen && !c.hung && c.closeCode === null) {
    ko("incumbent displacement guard", "C connected and stayed open — B displaced A (single-client invariant broken)");
  }

  // --- Goal 2: stale replacement (close 4002) — upstream constraint ---------
  sep("Goal 2: stale replacement (close 4002) — documented upstream constraint");
  console.log(JSON.stringify({
    constraint: "stale_replacement_not_exercised_live",
    rationale: "Triggering close 4002 requires the ACTIVE production incumbent to be idle >45000ms (STALE_CONNECTION_TIMEOUT_MSEC). The only live incumbent is the godot-mcp-proxy/npx bridge this QA session rides on; idling it makes the addon replace it, severing the active session. Not forced (Atlas 71a8d034: 或文档化此场景为 upstream 约束).",
    code_paths: [
      "websocket_server.gd:110-116  _accept_connection stale branch -> _force_close_connection (replace)",
      "websocket_server.gd:218-221  _process_websocket STATE_OPEN proactive stale close (4002)",
      "websocket_server.gd:239-251  _force_close_connection",
      "websocket_server.gd:254-263  _is_stale_connection (TCP dropped OR no activity >45s)",
      "websocket_server.gd:15-16    CLOSE_CODE_STALE=4002 / CLOSE_REASON_STALE"
    ],
    recommendation: "Cover via an editor-side GUT unit test that instantiates MCPWebSocketServer and injects a stale _last_activity_msec (class resolves in-editor, unlike in-game).",
    status: "DOCUMENTED"
  }, null, 2));

  // --- Summary --------------------------------------------------------------
  console.log("\n================================================================");
  console.log("SUMMARY: PASS=" + PASS + " FAIL=" + FAIL + "  (target " + URL + ")");
  if (FAIL > 0) { console.log("FAILURES:"); for (const f of FAILS) console.log("  - " + f); }
  console.log("================================================================");
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
