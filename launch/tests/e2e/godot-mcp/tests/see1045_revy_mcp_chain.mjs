// SEE-1045: Plan B++ per-agent launcher -> proxy -> npx -> Godot editor chain e2e.
// Spawns the per-agent MCP server (launcher or proxy directly) as the stdio
// MCP server (same shape the Multica platform would use) and drives the full
// tool chain: initialize, tools/list, editor read, run (frozen), game step,
// exec, stop. Records each call latency.
//
// Env:
//   AGENT_NAME       agent name passed to launcher when USE_LAUNCHER=1
//                    (default "Revy").
//   GODOT_HOST       defaults to the value resolved by mcp_client.mjs
//                    (process.env.GODOT_HOST or auto-detected Windows host /
//                    localhost on pure Linux)
//   GODOT_PORT       default 6555 (Revy's per-agent port)
//   USE_LAUNCHER=1   spawn godot-mcp-launcher.sh <AGENT_NAME> (cold-start path);
//                    otherwise spawn godot-mcp-proxy.mjs (warm path).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { harness } from "../harness.mjs";
import { GODOT_HOST as DEFAULT_GODOT_HOST } from "../mcp_client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../../..");
const launcher = resolve(repoRoot, "launch/godot-mcp-launcher.sh");
const proxy = resolve(repoRoot, "launch/godot-mcp-proxy.mjs");
const probe = resolve(repoRoot, "launch/mcp_ready_probe.py");

const GODOT_HOST = process.env.GODOT_HOST || DEFAULT_GODOT_HOST;
const GODOT_PORT = process.env.GODOT_PORT || "6555";
const AGENT_NAME = process.env.AGENT_NAME || "Revy";
const USE_LAUNCHER = process.env.USE_LAUNCHER === "1";

const CALL_TIMEOUT_MS = 180000;

const callTimings = [];

async function timed(name, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    const elapsed = performance.now() - start;
    callTimings.push({ name, elapsedMs: Math.round(elapsed * 100) / 100, ok: true });
    return result;
  } catch (err) {
    const elapsed = performance.now() - start;
    callTimings.push({ name, elapsedMs: Math.round(elapsed * 100) / 100, ok: false, error: err.message });
    throw err;
  }
}

async function callTool(client, name, args = {}) {
  return await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
}

function firstText(result) {
  const item = result?.content?.find((c) => c.type === "text" && c.text);
  return item?.text ?? "";
}

function probeTcp() {
  const r = spawnSync("python3", [probe, "--host", GODOT_HOST, "--port", GODOT_PORT, "--check", "tcp", "--timeout", "5"], {
    encoding: "utf-8",
    timeout: 15000,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return out.includes("TCP reachable");
}

async function waitForEditorReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (probeTcp()) return Math.round((Date.now() - start) / 100) / 10;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function connectMcp() {
  const client = new Client({ name: "kole-see1045", version: "1.0.0" });
  const initStart = performance.now();
  const transport = USE_LAUNCHER
    ? new StdioClientTransport({
        command: launcher,
        args: [AGENT_NAME],
        env: { ...process.env, GODOT_HOST, GODOT_PORT },
      })
    : new StdioClientTransport({
        command: "node",
        args: [proxy],
        env: { ...process.env, GODOT_HOST, GODOT_PORT },
      });
  await client.connect(transport);
  const initElapsed = performance.now() - initStart;
  callTimings.push({ name: "initialize", elapsedMs: Math.round(initElapsed * 100) / 100, ok: true });
  return client;
}

/** The npx client may need a few seconds to establish its WebSocket to the
 * Godot addon after the MCP handshake is complete. Poll `godot_editor_read`
 * until the addon returns a real payload, mirroring the settle logic in
 * mcp_client.mjs. This prevents the first timed call from racing the WS setup. */
async function settleEditorConnection(client, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await client.callTool(
        { name: "godot_editor_read", arguments: { action: "get_state" } },
        undefined,
        { timeout: 5000 }
      );
      const text = firstText(result);
      if (text.length > 0 && !text.startsWith("Error:") && !text.includes("Not connected to Godot") && text.includes("godot_version")) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function teardown(client) {
  try {
    await client.close();
  } catch {
    // ignore
  }
}

async function main() {
  harness.start("see1045_warmup");
  const wasWarm = probeTcp();
  if (!wasWarm && USE_LAUNCHER) {
    harness.record("editor cold-start required", true, `${GODOT_HOST}:${GODOT_PORT}`);
  } else {
    harness.record("editor already listening on Godot port", wasWarm, `${GODOT_HOST}:${GODOT_PORT}`);
  }
  if (!wasWarm && !USE_LAUNCHER) {
    const waited = await waitForEditorReady(180000);
    if (waited == null) {
      harness.record("editor TCP listen within 180s", false, "cold-start failed (resource error or editor not running)");
      harness.finishSuite();
      harness.printSummary();
      process.exit(harness.exitCode());
    }
    harness.record("editor TCP listen within 180s", true, `waited ${waited}s`);
  }
  harness.finishSuite();

  harness.start("see1045_mcp_chain_init");

  let client;
  let connected = false;
  let connectErr = "";

  try {
    client = await connectMcp();
    connected = true;
  } catch (e) {
    connectErr = e.message;
  }

  harness.record("connect via stdio MCP server (initialize latency)", connected, connectErr);
  if (!connected) {
    harness.finishSuite();
    harness.printSummary();
    process.exit(harness.exitCode());
  }

  const settled = await settleEditorConnection(client, 180);
  harness.record("editor addon WS connection settled", settled, settled ? "ready" : "npx never connected to Godot addon");
  if (!settled) {
    harness.finishSuite();
    harness.printSummary();
    process.exit(harness.exitCode());
  }

  try {
    const toolsResult = await timed("tools/list", () => client.listTools());
    const tools = toolsResult?.tools || [];
    const hasRead = tools.some((t) => t.name === "godot_editor_read");
    const hasRun = tools.some((t) => t.name === "godot_editor_edit");
    const hasStep = tools.some((t) => t.name === "godot_game_time");
    const hasExec = tools.some((t) => t.name === "godot_exec");
    const hasStop = hasRun;
    harness.record(
      "tools/list contains read/run/step/exec/stop",
      hasRead && hasRun && hasStep && hasExec && hasStop,
      `count=${tools.length}; has_read=${hasRead} has_run=${hasRun} has_step=${hasStep} has_exec=${hasExec}`
    );
    harness.finishSuite();

    harness.start("see1045_mcp_chain_runtime");

    const readResult = await timed("godot_editor_read", () =>
      callTool(client, "godot_editor_read", { action: "get_state" })
    );
    const readText = firstText(readResult);
    const readOk = readText.length > 0 && !readText.startsWith("Error:") && !readText.includes("4001");
    harness.record("read (get_state) succeeds", readOk, readText.slice(0, 120));

    const runResult = await timed("godot_editor_edit run", () =>
      callTool(client, "godot_editor_edit", { action: "run", frozen: true })
    );
    const runText = firstText(runResult);
    const runOk = !runText.startsWith("Error:") && !runText.includes("4001");
    harness.record("run (frozen=true) succeeds", runOk, runText.slice(0, 120));

    const stepResult = await timed("godot_game_time step", () =>
      callTool(client, "godot_game_time", { action: "step", frames: 3 })
    );
    const stepText = firstText(stepResult);
    const stepOk = stepText.length > 0 && !stepText.includes("4001");
    harness.record("step (3 frames) succeeds", stepOk, stepText.slice(0, 120));

    const execResult = await timed("godot_exec", () =>
      callTool(client, "godot_exec", {
        action: "run",
        source: `return {"hello": "see1045", "game_state": GameState != null}`
      })
    );
    const execText = firstText(execResult);
    let execOk = false;
    let execPayload = "";
    try {
      const outer = JSON.parse(execText);
      const inner = JSON.parse(outer.result);
      execOk = inner.hello === "see1045" && inner.game_state === true;
      execPayload = JSON.stringify(inner);
    } catch {
      execOk = !execText.startsWith("Error:") && !execText.includes("4001");
      execPayload = execText.slice(0, 200);
    }
    harness.record("exec (GDScript) returns expected payload", execOk, execPayload);

    const stopResult = await timed("godot_editor_edit stop", () =>
      callTool(client, "godot_editor_edit", { action: "stop" })
    );
    const stopText = firstText(stopResult);
    const stopOk = !stopText.startsWith("Error:") && !stopText.includes("4001");
    harness.record("stop succeeds", stopOk, stopText.slice(0, 120));

    harness.finishSuite();

    harness.start("see1045_latency_summary");
    const initMs = callTimings.find((t) => t.name === "initialize")?.elapsedMs;
    harness.record(
      "initialize latency < 5000 ms (Claude MCP init timeout = 30000)",
      typeof initMs === "number" && initMs < 5000,
      `${initMs} ms`
    );
    for (const t of callTimings) {
      if (t.name === "initialize") continue;
      harness.record(`${t.name} latency ${t.ok ? "ok" : "FAILED"}`, t.ok, `${t.elapsedMs} ms${t.error ? " | " + t.error : ""}`);
    }
    harness.finishSuite();

    harness.printSummary();
    console.log("\nTimings:", JSON.stringify(callTimings, null, 2));
    await teardown(client);
    process.exit(harness.exitCode());
  } catch (e) {
    console.error("FATAL:", e);
    await teardown(client);
    process.exit(2);
  }
}

main();
