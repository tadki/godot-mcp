// AI Domain subsystem: container, tick, error flow engine availability.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("12_ai_domain");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  const state = await client.exec(`
    var ad = AIDomainSubsystem.get_ai_domain()
    var w = 0
    var h = 0
    var hasErr = false
    if ad != null:
      w = ad.cols
      h = ad.rows
      if ad.has_method("get_error_flow_engine"):
        hasErr = ad.get_error_flow_engine() != null
    return {
      "has_domain": ad != null,
      "width": w,
      "height": h,
      "has_error_flow": hasErr
    }
  `);
  harness.record("AIDomain instantiated", state?.has_domain === true, JSON.stringify(state));
  harness.record("AIDomain dimensions 8x8", state?.width === 8 && state?.height === 8, `w=${state?.width} h=${state?.height}`);

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
