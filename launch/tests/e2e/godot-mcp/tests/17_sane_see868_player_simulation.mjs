// SEE-868 SANE player-simulation E2E.
// Extends 16_sane_full.mjs with focused checks for the three reported bugs:
//   1. SaneLink visual skeleton is drawn (non-zero rect containing both endpoints).
//   2. Wheel zoom is blocked when the cursor is over a SaneNode (MOUSE_FILTER_STOP).
//   3. Opening SANE hides InfiVisual (PZM CROSS_ZONE_CONFLICTS; Infi hidden by default).

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

const BTN_SANE = "/root/UIFramework/MainHBox/LeftPanel/BottomBar/BottomBarMargin/BottomBarHBox/SANEBox/ButtonSANE";
const SANE_TREE = "/root/UIFramework/MainHBox/LeftPanel/SceneArea/SceneCanvas/MiddleOverlay/SaneZoomableCanvas/SaneTree";
const SANE_ZOOM_CANVAS = "/root/UIFramework/MainHBox/LeftPanel/SceneArea/SceneCanvas/MiddleOverlay/SaneZoomableCanvas";
const INFI_VISUAL = "/root/UIFramework/MainHBox/RightPanel/RightPanelOverlay/RightPanelCanvas/InfiVisual";

async function enterMainGame() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE868")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);

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

  await client.exec(`
    var scene = tree.current_scene
    if scene == null:
      return {"err": "no scene"}
    var name_edit = scene.find_child("*NameEdit*", true, false)
    var btn = scene.find_child("*Start*", true, false)
    if name_edit != null:
      name_edit.text = "RevySEE868"
      name_edit.text_changed.emit("RevySEE868")
    if btn != null and btn is Button:
      btn.pressed.emit()
    return {"name_edit": name_edit != null, "btn": btn != null}
  `);
  await client.gameFreeze();
  await client.gameStep(30);
}

async function backendInit() {
  harness.start("17_see868_backend_init");
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
  harness.start("17_see868_frontend_visible");

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

  const infiProps = await client.exec(`
    var n = tree.root.get_node("${INFI_VISUAL}")
    if n == null:
      return {"found": false}
    return {"found": true, "visible": n.visible}
  `).catch(() => ({}));
  harness.record("InfiVisual exists before SANE opens", infiProps?.found === true, JSON.stringify(infiProps));

  harness.finishSuite();
}

async function inputAndStateChange() {
  harness.start("17_see868_input_and_state_change");

  // Open SANE panel.
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

  const backend = await client.exec(`
    var sub = SaneSubsystem
    var tree_node = tree.root.get_node("${SANE_TREE}")
    return {
      "sp": sub.get_available_sp(),
      "node_count": sub._node_data.size(),
      "tree_visible": tree_node.visible if tree_node != null else null,
      "tree_node_visuals": tree_node._node_visuals.size() if tree_node != null else 0,
      "tree_link_visuals": tree_node._link_visuals.size() if tree_node != null else 0
    }
  `);
  harness.record("backend still has node data", (backend?.node_count ?? 0) > 0, `count=${backend?.node_count}`);
  harness.record("SaneTree visible backend-side", backend?.tree_visible === true, JSON.stringify(backend));
  harness.record("SaneTree node visuals populated", (backend?.tree_node_visuals ?? 0) > 0, `visuals=${backend?.tree_node_visuals}`);
  harness.record("SaneTree link visuals populated", (backend?.tree_link_visuals ?? 0) > 0, `links=${backend?.tree_link_visuals}`);

  harness.finishSuite();
}

async function visualFeedback() {
  harness.start("17_see868_visual_feedback");

  const screenshot = await client.editorRead("screenshot_game", { max_width: 640 });
  const imgText = screenshot?.content?.find((c) => c.type === "image")?.data;
  const pngBuffer = imgText ? Buffer.from(imgText, "base64") : null;
  const isPng = pngBuffer != null && pngBuffer.length > 0 && pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50 && pngBuffer[2] === 0x4E && pngBuffer[3] === 0x47;
  harness.record("runtime screenshot is valid PNG", isPng, `bytes=${pngBuffer?.length ?? 0}`);

  const treeProps = await client.exec(`
    var n = tree.root.get_node("${SANE_TREE}")
    if n == null:
      return {"found": false}
    return {"found": true, "visible": n.visible}
  `).catch(() => ({}));
  harness.record("SaneTree remains visible at screenshot time", treeProps?.found === true && treeProps?.visible === true, JSON.stringify(treeProps));

  harness.finishSuite();
}

async function see868Bug1LinkSkeleton() {
  harness.start("17_see868_bug_1_link_skeleton");

  // Inspect every SaneLink rect. For a line to be drawable, the link control
  // must have a non-zero size and its rect must contain both endpoints.
  // Aggregate the per-link checks in GDScript and return a compact summary:
  // godot_exec truncates large nested returns (~200 chars), so returning the
  // full per-link array made the JS side see an empty/partial object.
  const summary = await client.exec(`
    var tree_node = tree.root.get_node("${SANE_TREE}")
    if tree_node == null:
      return {"found": false, "count": 0}
    var total = tree_node._link_visuals.size()
    var ready = 0
    var visible = 0
    var nonzero = 0
    var contain_both = 0
    var bad_names = []
    for link in tree_node._link_visuals:
      var rect = Rect2(link.position, link.size)
      var ok_ready = link.is_node_ready()
      var ok_visible = link.visible
      var ok_size = link.size.x > 0.0 and link.size.y > 0.0
      var ok_contains = rect.has_point(link.from_position) and rect.has_point(link.to_position)
      if ok_ready:
        ready = ready + 1
      if ok_visible:
        visible = visible + 1
      if ok_size:
        nonzero = nonzero + 1
      if ok_contains:
        contain_both = contain_both + 1
      if not (ok_ready and ok_visible and ok_size and ok_contains):
        bad_names.append(String(link.name))
    return {
      "found": true,
      "count": total,
      "ready": ready,
      "visible": visible,
      "nonzero_size": nonzero,
      "contain_both": contain_both,
      "bad": bad_names
    }
  `);

  harness.record("link visuals exist", (summary?.count ?? 0) > 0, `count=${summary?.count}`);
  harness.record("all links are _ready'd", summary?.count > 0 && summary?.ready === summary?.count, `ready=${summary?.ready}/${summary?.count}`);
  harness.record("all links are visible", summary?.count > 0 && summary?.visible === summary?.count, `visible=${summary?.visible}/${summary?.count}`);
  harness.record("all links have non-zero drawable size", summary?.count > 0 && summary?.nonzero_size === summary?.count, `nonzero=${summary?.nonzero_size}/${summary?.count}`);
  harness.record("all link rects contain both endpoints", summary?.count > 0 && summary?.contain_both === summary?.count, `contain_both=${summary?.contain_both}/${summary?.count}`);

  harness.finishSuite();
}

async function see868Bug2WheelZoomBlocked() {
  harness.start("17_see868_bug_2_wheel_zoom_blocked");

  // 1. Canvas zooms on wheel when cursor is over empty canvas area.
  const emptyCanvasZoom = await client.exec(`
    var zc = tree.root.get_node("${SANE_ZOOM_CANVAS}")
    if zc == null:
      return {"found": false}
    var before = zc.get_zoom()
    var ev = InputEventMouseButton.new()
    ev.button_index = MOUSE_BUTTON_WHEEL_UP
    ev.pressed = true
    zc._gui_input(ev)
    return {"found": true, "before": before, "after": zc.get_zoom()}
  `);
  harness.record("canvas zooms on wheel over empty area", emptyCanvasZoom?.found === true && (emptyCanvasZoom?.after ?? 0) > (emptyCanvasZoom?.before ?? 0), JSON.stringify(emptyCanvasZoom));

  // 2. SaneNode uses MOUSE_FILTER_STOP so wheel events on a node do not reach
  //    the parent ZoomableCanvas; the canvas zoom stays unchanged.
  const nodeBlocksZoom = await client.exec(`
    var tree_node = tree.root.get_node("${SANE_TREE}")
    var zc = tree.root.get_node("${SANE_ZOOM_CANVAS}")
    if tree_node == null or zc == null:
      return {"found": false}
    var visuals = tree_node._node_visuals.values()
    if visuals.size() == 0:
      return {"found": true, "has_node": false}
    var node = visuals[0]
    var before = zc.get_zoom()
    var ev = InputEventMouseButton.new()
    ev.button_index = MOUSE_BUTTON_WHEEL_UP
    ev.pressed = true
    node._gui_input(ev)
    return {
      "found": true,
      "has_node": true,
      "node_filter": node.mouse_filter,
      "before": before,
      "after": zc.get_zoom(),
      "blocked": is_equal_approx(zc.get_zoom(), before)
    }
  `);
  harness.record("SaneNode uses MOUSE_FILTER_STOP", nodeBlocksZoom?.found === true && nodeBlocksZoom?.node_filter === 0, JSON.stringify(nodeBlocksZoom));
  harness.record("wheel over SaneNode blocks canvas zoom", nodeBlocksZoom?.found === true && nodeBlocksZoom?.blocked === true, JSON.stringify(nodeBlocksZoom));

  // 3. Sanity: left-click on a node still emits activate_requested.
  const nodeClickSignal = await client.exec(`
    var tree_node = tree.root.get_node("${SANE_TREE}")
    if tree_node == null:
      return {"found": false}
    var visuals = tree_node._node_visuals.values()
    if visuals.size() == 0:
      return {"found": true, "has_node": false}
    var node = visuals[0]
    var received = []
    var cb = func(id): received.append(id)
    if node.has_signal("activate_requested"):
      node.activate_requested.connect(cb)
    var ev = InputEventMouseButton.new()
    ev.button_index = MOUSE_BUTTON_LEFT
    ev.pressed = true
    node._gui_input(ev)
    return {"found": true, "has_node": true, "signal_count": received.size()}
  `);
  harness.record("node click emits activate_requested", nodeClickSignal?.found === true && (nodeClickSignal?.signal_count ?? 0) === 1, JSON.stringify(nodeClickSignal));

  harness.finishSuite();
}

async function see868Bug3LayoutPullThrough() {
  harness.start("17_see868_bug_3_layout_pull_through");

  // Bug 3 target: InfiVisual must not show simultaneously with SANE.
  // PZM CROSS_ZONE_CONFLICTS hides Infi when SANE shows (bidirectional).
  const conflictState = await client.exec(`
    var sane = tree.root.get_node("${SANE_TREE}")
    var infi = tree.root.get_node("${INFI_VISUAL}")
    if sane == null or infi == null:
      return {"found": false}
    var infi_default_hidden = not infi.visible
    EventBus.panel_requested.emit(PanelZoneManager.UIPanel.INFI_VISUAL, EventBus.PanelAction.SHOW)
    var infi_visible_when_infi = infi.visible
    var sane_visible_when_infi = sane.visible
    EventBus.panel_requested.emit(PanelZoneManager.UIPanel.SANE_TREE, EventBus.PanelAction.SHOW)
    return {
      "found": true,
      "infi_default_hidden": infi_default_hidden,
      "infi_visible_when_infi": infi_visible_when_infi,
      "sane_visible_when_infi": sane_visible_when_infi,
      "sane_visible": sane.visible,
      "infi_visible": infi.visible
    }
  `);
  harness.record("InfiVisual hidden by default", conflictState?.found === true && conflictState?.infi_default_hidden === true, JSON.stringify(conflictState));
  harness.record("InfiVisual shows when requested", conflictState?.found === true && conflictState?.infi_visible_when_infi === true, JSON.stringify(conflictState));
  harness.record("SaneTree visible after show", conflictState?.found === true && conflictState?.sane_visible === true, JSON.stringify(conflictState));
  harness.record("InfiVisual hidden when SANE opens (cross-zone conflict)", conflictState?.found === true && conflictState?.infi_visible === false, JSON.stringify(conflictState));

  harness.finishSuite();
}

async function see868ExitPanel() {
  harness.start("17_see868_panel_exit");

  // Toggle SANE off and verify it closes.
  await client.exec(`
    var btn = tree.root.get_node("${BTN_SANE}")
    if btn != null:
      btn.pressed.emit()
    return {"btn_found": btn != null}
  `);
  await client.gameStep(5);

  const closed = await client.exec(`
    var n = tree.root.get_node("${SANE_TREE}")
    if n == null:
      return {"found": false}
    return {"found": true, "visible": n.visible}
  `).catch(() => ({}));
  harness.record("SaneTree hidden after second SANE button click", closed?.found === true && closed?.visible === false, JSON.stringify(closed));

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
  await see868Bug1LinkSkeleton();
  await see868Bug2WheelZoomBlocked();
  await see868Bug3LayoutPullThrough();
  await see868ExitPanel();

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
