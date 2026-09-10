// Shared godot-mcp client wrapper for KingOfLikes E2E tests.
// Connects to the Windows Godot editor running the godot-mcp addon via stdio.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";

function detectWindowsHost() {
  try {
    const out = spawnSync("ip", ["route", "show", "default"], { encoding: "utf8" }).stdout ?? "";
    const m = out.match(/via\s+(\S+)/);
    if (m) return m[1];
  } catch {
    // not WSL2
  }
  return "localhost";
}

export const GODOT_HOST = process.env.GODOT_HOST ?? detectWindowsHost();
// SEE-1070 #1: no hardcoded "6550" fallback. The per-agent port must come from
// the environment (agent-ports.json is the SSOT, sourced by the launcher). If
// GODOT_PORT is unset, leave it undefined so the misconfiguration is visible
// (connect() below throws a clear error) rather than silently colliding on the
// shared default port.
export const GODOT_PORT = process.env.GODOT_PORT;

/** Returns true if the MCP tool text content represents an error response. */
function isMcpErrorText(text) {
  return typeof text === "string" && text.startsWith("Error:");
}

export class GodotMcpClient {
  constructor() {
    this.client = new Client({ name: "kole-e2e", version: "1.0.0" });
    this.connected = false;
  }

  async connect() {
    await this.client.connect(new StdioClientTransport({
      command: "npx",
      args: ["-y", "@satelliteoflove/godot-mcp"],
      env: { ...process.env, GODOT_HOST, GODOT_PORT },
    }));
    this.connected = true;
    // Initial handshake: the first MCP call after connect may fail with
    // "Not connected to Godot" if the bridge hasn't finished its retry loop.
    // Probe the editor until it responds with a real payload.
    for (let i = 0; i < 10; i++) {
      try {
        const text = await this.callText("godot_editor_read", { action: "get_state" });
        if (!isMcpErrorText(text) && text.includes("godot_version")) return;
      } catch {}
      await sleep(800);
    }
    throw new Error(`MCP server connected but could not reach Godot editor at ${GODOT_HOST}:${GODOT_PORT}. Run npx godot-mcp manually to diagnose, or ensure only one MCP client is active.`);
  }

  async call(name, args = {}) {
    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async callText(name, args = {}) {
    const result = await this.call(name, args);
    const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
    if (!text) throw new Error(`MCP tool ${name} returned no text content`);
    return text;
  }

  /** godot_exec run: returns parsed object from `{completed, result}` outer JSON. */
  async exec(source, opts = {}) {
    const text = await this.callText("godot_exec", {
      action: "run",
      source,
      budget_ms: opts.budget_ms ?? 10000,
    });
    if (isMcpErrorText(text)) {
      throw new Error(`godot_exec error: ${text.slice(0, 400)}`);
    }
    let outer;
    try {
      outer = JSON.parse(text);
    } catch (e) {
      throw new Error(`godot_exec returned non-JSON: ${text.slice(0, 400)}`);
    }
    if (outer.runtime_errors && outer.runtime_errors.length > 0) {
      throw new Error(`godot_exec runtime error: ${JSON.stringify(outer.runtime_errors).slice(0, 800)}`);
    }
    if (outer.result === undefined || outer.result === null) {
      return null;
    }
    try {
      return JSON.parse(outer.result);
    } catch (e) {
      // Result is a primitive string returned by GDScript return.
      return outer.result;
    }
  }

  async editor(action, extra = {}) {
    return this.call("godot_editor_edit", { action, ...extra });
  }

  async gameStep(frames = 3) {
    return this.call("godot_game_time", { action: "step", frames });
  }

  async gameStepMs(duration_ms) {
    return this.call("godot_game_time", { action: "step", duration_ms });
  }

  async gameStepUntil(until, opts = {}) {
    return this.call("godot_game_time", {
      action: "step_until",
      until,
      max_ms: opts.max_ms ?? 20000,
      report: opts.report,
    });
  }

  async gameFreeze() {
    return this.call("godot_game_time", { action: "freeze" });
  }

  async gameThaw() {
    return this.call("godot_game_time", { action: "thaw" });
  }

  async gameStatus() {
    return this.call("godot_game_time", { action: "status" });
  }

  async runtimeDigest(opts = {}) {
    return this.call("godot_runtime_state", {
      action: "digest",
      select: opts.select ?? "auto",
      paths: opts.paths,
      include: opts.include,
    });
  }

  async editorRead(action, opts = {}) {
    return this.call("godot_editor_read", { action, ...opts });
  }

  async editorReadText(action, opts = {}) {
    const text = await this.callText("godot_editor_read", { action, ...opts });
    if (isMcpErrorText(text)) throw new Error(text);
    return JSON.parse(text);
  }

  async projectInfo() {
    return this.call("godot_project", { action: "get_info" });
  }

  async inputSequence(inputs, opts = {}) {
    return this.call("godot_input", {
      action: "sequence",
      inputs,
      screenshot_at_ms: opts.screenshot_at_ms,
      screenshot_max_width: opts.screenshot_max_width,
      report: opts.report,
    });
  }

  async inputMap() {
    return this.call("godot_input", { action: "get_map" });
  }

  async nodeRead(action, opts = {}) {
    return this.call("godot_node_read", { action, ...opts });
  }

  async nodeReadText(action, opts = {}) {
    const text = await this.callText("godot_node_read", { action, ...opts });
    if (isMcpErrorText(text)) throw new Error(text);
    return JSON.parse(text);
  }

  async close() {
    if (this.connected) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tear down for a test: thaw + stop, swallowing errors. */
export async function teardown(client) {
  if (!client) return;
  try { await client.gameThaw(); } catch {}
  try { await client.editor("stop"); } catch {}
  await client.close();
}

/** Run the game frozen and step N frames to let autoloads settle. */
export async function runFrozenAndBoot(client, bootFrames = 5) {
  await client.editor("run", { frozen: true });
  await client.gameStep(bootFrames);
}
