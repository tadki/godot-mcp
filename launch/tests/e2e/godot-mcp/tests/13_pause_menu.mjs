// Pause menu / input handling: navigate to ProfileCreation via NewGame and verify
// ESC (ui_cancel) input is handled cleanly without crash or scene regression.
// The current build keeps tree.paused=true while in UI scenes (title/profile), so
// full pause-menu overlay testing requires a gameplay scene.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  await client.connect();
  harness.start("13_pause_input_sanity");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  // Reset state and start new-game flow so we test input on ProfileCreation.
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevyE2E")`);
  await client.exec(`
    var scene = tree.current_scene
    var btn = scene.find_child("*NewGame*", true, false)
    if btn != null and btn is Button:
      btn.pressed.emit()
    return {"found": btn != null}
  `);
  await client.gameThaw();
  await client.gameStep(10);

  const before = await client.exec(`
    var scene = tree.current_scene
    return {"paused": tree.paused, "scene": String(scene.name)}
  `);
  harness.record("navigated to ProfileCreation before ESC test", before?.scene === "ProfileCreation", JSON.stringify(before));

  // Inject ESC via input sequence then step
  await client.inputSequence([{ action_name: "ui_cancel", start_ms: 0, duration_ms: 0 }]);
  await client.gameStep(5);
  const afterEsc = await client.exec(`
    var scene = tree.current_scene
    return {"paused": tree.paused, "scene": String(scene.name)}
  `);
  harness.record("ESC input handled without crash on ProfileCreation", afterEsc?.scene === "ProfileCreation", JSON.stringify(afterEsc));

  // Inject ESC again
  await client.inputSequence([{ action_name: "ui_cancel", start_ms: 0, duration_ms: 0 }]);
  await client.gameStep(5);
  const afterSecond = await client.exec(`
    var scene = tree.current_scene
    return {"paused": tree.paused, "scene": String(scene.name)}
  `);
  harness.record("second ESC input stable", afterSecond?.scene === "ProfileCreation", JSON.stringify(afterSecond));

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
