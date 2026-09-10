// Hardware system: verify definitions loaded, unlock/purchase/upgrade change state.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("04_hardware_system");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  // Hardware definitions are loaded but hardware instances are not created until requested.
  await client.exec(`HardwareManager.ensure_all_created()`);

  const state = await client.exec(`return HardwareManager._mcp_state()`);
  harness.record("hardware definitions loaded", state?.hardware_count > 0, `count=${state?.hardware_count}`);

  const firstKey = state?.hardware ? Object.keys(state.hardware)[0] : null;
  harness.record("first hardware entry readable", firstKey != null, `first=${firstKey}`);

  // Unlock/purchase/upgrade first hardware
  if (firstKey) {
    await client.exec(`HardwareManager.unlock("${firstKey}")`);
    await client.exec(`HardwareManager.purchase("${firstKey}")`);
    await client.exec(`HardwareManager.upgrade("${firstKey}")`);
    const after = await client.exec(`return HardwareManager._mcp_state()`);
    const hw = after?.hardware?.[firstKey];
    harness.record("hardware upgraded", hw?.unlocked === true && hw?.purchased === true && hw?.upgrade_count === 1, JSON.stringify(hw));
  }

  // Reset hardware state to avoid polluting real saves
  await client.exec(`HardwareManager.deserialize({"hardware_states":[]})`);

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
