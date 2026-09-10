// Shadow Console system: data load, nexus/tunnel graph, and core queries.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("08_shadow_console");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  const initialized = await client.exec(`return {"ok": ShadowConsoleSubsystem._initialized, "nexus_count": ShadowConsoleSubsystem._nexus_data.size(), "tunnel_count": ShadowConsoleSubsystem._tunnel_data.size()}`);
  harness.record("shadow console initialized", initialized?.ok === true, JSON.stringify(initialized));
  harness.record("nexus count is positive", (initialized?.nexus_count ?? 0) > 0, `count=${initialized?.nexus_count}`);
  harness.record("tunnel count is positive", (initialized?.tunnel_count ?? 0) > 0, `count=${initialized?.tunnel_count}`);

  // Verify adjacency built
  const adj = await client.exec(`return {"adjacency_size": ShadowConsoleSubsystem._adjacency.size()}`);
  harness.record("graph adjacency built", (adj?.adjacency_size ?? 0) > 0, `size=${adj?.adjacency_size}`);

  // get_all_nexus_ids returns Array[StringName]; convert to plain strings for JSON.
  const ids = await client.exec(`
    var raw = ShadowConsoleSubsystem.get_all_nexus_ids().slice(0, 5)
    var out = []
    for id in raw:
      out.append(String(id))
    return {"ids": out}
  `);
  harness.record("get_all_nexus_ids works", Array.isArray(ids?.ids) && ids.ids.length > 0, JSON.stringify(ids));

  await client.gameThaw();
  await client.editor("stop");
  harness.finishSuite();
  await client.close();
  harness.printSummary();
  process.exit(harness.exitCode());
} catch (e) {
  console.error("FATAL:", e);
  await teardown(client);
  process.exit(2);
}
