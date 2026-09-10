// Vendor system: arrival cycle, offer generation, and purchase path.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("07_vendor_system");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  // Vendor state introspection
  const vendorState = await client.exec(`
    return {
      "initialized": VendorSubsystem._initialized,
      "is_available": VendorSubsystem._is_available,
      "has_offer": VendorSubsystem._current_offer != null,
      "arrival_timer_positive": VendorSubsystem._arrival_timer > 0.0
    }
  `);
  harness.record("vendor subsystem initialized", vendorState?.initialized === true, JSON.stringify(vendorState));
  harness.record("vendor arrival timer running", vendorState?.arrival_timer_positive || vendorState?.is_available, JSON.stringify(vendorState));

  // Verify pricing resolver exists
  const resolver = await client.exec(`return {"has_pricing": VendorSubsystem._pricing_resolver != null}`);
  harness.record("pricing resolver built", resolver?.has_pricing === true, JSON.stringify(resolver));

  // Verify offer generator exists
  const gen = await client.exec(`return {"has_generator": VendorSubsystem._offer_generator != null}`);
  harness.record("offer generator built", gen?.has_generator === true, JSON.stringify(gen));

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
