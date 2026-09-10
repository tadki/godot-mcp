// SANE subsystem full E2E: backend init -> frontend visible -> input -> state change -> visual feedback.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

const BTN_SANE = "/root/UIFramework/MainHBox/LeftPanel/BottomBar/BottomBarMargin/BottomBarHBox/SANEBox/ButtonSANE";
const SANE_TREE = "/root/UIFramework/MainHBox/LeftPanel/SceneArea/SceneCanvas/MiddleOverlay/SaneZoomableCanvas/SaneTree";

async function enterMainGame() {
  // Reset player state and start a new game to reach the main UIFramework scene.
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevyE2E")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);

  // TitleScreen -> ProfileCreation
  await client.exec(`
    var scene = tree.current_scene
    var btn = scene.find_child("*NewGame*", true, false)
    if btn != null and btn is Button:
      btn.pressed.emit()
    return {"scene": String(scene.name)}
  `);
  await client.gameStep(2);
  await client.gameThaw();
  await client.gameStep(20);

  // ProfileCreation -> UIFramework
  await client.exec(`
    var scene = tree.current_scene
    if scene == null:
      return {"err": "no scene"}
    var name_edit = scene.find_child("*NameEdit*", true, false)
    var btn = scene.find_child("*Start*", true, false)
    if name_edit != null:
      name_edit.text = "RevyE2E"
      name_edit.text_changed.emit("RevyE2E")
    if btn != null and btn is Button:
      btn.pressed.emit()
    return {"name_edit": name_edit != null, "btn": btn != null}
  `);
  await client.gameFreeze();
  await client.gameStep(30);
}

async function backendInit() {
  harness.start("16_sane_backend_init");
  const state = await client.exec(`
    return {
      "node_count": SaneSubsystem._node_data.size(),
      "layout_count": SaneSubsystem._node_layouts.size(),
      "adjacency_count": SaneSubsystem._adjacency.size(),
      "has_target_resolver": SaneSubsystem._target_resolver != null,
      "sp": SaneSubsystem.get_available_sp()
    }
  `);
  harness.record("node data loaded", (state?.node_count ?? 0) > 0, `count=${state?.node_count}`);
  harness.record("node layouts loaded", (state?.layout_count ?? 0) > 0, `count=${state?.layout_count}`);
  harness.record("adjacency graph built", (state?.adjacency_count ?? 0) > 0, `size=${state?.adjacency_count}`);
  harness.record("target resolver set up", state?.has_target_resolver === true, JSON.stringify(state));
  harness.record("available sp is numeric", typeof state?.sp === "number", `sp=${state?.sp}`);
  harness.finishSuite();
}

async function frontendVisible() {
  harness.start("16_sane_frontend_visible");

  const current = await client.exec(`
    var s = tree.current_scene
    return {"scene": "null" if s == null else String(s.name)}
  `);
  harness.record("current scene is UIFramework", current?.scene === "UIFramework", JSON.stringify(current));

  const btnProps = await client.exec(`
    var btn = tree.root.get_node("${BTN_SANE}")
    if btn == null:
      return {"found": false}
    return {"found": true, "visible": btn.visible, "disabled": btn.disabled, "text": btn.text}
  `).catch(() => ({}));
  harness.record("ButtonSANE exists and visible", btnProps?.found === true && btnProps?.visible === true, JSON.stringify(btnProps));
  harness.record("ButtonSANE is enabled", btnProps?.found === true && btnProps?.disabled === false, JSON.stringify(btnProps));

  const treeProps = await client.exec(`
    var n = tree.root.get_node("${SANE_TREE}")
    if n == null:
      return {"found": false}
    return {"found": true, "visible": n.visible}
  `).catch(() => ({}));
  harness.record("SaneTree starts hidden", treeProps?.found === true && treeProps?.visible === false, JSON.stringify(treeProps));

  harness.finishSuite();
}

async function inputAndStateChange() {
  harness.start("16_sane_input_and_state_change");

  // Click SANE button (real UI signal injection).
  await client.exec(`
    var btn = tree.root.get_node("${BTN_SANE}")
    if btn != null:
      btn.pressed.emit()
    return {"btn_found": btn != null}
  `);
  await client.gameStep(10);

  const after = await client.exec(`
    var n = tree.root.get_node("${SANE_TREE}")
    if n == null:
      return {"found": false}
    return {"found": true, "visible": n.visible}
  `).catch(() => ({}));
  harness.record("SaneTree visible after SANE button click", after?.found === true && after?.visible === true, JSON.stringify(after));

  // Read backend state to confirm the panel request was processed.
  const backend = await client.exec(`
    var sub = SaneSubsystem
    var tree_node = tree.root.get_node("${SANE_TREE}")
    return {
      "sp": sub.get_available_sp(),
      "node_count": sub._node_data.size(),
      "tree_visible": tree_node.visible if tree_node != null else null,
      "tree_node_visuals": tree_node._node_visuals.size() if tree_node != null else 0
    }
  `);
  harness.record("backend still has node data", (backend?.node_count ?? 0) > 0, `count=${backend?.node_count}`);
  harness.record("SaneTree visible backend-side", backend?.tree_visible === true, JSON.stringify(backend));

  // Known issue: node visuals lazy-populate only when _canvas is set, which does not happen
  // automatically in this environment. Capture this as a non-fatal diagnostic.
  harness.record("SaneTree node visuals populated", (backend?.tree_node_visuals ?? 0) > 0, `visuals=${backend?.tree_node_visuals}`);

  harness.finishSuite();
}

async function visualFeedback() {
  harness.start("16_sane_visual_feedback");

  // Runtime screenshot after SANE panel is toggled visible.
  const screenshot = await client.editorRead("screenshot_game", { max_width: 640 });
  const imgText = screenshot?.content?.find((c) => c.type === "image")?.data;
  const pngBuffer = imgText ? Buffer.from(imgText, "base64") : null;
  const isPng = pngBuffer != null && pngBuffer.length > 0 && pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50 && pngBuffer[2] === 0x4E && pngBuffer[3] === 0x47;
  harness.record("runtime screenshot is valid PNG", isPng, `bytes=${pngBuffer?.length ?? 0}`);

  // Verify SaneTree node visible property again in the same frozen frame.
  const treeProps = await client.exec(`
    var n = tree.root.get_node("${SANE_TREE}")
    if n == null:
      return {"found": false}
    return {"found": true, "visible": n.visible}
  `).catch(() => ({}));
  harness.record("SaneTree remains visible at screenshot time", treeProps?.found === true && treeProps?.visible === true, JSON.stringify(treeProps));

  harness.finishSuite();
}

try {
  await client.connect();

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  await backendInit();
  await enterMainGame();
  await frontendVisible();
  await inputAndStateChange();
  await visualFeedback();

  await client.gameThaw();
  await client.editor("stop");
  await client.close();
  harness.printSummary();
  process.exit(harness.exitCode());
} catch (e) {
  console.error("FATAL:", e);
  await teardown(client);
  process.exit(2);
}
