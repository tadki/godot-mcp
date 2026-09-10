// Economy system: add likes, verify EPD settlement, LCPS changes, and offline earnings.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("05_economy_system");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  // Reset economy
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
  let before = await client.exec(`return EconomyManager._mcp_state()`);
  harness.record("economy reset to zero", before?.like_total === 0 && before?.epd === 0, JSON.stringify(before));

  // EPD settlement requires LCPS > 0 to drive the process timer; use a small value
  // so passive gain doesn't push the total past the expected floor(25/10)=2 EPD.
  await client.exec(`EconomyManager.set_lcps(1.0)`);
  await client.gameStep(3);

  // Add likes and step to allow EPD settlement
  await client.exec(`EconomyManager.add_likes(25.0)`);
  await client.gameStep(3);
  let after = await client.exec(`return EconomyManager._mcp_state()`);
  harness.record("add likes updates total", after?.like_total >= 25, `total=${after?.like_total}`);
  harness.record("EPD auto-settled (floor like/10)", after?.epd === 2, `epd=${after?.epd}`);

  // LCPS via EconomyManager.set_lcps
  await client.exec(`EconomyManager.set_lcps(10.0)`);
  await client.gameStep(3);
  let lcpsState = await client.exec(`return EconomyManager._mcp_state()`);
  harness.record("set_lcps updates lcps", lcpsState?.lcps === 10, `lcps=${lcpsState?.lcps}`);

  // Offline earnings calculation
  const offline = await client.exec(`return {"earnings": EconomyManager.calculate_offline_earnings()}`);
  harness.record("offline earnings calculable", typeof offline?.earnings === "number", `earnings=${offline?.earnings}`);

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
