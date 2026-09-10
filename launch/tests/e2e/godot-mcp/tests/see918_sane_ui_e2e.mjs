// SEE-918 E2E QA: verify the 6 Sane UI/Node fixes via godot-mcp.
// Tests: launch to main scene, link-under-node, square nodes, wheel zoom,
// hover tooltip, drag-pan vs click-activate.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SCENE = `${UF}/MainHBox/LeftPanel/SceneArea/SceneCanvas`;
const SANE_ZOOM = `${SCENE}/MiddleOverlay/SaneZoomableCanvas`;
const SANE_TREE = `${SANE_ZOOM}/SaneTree`;
const SCREENSHOT_DIR = new URL("./screenshots/see918/", import.meta.url).pathname;
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function findPath(name) {
  return client.exec(`
    var uf = tree.root.get_node_or_null("${UF}")
    if uf == null: return ""
    var n = uf.find_child("${name}", true, false)
    return String(n.get_path()) if n != null else ""
  `);
}

async function snap(name) {
  const shot = await client.editorRead("screenshot_game", { max_width: 900 }).catch(() => null);
  const img = shot?.content?.find((c) => c.type === "image")?.data;
  if (!img) {
    harness.record(`screenshot ${name}`, false, "no image returned");
    return null;
  }
  const buf = Buffer.from(img, "base64");
  const ok = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  fs.writeFileSync(`${SCREENSHOT_DIR}/${name}.png`, buf);
  harness.record(`screenshot ${name}`, ok, `bytes=${buf.length}`);
  return buf;
}

async function jj(src) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await client.exec(src);
    if (r !== null && r !== undefined) return r;
    try { await client.gameStep(1); } catch (_) {}
  }
  console.error("[jj] null after retries:", src.slice(0, 120).replace(/\s+/g, " "));
  return null;
}

async function enterMainGame() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE918")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
  await client.exec(`
    var s = tree.current_scene
    var b = s.find_child("*NewGame*", true, false)
    if b is Button: b.pressed.emit()
  `);
  await client.gameStep(2);
  await client.gameThaw();
  await client.gameStep(20);
  await client.exec(`
    var s = tree.current_scene
    var ne = s.find_child("*NameEdit*", true, false)
    var b = s.find_child("*Start*", true, false)
    if ne != null: ne.text = "RevySEE918"; ne.text_changed.emit("RevySEE918")
    if b is Button: b.pressed.emit()
  `);
  await client.gameFreeze();
  await client.gameStep(40);
}

try {
  await client.connect();
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  await enterMainGame();

  const sceneOk = await client.exec(`return tree.current_scene != null and String(tree.current_scene.name) == "UIFramework"`);
  harness.start("see918_setup");
  harness.record("reached UIFramework game scene", sceneOk === true, `scene=${sceneOk}`);
  harness.finishSuite();

  const SANE = await findPath("SaneTree");
  const ZOOM = await findPath("SaneZoomableCanvas");

  // ── Open SANE panel ──
  harness.start("see918_open_sane");
  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.SANE_TREE, EventBus.PanelAction.SHOW)`);
  await client.gameStep(30);
  const saneVisible = await jj(`var t = tree.root.get_node_or_null("${SANE}"); return t != null and t.visible`);
  const saneNodes = await jj(`var t = tree.root.get_node_or_null("${SANE}"); return t._node_visuals.size() if t != null else -1`);
  const saneLinks = await jj(`var t = tree.root.get_node_or_null("${SANE}"); return t._link_visuals.size() if t != null else -1`);
  harness.record("SaneTree opens visible", saneVisible === true, `visible=${saneVisible}`);
  harness.record("SaneTree populated with nodes", (saneNodes ?? -1) > 0, `nodes=${saneNodes}`);
  harness.record("SaneTree populated with links", (saneLinks ?? -1) > 0, `links=${saneLinks}`);
  await snap("01_sane_open");
  harness.finishSuite();

  // ── Req 1: project launches to main scene without crash (covered by setup) ──
  harness.start("req01_project_launches");
  harness.record("project launched and reached UIFramework", sceneOk === true, "no runtime crash during launch");
  harness.finishSuite();

  // ── Req 2: links render visually under nodes ──
  harness.start("req02_links_under_nodes");
  {
    const order = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return JSON.stringify({"err":"no_tree"})
      var c = t._canvas
      if c == null: return JSON.stringify({"err":"no_canvas"})
      var first_link_idx = -1
      var first_node_idx = -1
      for i in range(c.get_child_count()):
        var ch = c.get_child(i)
        var path := String(ch.get_script().resource_path) if ch.get_script() != null else ""
        if first_link_idx < 0 and path.find("sane_link.gd") >= 0: first_link_idx = i
        if first_node_idx < 0 and path.find("sane_node.gd") >= 0: first_node_idx = i
      return JSON.stringify({"first_link_idx": first_link_idx, "first_node_idx": first_node_idx, "child_count": c.get_child_count()})
    `);
    harness.record("links added before nodes in canvas child order", (order?.first_link_idx ?? 9999) < (order?.first_node_idx ?? 9999),
      JSON.stringify(order));
  }
  await snap("02_links_under_nodes");
  harness.finishSuite();

  // ── Req 3: nodes display as squares ──
  harness.start("req03_square_nodes");
  {
    const shapes = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return JSON.stringify({"err":"no_tree"})
      var sizes = []
      var square_count = 0
      var total = 0
      for id in t._node_visuals:
        var v = t._node_visuals[id]
        total += 1
        var sz = v.size
        if sz.x > 0 and abs(sz.x - sz.y) / sz.x < 0.05:
          square_count += 1
        sizes.append([sz.x, sz.y])
      return JSON.stringify({"total": total, "square_count": square_count, "all_square": square_count == total, "sample": sizes.slice(0, 3)})
    `);
    harness.record("all sampled SaneNodes are square", shapes?.all_square === true,
      `total=${shapes?.total} square=${shapes?.square_count}`);
  }
  await snap("03_square_nodes");
  harness.finishSuite();

  // ── Req 4: wheel zooms canvas even when mouse is over Sane UI / node ──
  harness.start("req04_wheel_zoom_over_ui");
  {
    const zoom = await jj(`
      var z = tree.root.get_node_or_null("${ZOOM}")
      if z == null or not z.has_method("get_zoom"): return JSON.stringify({"err":"no_canvas"})
      var before = z.get_zoom()
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_WHEEL_UP
      ev.pressed = true
      ev.position = Vector2(z.size.x * 0.5, z.size.y * 0.5)
      z._gui_input(ev)
      return JSON.stringify({"before": before, "after": z.get_zoom()})
    `);
    harness.record("wheel zoom increases zoom level", zoom?.after > zoom?.before, JSON.stringify(zoom));

    // Wheel-over-node: drive REAL GUI dispatch via the Viewport (SEE-931 T5).
    // The old `t._gui_input(ev)` direct call is dead — SaneTree._gui_input was
    // removed in T2 (it was a forwarder that real dispatch bypassed anyway).
    // push_input lets the Viewport resolve the topmost control under the event
    // and walk the mouse_filter chain, which is the path that actually broke.
    const zoomOverNode = await jj(`
      var uf = tree.root.get_node_or_null("${UF}")
      var t = tree.root.get_node_or_null("${SANE}")
      var z = tree.root.get_node_or_null("${ZOOM}")
      if t == null or z == null: return JSON.stringify({"err":"missing"})
      var v = t._node_visuals.get(&"5")
      if v == null: return JSON.stringify({"err":"no_node5"})
      var before = z.get_zoom()
      var center = v.get_global_position() + v.size * 0.5
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_WHEEL_DOWN
      ev.pressed = true
      ev.position = center
      ev.global_position = center
      uf.get_viewport().push_input(ev, true)
      return JSON.stringify({"before": before, "after": z.get_zoom(), "over_node": true})
    `);
    harness.record("wheel zoom works when mouse is over a node", zoomOverNode?.after < zoomOverNode?.before, JSON.stringify(zoomOverNode));
  }
  await snap("04_wheel_zoom");
  harness.finishSuite();

  // ── Req 5: hover node shows tooltip with required fields ──
  harness.start("req05_hover_tooltip");
  {
    const tooltip = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return JSON.stringify({"err":"no_tree"})
      var v = t._node_visuals.get(&"5")
      if v == null: return JSON.stringify({"err":"no_visual"})
      t._on_node_hover_changed(&"5", true)
      var lbl = t._tooltip_label
      return JSON.stringify({
        "tooltip_label_exists": lbl != null,
        "tooltip_visible": (t._tooltip_container.visible if t._tooltip_container != null else false),
        "tooltip_text": (String(lbl.text) if lbl != null else ""),
        "has_node_id": lbl != null and lbl.text.find("Node ID:") >= 0,
        "has_linked": lbl != null and lbl.text.find("Linked:") >= 0,
        "has_link_ids": lbl != null and lbl.text.find("Link IDs:") >= 0,
        "has_prereqs": lbl != null and lbl.text.find("Prerequisites:") >= 0,
        "has_activated": lbl != null and lbl.text.find("Activated:") >= 0
      })
    `);
    harness.record("tooltip created on hover", tooltip?.tooltip_label_exists === true, JSON.stringify(tooltip));
    harness.record("tooltip visible on hover", tooltip?.tooltip_visible === true, JSON.stringify(tooltip));
    harness.record("tooltip contains Node ID", tooltip?.has_node_id === true, `text=${tooltip?.tooltip_text?.slice(0, 80)}`);
    harness.record("tooltip contains Linked nodeIDs", tooltip?.has_linked === true, `text=${tooltip?.tooltip_text?.slice(0, 80)}`);
    harness.record("tooltip contains Link IDs", tooltip?.has_link_ids === true, `text=${tooltip?.tooltip_text?.slice(0, 80)}`);
    harness.record("tooltip contains Prerequisites", tooltip?.has_prereqs === true, `text=${tooltip?.tooltip_text?.slice(0, 80)}`);
    harness.record("tooltip contains Activated", tooltip?.has_activated === true, `text=${tooltip?.tooltip_text?.slice(0, 80)}`);
  }
  await snap("05_hover_tooltip");
  harness.finishSuite();

  // ── Req 6: left-drag on empty canvas pans; left-click on node activates ──
  harness.start("req06_drag_pan_vs_click_activate");
  {
    const leftPan = await jj(`
      var z = tree.root.get_node_or_null("${ZOOM}")
      if z == null: return JSON.stringify({"err":"no_canvas"})
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_LEFT
      ev.pressed = true
      ev.position = Vector2(100, 100)
      z._gui_input(ev)
      return JSON.stringify({"is_panning": z._is_panning, "pan_button": z._pan_button})
    `);
    harness.record("left-button press starts pan on empty canvas", leftPan?.is_panning === true && leftPan?.pan_button === 1, JSON.stringify(leftPan));

    const rightPan = await jj(`
      var z = tree.root.get_node_or_null("${ZOOM}")
      if z == null: return JSON.stringify({"err":"no_canvas"})
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_RIGHT
      ev.pressed = true
      ev.position = Vector2(200, 200)
      z._gui_input(ev)
      return JSON.stringify({"is_panning": z._is_panning, "pan_button": z._pan_button})
    `);
    harness.record("right-button press still starts pan", rightPan?.is_panning === true && rightPan?.pan_button === 2, JSON.stringify(rightPan));

    const click = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return JSON.stringify({"err":"no_tree"})
      var v = t._node_visuals.get(&"117")
      if v == null: return JSON.stringify({"err":"no_visual_117"})
      var box = []
      v.activate_requested.connect(func(_id): box.append(true), Object.CONNECT_ONE_SHOT)
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_LEFT
      ev.pressed = true
      ev.position = v.get_global_position() + v.size * 0.5
      v._gui_input(ev)
      return JSON.stringify({"activate_fired": box.size() > 0})
    `);
    harness.record("left-click on node emits activate_requested", click?.activate_fired === true, JSON.stringify(click));
  }
  await snap("06_drag_pan_click");
  harness.finishSuite();

  await client.gameThaw();
  await client.editor("stop");
  await client.close();
  harness.printSummary();
  process.exit(harness.exitCode());
} catch (e) {
  console.error("FATAL:", e);
  try {
    const logs = await client.editorReadText("get_log_messages", { severity: "error", limit: 30 });
    console.error("RECENT ERRORS:", JSON.stringify(logs));
  } catch {}
  await teardown(client);
  process.exit(2);
}
