// Sane subsystem: node data, layout, adjacency graph.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("10_sane_subsystem");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  const state = await client.exec(`
    return {
      "node_count": SaneSubsystem._node_data.size(),
      "layout_count": SaneSubsystem._node_layouts.size(),
      "adjacency_count": SaneSubsystem._adjacency.size(),
      "has_target_resolver": SaneSubsystem._target_resolver != null,
      "sp": SaneSubsystem._available_sp
    }
  `);
  harness.record("node data loaded", (state?.node_count ?? 0) > 0, `count=${state?.node_count}`);
  harness.record("node layouts loaded", (state?.layout_count ?? 0) > 0, `count=${state?.layout_count}`);
  harness.record("adjacency graph built", (state?.adjacency_count ?? 0) > 0, `size=${state?.adjacency_count}`);
  harness.record("target resolver set up", state?.has_target_resolver === true, JSON.stringify(state));

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
