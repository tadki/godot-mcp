// Smoke test: verify MCP connectivity, project info, scene tree, autoloads,
// and that running the game frozen + step + thaw + stop works end-to-end.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

try {
  harness.start("01_smoke_connectivity");

  let connected = false;
  let connectErr = "";
  try {
    await client.connect();
    connected = true;
  } catch (e) {
    connectErr = e.message;
  }
  harness.record("connect to Godot editor via godot-mcp", connected, connectErr);
  if (!connected) {
    harness.finishSuite();
    harness.printSummary();
    process.exit(harness.exitCode());
  }

  const infoText = await client.callText("godot_project", { action: "get_info" });
  const infoOk = infoText.includes("KingOfLikes") && !infoText.startsWith("Error:");
  harness.record("project info readable", infoOk, infoText.slice(0, 200));

  const stateBefore = await client.editorReadText("get_state");
  harness.record("editor read get_state", !!stateBefore.godot_version, `scene=${stateBefore.current_scene}`);

  const sceneTree = await client.nodeReadText("get_scene_tree", { max_depth: 2, max_children: 30 });
  harness.record("scene tree readable", sceneTree != null && Array.isArray(sceneTree.children), `root=${sceneTree?.name}`);

  harness.finishSuite();

  // -- Game launch smoke --
  harness.start("01_smoke_game_launch");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  harness.record("run frozen + boot frames", true);

  // Verify game root has autoloads. Names returned as StringName — convert to String for JSON.
  const autoCount = await client.exec(
    `
var cnt = 0
var names = []
for child in tree.root.get_children():
  cnt += 1
  if names.size() < 6:
    names.append(String(child.name))
return {"root_child_count": cnt, "first_children": names}
`
  );
  harness.record("game root has children (autoloads running)", (autoCount && autoCount.root_child_count > 5), `count=${autoCount && autoCount.root_child_count} first=${JSON.stringify(autoCount?.first_children)}`);

  // Verify GameState autoload is reachable
  const gs = await client.exec(
    `return {"has_game_state": GameState != null, "gold": GameState.gold}`
  );
  harness.record("GameState autoload accessible", gs && gs.has_game_state, `gold=${gs && gs.gold}`);

  // Verify EconomyManager accessible and _mcp_state works
  const eco = await client.exec(`return EconomyManager._mcp_state()`);
  harness.record("EconomyManager._mcp_state() works", eco && typeof eco.like_total === "number", JSON.stringify(eco));

  await client.gameThaw();
  await client.editor("stop");
  harness.record("thaw + stop", true);

  harness.finishSuite();
  harness.printSummary();
  process.exit(harness.exitCode());
} catch (e) {
  console.error("FATAL:", e);
  await teardown(client);
  process.exit(2);
}
