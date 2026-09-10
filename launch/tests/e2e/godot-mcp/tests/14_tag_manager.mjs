// Tag manager + Effect manager + LikeHeartManager + EventBus subsystem smoke tests.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("14_core_autoloads");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  // TagManager
  const tm = await client.exec(`
    var cls = "missing"
    if TagManager != null:
      cls = "ok"
    return {"class": cls, "has_mcp_state": TagManager != null and TagManager.has_method("_mcp_state")}
  `);
  harness.record("TagManager present", tm != null, JSON.stringify(tm));

  // EffectManager attribute calc
  const em = await client.exec(`
    return {
      "result": EffectManager.calculate_attribute("heart", &"ClickValue", 1.0)
    }
  `);
  harness.record("EffectManager attribute calc works", typeof em?.result === "number", JSON.stringify(em));

  // LikeHeartManager
  const lh = await client.exec(`return LikeHeartManager._mcp_state()`);
  harness.record("LikeHeartManager._mcp_state works", typeof lh?.registered_count === "number", JSON.stringify(lh));

  // EventBus signal routing sanity
  const bus = await client.exec(`return {"has_signal": EventBus.has_signal("attribute_changed")}`);
  harness.record("EventBus has attribute_changed signal", bus?.has_signal === true, JSON.stringify(bus));

  // UniqueEffectRegistry
  const uer = await client.exec(`
    var cls = "missing"
    if UniqueEffectRegistry != null:
      cls = "ok"
    return {"class": cls}
  `);
  harness.record("UniqueEffectRegistry present", uer != null, JSON.stringify(uer));

  // InventorySubsystem
  const inv = await client.exec(`
    var present = InventorySubsystem != null
    var hasMethod = false
    if present:
      hasMethod = InventorySubsystem.has_method("serialize")
    return {"inv": present, "has_method": hasMethod}
  `);
  harness.record("InventorySubsystem serialize method exists", inv?.inv === true && inv?.has_method === true, JSON.stringify(inv));

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
