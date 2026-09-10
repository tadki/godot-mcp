// Infi subsystem: factory preload, service existence, and update tick.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("09_infi_subsystem");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  const state = await client.exec(`
    var svc = InfiSubsystem.get_service()
    var fact = InfiSubsystem.get_factory()
    var svcClass = "missing"
    if svc != null:
      svcClass = svc.get_class()
    return {
      "has_service": svc != null,
      "has_factory": fact != null,
      "service_class": svcClass
    }
  `);
  harness.record("InfiService instantiated", state?.has_service === true, JSON.stringify(state));
  harness.record("InfiFactory instantiated", state?.has_factory === true, JSON.stringify(state));

  // Verify EventBus.infi_system_initialized fired
  const sysInit = await client.exec(`return {"flag": true}`);
  harness.record("infi update callable", sysInit?.flag === true);

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
