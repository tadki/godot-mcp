// Save / Load round-trip using slot 7, plus cleanup.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();
const TEST_SLOT = 7;

try {
  await client.connect();
  harness.start("06_save_load_roundtrip");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  // Reset and seed state
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("SaveLoadTest")`);
  await client.exec(`EconomyManager.deserialize({"like_total":1234.0,"lcps":5.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
  await client.exec(`GameState.gold = 42`);

  // Clean any prior test slot
  await client.exec(`SaveManager.mcp_delete_test_snapshot(${TEST_SLOT})`);

  const saveOk = await client.exec(`return {"ok": SaveManager.mcp_save_test_snapshot(${TEST_SLOT})}`);
  harness.record("save to slot 7", saveOk?.ok === true, JSON.stringify(saveOk));

  // Mutate state
  await client.exec(`GameState.gold = 0`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);

  const loadOk = await client.exec(`return {"ok": SaveManager.mcp_load_test_snapshot(${TEST_SLOT})}`);
  harness.record("load from slot 7", loadOk?.ok === true, JSON.stringify(loadOk));

  const restored = await client.exec(`return {"gold": GameState.gold, "like_total": EconomyManager.get_like_total()}`);
  harness.record("gold restored", restored?.gold === 42, `gold=${restored?.gold}`);
  harness.record("like_total restored", restored?.like_total === 1234, `like_total=${restored?.like_total}`);

  // Cleanup
  await client.exec(`SaveManager.mcp_delete_test_snapshot(${TEST_SLOT})`);
  const stillHas = await client.exec(`return {"has": SaveManager.has_save(${TEST_SLOT})}`);
  harness.record("test slot cleaned up", stillHas?.has === false, JSON.stringify(stillHas));

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
