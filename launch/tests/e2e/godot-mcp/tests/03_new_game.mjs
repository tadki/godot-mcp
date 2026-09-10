// New game flow: create profile, press NewGame, verify GameState, frontend scene transition, and profile-creation UI.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

async function resetPlayer() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevyE2E")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
}

try {
  await client.connect();
  harness.start("03_new_game_flow");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  await resetPlayer();
  const profile = await client.exec(`return ProfileManager._mcp_state()`);
  harness.record("profile created", profile?.player_name === "RevyE2E", JSON.stringify(profile));

  const gs = await client.exec(`return GameState._mcp_state()`);
  harness.record("GameState reset", gs?.gold === 0 && gs?.player_level === 1, JSON.stringify(gs));

  // Probe the NewGame button: it must exist, be a Button, and emit pressed cleanly.
  const startBtn = await client.exec(`
    var scene = tree.current_scene
    var btn = scene.find_child("*NewGame*", true, false)
    var info = {"found": btn != null, "is_button": false, "pressed_signal": false}
    if btn != null and btn is Button:
      info["is_button"] = true
      btn.pressed.emit()
      info["pressed_signal"] = true
    return info
  `);
  await client.gameStep(2);
  harness.record("NewGame button reachable and pressed signal emitted", startBtn?.found === true && startBtn?.is_button === true && startBtn?.pressed_signal === true, JSON.stringify(startBtn));

  // Frontend transition: NewGame should change the running scene to ProfileCreation.
  await client.gameThaw();
  await client.gameStep(10);
  const afterStart = await client.exec(`
    var scene = tree.current_scene
    var info = {"scene": String(scene.name), "paused": tree.paused}
    var labels = []
    var buttons = []
    var stack = [scene]
    while stack.size() > 0:
      var n = stack.pop_back()
      if n is Label:
        labels.append(String(n.name))
      if n is Button:
        buttons.append(String(n.name))
      for c in n.get_children():
        stack.append(c)
    info["labels"] = labels
    info["buttons"] = buttons
    return info
  `);
  harness.record("scene transitions to ProfileCreation after NewGame", afterStart?.scene === "ProfileCreation", JSON.stringify(afterStart));
  harness.record("ProfileCreation UI has labels", (afterStart?.labels?.length ?? 0) > 0, `labels=${JSON.stringify(afterStart?.labels)}`);
  harness.record("ProfileCreation UI has buttons", (afterStart?.buttons?.length ?? 0) > 0, `buttons=${JSON.stringify(afterStart?.buttons)}`);

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
