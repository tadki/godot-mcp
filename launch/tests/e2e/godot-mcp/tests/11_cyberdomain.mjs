// Cyber Domain subsystem: container creation, dimensions, serialization round-trip.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("11_cyber_domain");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  const state = await client.exec(`
    var cd = CyberDomainSubsystem.get_cyber_domain()
    var w = 0
    var h = 0
    if cd != null:
      w = cd.cols
      h = cd.rows
    return {
      "has_domain": cd != null,
      "width": w,
      "height": h
    }
  `);
  harness.record("CyberDomain instantiated", state?.has_domain === true, JSON.stringify(state));
  harness.record("CyberDomain dimensions 8x8", state?.width === 8 && state?.height === 8, `w=${state?.width} h=${state?.height}`);

  // Serialization round trip
  const serialized = await client.exec(`return {"data": CyberDomainSubsystem.serialize()}`);
  harness.record("serialize produces layout", serialized?.data?.layout != null, JSON.stringify(serialized).slice(0, 200));

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
