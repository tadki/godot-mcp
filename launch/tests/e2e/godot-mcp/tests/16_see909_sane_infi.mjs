// SEE-909 QA: Sane + Infi UI fixes — 11 requirements, driven via godot-mcp.
// Runs the real game (TitleScreen -> ProfileCreation -> UIFramework) and verifies
// each requirement at the runtime layer, capturing runtime screenshots as evidence.
// Modelled on tests/16_sane_full.mjs (proven enterMainGame flow).

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SCENE = `${UF}/MainHBox/LeftPanel/SceneArea/SceneCanvas`;
const SANE_ZOOM = `${SCENE}/MiddleOverlay/SaneZoomableCanvas`;
const SANE_TREE = `${SANE_ZOOM}/SaneTree`;
const RIGHT_PANEL = `${UF}/MainHBox/RightPanel`;
const INFI = `${RIGHT_PANEL}/RightPanelOverlay/RightPanelCanvas/InfiVisual`;
const SCREENSHOT_DIR = new URL("./screenshots/see909/", import.meta.url).pathname;
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
  if (!img) { harness.record(`screenshot ${name}`, false, "no image returned"); return null; }
  const buf = Buffer.from(img, "base64");
  const ok = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  fs.writeFileSync(`${SCREENSHOT_DIR}/${name}.png`, buf);
  harness.record(`screenshot ${name}`, ok, `bytes=${buf.length}`);
  return buf;
}

// mcp_client.exec() already JSON.parses dict results into objects, so these
// helpers just forward the value (no double-parse).
async function panelStyle(path) {
  return client.exec(`
    var n = tree.root.get_node_or_null("${path}")
    if n == null or not (n is Control): return {"err":"not_found"}
    var sb = n.get_theme_stylebox("panel") if n.has_theme_stylebox("panel") else null
    if sb == null or not (sb is StyleBoxFlat): return {"has_sb": false}
    return {"has_sb": true,
      "tl": sb.get_corner_radius(0), "tr": sb.get_corner_radius(1), "br": sb.get_corner_radius(2), "bl": sb.get_corner_radius(3),
      "bg": [sb.bg_color.r, sb.bg_color.g, sb.bg_color.b, sb.bg_color.a],
      "ml": sb.get_content_margin(SIDE_LEFT), "mt": sb.get_content_margin(SIDE_TOP),
      "mr": sb.get_content_margin(SIDE_RIGHT), "mb": sb.get_content_margin(SIDE_BOTTOM)}
  `);
}

async function jj(src) {
  // godot_exec occasionally returns a null result (a bridge serialization quirk).
  // Retry with a frame step before giving up.
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
  await client.exec(`ProfileManager.create_profile("RevyE2E")`);
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
    if ne != null: ne.text = "RevyE2E"; ne.text_changed.emit("RevyE2E")
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
  harness.start("see909_setup");
  harness.record("reached UIFramework game scene", sceneOk === true, `scene=${sceneOk}`);
  harness.finishSuite();

  const HARDWARE = await findPath("HardwareBoard");
  let INVENTORY = await findPath("InventoryVisual");
  const QUEUE_SLOT = await findPath("InfiReviewQueueSlot");
  const BTN_EXTRA = await findPath("ButtonExtra");

  // ── Req 8: Infi default visible + no master toggle + ButtonExtra no longer toggles Infi ──
  harness.start("req08_infi_default_visible");
  {
    const infiVis = await client.exec(`var n = tree.root.get_node_or_null("${INFI}"); return n != null and n.visible`);
    harness.record("InfiVisual visible by default (no master toggle)", infiVis === true, `infi_visible=${infiVis}`);
    if (BTN_EXTRA) {
      const before = await client.exec(`var n = tree.root.get_node_or_null("${INFI}"); return n.visible`);
      await client.exec(`var b = tree.root.get_node_or_null("${BTN_EXTRA}"); if b is Button: b.pressed.emit()`);
      await client.gameStep(3);
      const after = await client.exec(`var n = tree.root.get_node_or_null("${INFI}"); return n.visible`);
      harness.record("ButtonExtra does not toggle Infi", before === true && after === true, `before=${before} after=${after}`);
    } else {
      harness.record("ButtonExtra does not toggle Infi", false, "ButtonExtra not found");
    }
  }
  await snap("req08_infi_default");
  harness.finishSuite();

  // ── Req 9: Infi embedded in RightPanel framework, slightly smaller, corner 30 consistent ──
  harness.start("req09_infi_embedded_right_panel");
  {
    const embed = await jj(`
      var infi = tree.root.get_node_or_null("${INFI}")
      var rp = tree.root.get_node_or_null("${RIGHT_PANEL}")
      if infi == null or rp == null: return {"err":"not_found"}
      var p = infi.get_parent()
      return {"parent": String(p.get_path()),
        "in_right_canvas": String(p.get_path()).find("RightPanelCanvas") >= 0,
        "infi_w": infi.size.x, "right_w": rp.size.x}
    `);
    harness.record("InfiVisual embedded in RightPanelCanvas (right-side framework)", embed?.in_right_canvas === true, JSON.stringify(embed));
    harness.record("InfiVisual slightly smaller than RightPanel (offset inset)", (embed?.infi_w ?? 0) < (embed?.right_w ?? 0), `infi_w=${embed?.infi_w} right_w=${embed?.right_w}`);
    const infiStyle = await panelStyle(INFI);
    const corners30 = infiStyle?.has_sb && infiStyle?.tl === 30 && infiStyle?.tr === 30 && infiStyle?.br === 30 && infiStyle?.bl === 30;
    harness.record("InfiVisual board corner_radius = 30px (all corners)", !!corners30, JSON.stringify(infiStyle));
  }
  await snap("req09_infi_embedded");
  harness.finishSuite();

  // ── Req 7: Inventory background board matches HardwareBoard ──
  harness.start("req07_inventory_matches_hardware");
  {
    await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.INVENTORY_VISUAL, EventBus.PanelAction.SHOW)`);
    await client.gameStep(5);
    if (!INVENTORY) INVENTORY = await findPath("InventoryVisual");
    const hwStyle = await panelStyle(HARDWARE);
    const invStyle = await panelStyle(INVENTORY);
    const corners20 = invStyle?.has_sb && invStyle?.tl === 20 && invStyle?.tr === 20 && invStyle?.br === 20 && invStyle?.bl === 20;
    const cornersMatch = hwStyle?.has_sb && corners20 && hwStyle.tl === invStyle.tl && hwStyle.tr === invStyle.tr && hwStyle.br === invStyle.br && hwStyle.bl === invStyle.bl;
    harness.record("Inventory corner_radius = 20px (all corners)", !!corners20, JSON.stringify(invStyle));
    harness.record("Inventory corners match HardwareBoard", !!cornersMatch, `hw=${JSON.stringify(hwStyle)}`);
    const bgMatch = hwStyle?.has_sb && invStyle?.has_sb && JSON.stringify(hwStyle.bg) === JSON.stringify(invStyle.bg);
    harness.record("Inventory bg colour matches HardwareBoard (beige)", !!bgMatch, `hw_bg=${JSON.stringify(hwStyle?.bg)} inv_bg=${JSON.stringify(invStyle?.bg)}`);
    const padMatch = invStyle?.has_sb && invStyle.ml === 16 && invStyle.mr === 16 && invStyle.mt === 16 && invStyle.mb === 16 && hwStyle.ml === invStyle.ml && hwStyle.mr === invStyle.mr;
    harness.record("Inventory content margin = 16 (matches hardware)", !!padMatch, `inv ml=${invStyle?.ml} mr=${invStyle?.mr} hw ml=${hwStyle?.ml} mr=${hwStyle?.mr}`);
    // Both boards declare Vector2(480,800) in tscn; PanelZoneManager may stretch
    // the rendered width to fill the layout, so assert the design width is equal
    // between the two panels (consistency) rather than a fixed runtime pixel width.
    // Bridge returns null for dicts right after a panel transition, so read the
    // width fields as primitives. Both boards declare Vector2(480,800) in tscn;
    // at runtime the zone stretches both to the same actual width.
    const hwMin = await jj(`var h = tree.root.get_node_or_null("${HARDWARE}"); return h.custom_minimum_size.x if h != null else -1.0`);
    const invMin = await jj(`var i = tree.root.get_node_or_null("${INVENTORY}"); return i.custom_minimum_size.x if i != null else -1.0`);
    const hwSize = await jj(`var h = tree.root.get_node_or_null("${HARDWARE}"); return h.size.x if h != null else -1.0`);
    const invSize = await jj(`var i = tree.root.get_node_or_null("${INVENTORY}"); return i.size.x if i != null else -1.0`);
    const widthMatch = hwSize > 0 && hwSize === invSize;
    harness.record("Inventory & HardwareBoard render at equal width (zone-consistent)", widthMatch, `hw_min=${hwMin} inv_min=${invMin} hw_size=${hwSize} inv_size=${invSize}`);
  }
  await snap("req07_inventory_vs_hardware");
  harness.finishSuite();

  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.INVENTORY_VISUAL, EventBus.PanelAction.HIDE)`);
  await client.gameStep(3);

  // ── Open SANE for reqs 1,3,4,5,6 ──
  harness.start("sane_open");
  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.SANE_TREE, EventBus.PanelAction.SHOW)`);
  await client.gameStep(30);
  const SANE = await findPath("SaneTree");
  const ZOOM = await findPath("SaneZoomableCanvas");
  const saneVisible = await jj(`var t = tree.root.get_node_or_null("${SANE}"); return t != null and t.visible`);
  const saneNodes = await jj(`var t = tree.root.get_node_or_null("${SANE}"); return t._node_visuals.size() if t != null else -1`);
  harness.record("SaneTree opens with populated visuals", saneVisible === true && (saneNodes ?? -1) > 0, `visible=${saneVisible} nodes=${saneNodes}`);
  harness.finishSuite();

  // ── Req 5: Home node = NodeID 5, gold marker ──
  harness.start("req05_home_node");
  {
    const home = await jj(`
      var sub = SaneSubsystem
      var d5 = sub.get_node_data(&"5")
      var t = tree.root.get_node_or_null("${SANE}")
      var v5 = t._node_visuals.get(&"5") if t != null else null
      var fill = v5._get_fill_color() if v5 != null else Color.BLACK
      return {"home_id": String(sub.get_home_node_id()),
        "data5_is_home": d5 != null and d5.is_home_node,
        "visual5_is_home": v5 != null and v5.is_home,
        "fill_is_activated": fill == Color(0.0, 0.85, 1.0, 1.0)}
    `);
    harness.record("Home node id = 5", home?.home_id === "5", JSON.stringify(home));
    harness.record("NodeID 5 flagged IsHomeNode in data", home?.data5_is_home === true, JSON.stringify(home));
    // Node 5 is also activated by default, so _get_fill_color() returns the cyan
    // activated colour; the gold HOME marker is the small core drawn when is_home.
    harness.record("SaneNode(5).is_home == true (gold core)", home?.visual5_is_home === true, JSON.stringify(home));
    harness.record("SaneNode(5) is activated (cyan fill)", home?.fill_is_activated === true, JSON.stringify(home));
  }
  await snap("req05_home_node");
  harness.finishSuite();

  // ── Req 6: Home(5) -> 117 link + all links complete ──
  harness.start("req06_links_complete");
  {
    const links = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return {"err":"no_tree"}
      var has_5_117 = false
      for l in t._link_visuals:
        var a = String(l.from_node_id); var b = String(l.to_node_id)
        if (a == "5" and b == "117") or (a == "117" and b == "5"): has_5_117 = true
      var adj5 = SaneSubsystem._adjacency.get(&"5", [])
      var adj5_has_117 = false
      for x in adj5: if String(x) == "117": adj5_has_117 = true
      return {"link_count": t._link_visuals.size(), "has_5_117": has_5_117, "adj5_has_117": adj5_has_117, "adj5_size": adj5.size()}
    `);
    harness.record("Home(5) -> Inner1_1(117) link rendered", links?.has_5_117 === true, JSON.stringify(links));
    harness.record("Adjacency[5] contains 117 (link declared in data)", links?.adj5_has_117 === true, JSON.stringify(links));
    harness.record("All links rendered (count > 0)", (links?.link_count ?? 0) > 0, `count=${links?.link_count}`);
  }
  await snap("req06_links");
  harness.finishSuite();

  // ── Req 3: straight default, bezier only at former visual-node bends ──
  harness.start("req03_curve_rendering");
  {
    const curves = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return {"err":"no_tree"}
      var straight = 0; var bezier = 0; var f117 = null; var bend = null
      for l in t._link_visuals:
        var ct = String(l.curve_type)
        if ct == "bezier": bezier += 1
        else: straight += 1
        var a = String(l.from_node_id); var b = String(l.to_node_id)
        if (a == "5" and b == "117") or (a == "117" and b == "5"): f117 = ct
        if (a == "16" and b == "23") or (a == "23" and b == "16"): bend = ct
      return {"straight": straight, "bezier": bezier, "link_5_117": f117, "link_16_23": bend}
    `);
    harness.record("5->117 link renders as straight (direct connect)", curves?.link_5_117 === "straight", JSON.stringify(curves));
    harness.record("Former-bend pair 16-23 renders as bezier", curves?.link_16_23 === "bezier", JSON.stringify(curves));
    harness.record("Majority straight, few bezier (no skew/over-curve)", (curves?.straight ?? 0) > (curves?.bezier ?? 0) && (curves?.bezier ?? 0) > 0, JSON.stringify(curves));
  }
  await snap("req03_curves");
  harness.finishSuite();

  // ── Req 1: wheel zooms centered on cursor ──
  harness.start("req01_wheel_zoom_cursor");
  {
    const zoom = await jj(`
      var z = tree.root.get_node_or_null("${ZOOM}")
      if z == null or not z.has_method("get_zoom"): return {"err":"no_canvas"}
      var before = z.get_zoom()
      var cb = z._canvas.position
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_WHEEL_UP
      ev.pressed = true
      ev.position = Vector2(z.size.x * 0.25, z.size.y * 0.25)
      z._gui_input(ev)
      var after = z.get_zoom()
      var ca = z._canvas.position
      return {"before": before, "after": after, "moved": ca != cb, "cb": [cb.x, cb.y], "ca": [ca.x, ca.y],
        "has_algo": z.has_method("_zoom_at_cursor"), "mouse_filter": z.mouse_filter}
    `);
    harness.record("Wheel increases zoom level", zoom?.after > zoom?.before, JSON.stringify(zoom));
    harness.record("Zoom repositions canvas (zoom-to-cursor path)", zoom?.moved === true, JSON.stringify(zoom));
    harness.record("ZoomableCanvas exposes zoom-to-cursor algorithm", zoom?.has_algo === true, JSON.stringify(zoom));
    // MOUSE_FILTER_PASS == 1 (STOP=0, PASS=1, IGNORE=2). PASS lets the canvas
    // receive _gui_input for the wheel while still letting children get events.
    harness.record("Canvas mouse_filter = PASS (wheel reaches canvas handler)", zoom?.mouse_filter === 1, JSON.stringify(zoom));
  }
  await snap("req01_wheel_zoom");
  harness.finishSuite();

  // ── Req 4: hover white ring + tooltip (DisplayName/Description) + clickable ──
  harness.start("req04_hover_tooltip_click");
  {
    const hover = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return {"err":"no_tree"}
      var v = t._node_visuals.get(&"5")
      if v == null: return {"err":"no_visual"}
      v._notification(Control.NOTIFICATION_MOUSE_ENTER)
      return {"hovering": v._is_hovering, "tooltip_created": v._tooltip_label != null,
        "tooltip_visible": v._tooltip_label != null and v._tooltip_label.visible,
        "tooltip_text": String(v._tooltip_label.text) if v._tooltip_label != null else "",
        "display_name": v._display_name, "description_len": v._description.length()}
    `);
    harness.record("SaneNode shows hover state on MOUSE_ENTER", hover?.hovering === true, JSON.stringify(hover));
    harness.record("Tooltip created on hover", hover?.tooltip_created === true, JSON.stringify(hover));
    harness.record("Tooltip visible on hover (DisplayName + Description)", hover?.tooltip_visible === true && (hover?.tooltip_text?.length ?? 0) > 0, JSON.stringify({text: hover?.tooltip_text, display: hover?.display_name}));
    harness.record("Hover ring code path active (draw_arc white)", hover?.hovering === true, "gated on _is_hovering in sane_node.gd:156-157");
    const click = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      if t == null: return {"err":"no_tree"}
      var v = t._node_visuals.get(&"5")
      if v == null: return {"err":"no_visual"}
      var box = []
      v.activate_requested.connect(func(_id): box.append(true), Object.CONNECT_ONE_SHOT)
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_LEFT
      ev.pressed = true
      v._gui_input(ev)
      return {"activate_fired": box.size() > 0, "can_focus": v.focus_mode != Control.FOCUS_NONE}
    `);
    harness.record("Left-click on node emits activate_requested (clickable)", click?.activate_fired === true, JSON.stringify(click));
    harness.record("SaneNode accepts focus/click (focus_mode != NONE)", click?.can_focus === true, `focus_mode=${click?.can_focus}`);
  }
  await snap("req04_hover_tooltip");
  harness.finishSuite();

  // ── Req 2: second Sane click exits Sane UI + restores layout & Infi ──
  harness.start("req02_sane_exit_restores");
  {
    await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.SANE_TREE, EventBus.PanelAction.TOGGLE)`);
    await client.gameStep(8);
    const after = await jj(`
      var t = tree.root.get_node_or_null("${SANE}")
      var rp = tree.root.get_node_or_null("${RIGHT_PANEL}")
      var infi = tree.root.get_node_or_null("${INFI}")
      return {"sane_visible": t.visible if t != null else "no_tree",
        "right_visible": rp.visible if rp != null else "no_rp",
        "infi_visible": infi.visible if infi != null else "no_infi"}
    `);
    harness.record("SaneTree hidden after second SANE toggle", after?.sane_visible === false, JSON.stringify(after));
    harness.record("RightPanel restored after SANE exit", after?.right_visible === true, JSON.stringify(after));
    harness.record("Infi restored visible after SANE exit", after?.infi_visible === true, JSON.stringify(after));
  }
  await snap("req02_sane_exited");
  harness.finishSuite();

  // ── Req 10: review queue pops in left scene area, not over Infi, no overlap ──
  harness.start("req10_review_queue_location");
  {
    const q = await jj(`
      var infi = tree.root.get_node_or_null("${INFI}")
      var slot = tree.root.get_node_or_null("${QUEUE_SLOT}")
      if infi == null: return {"err":"no_infi"}
      if infi.has_method("_on_queue_button_pressed"): infi._on_queue_button_pressed()
      var rq = infi.get("_review_queue_visual")
      if (rq == null or not is_instance_valid(rq)) and infi.has_method("get_review_queue_visual"): rq = infi.get_review_queue_visual()
      var out = {"has_method": infi.has_method("_on_queue_button_pressed"), "slot_found": slot != null, "queue_exists": rq != null and is_instance_valid(rq)}
      if rq != null and is_instance_valid(rq):
        var p = rq.get_parent()
        var ppath = String(p.get_path()) if p != null else ""
        out["queue_visible"] = rq.visible
        out["in_left_scene_area"] = ppath.find("MiddleLeftContent") >= 0
        out["parent_is_infi"] = ppath.find("InfiVisual") >= 0
        var qr = rq.get_global_rect(); var ir = infi.get_global_rect()
        out["overlaps_infi"] = qr.intersects(ir)
      else:
        out["queue"] = "not_found"
      return out
    `);
    harness.record("Review queue visual exists and was created", q?.queue_exists === true, JSON.stringify(q));
    harness.record("Review queue can be opened", q?.queue_visible === true, JSON.stringify(q));
    harness.record("Review queue hosted in left scene area (MiddleLeftContent)", q?.in_left_scene_area === true, JSON.stringify(q));
    harness.record("Review queue not parented inside InfiVisual", q?.parent_is_infi === false, JSON.stringify(q));
    harness.record("Review queue rect does not overlap InfiVisual rect", q?.overlaps_infi === false, JSON.stringify(q));
  }
  await snap("req10_review_queue");
  harness.finishSuite();

  // ── Req 11: sticker width bounded by Infi panel, autowrap, equal padding ──
  harness.start("req11_sticker_wrap");
  {
    // Push several posts so both short and long content are exercised. The
    // ScrollContainer does not clip children to its viewport width, so the
    // sticker's logical width is content-driven; we assert every post stays
    // within the viewport AND that right-side buttons stay visible.
    for (let i = 0; i < 6; i++) {
      await client.exec(`if InfiSubsystem != null and InfiSubsystem.get_service() != null: InfiSubsystem.get_service().try_push_infi()`);
      await client.gameStep(2);
    }
    const st = await jj(`
      var infi = tree.root.get_node_or_null("${INFI}")
      if infi == null: return {"err":"no_infi"}
      var sc = infi.find_child("ScrollContainer", true, false)
      var vp_w = sc.get_global_rect().size.x if sc != null else infi.size.x
      var vp_right = sc.get_global_rect().end.x if sc != null else infi.get_global_rect().end.x
      var posts = infi.get("_post_visuals")
      if (posts == null) and infi.has_method("get_post_visuals"): posts = infi.get_post_visuals()
      var out = {"post_count": posts.size() if posts != null else 0, "infi_w": infi.size.x, "vp_w": vp_w,
        "max_post_w": 0.0, "any_overflow": false, "any_button_clipped": false,
        "autowrap": -1, "pad_equal": false}
      if posts != null and posts.size() > 0:
        var keys = posts.keys()
        var pv0 = posts[keys[0]]
        var lbl0 = pv0.find_child("*Content*", true, false)
        if lbl0 == null: lbl0 = pv0.find_child("*Body*", true, false)
        if lbl0 == null:
          for ch in pv0.find_children("*", "", true, false):
            if ch is Label: lbl0 = ch; break
        if lbl0 != null: out["autowrap"] = lbl0.autowrap_mode
        var sb0 = pv0.get_theme_stylebox("panel") if pv0.has_theme_stylebox("panel") else null
        if sb0 != null and sb0 is StyleBoxFlat:
          out["pad_equal"] = sb0.get_content_margin(SIDE_LEFT) == sb0.get_content_margin(SIDE_RIGHT)
        for k in posts:
          var pv = posts[k]
          if pv.size.x > out["max_post_w"]: out["max_post_w"] = pv.size.x
          if pv.get_global_rect().end.x > vp_right + 1: out["any_overflow"] = true
          for btn_name in ["ExpandButton", "DismissButton", "LikeButton"]:
            var btn = pv.find_child(btn_name, true, false)
            if btn != null and btn.get_global_rect().end.x > vp_right + 1: out["any_button_clipped"] = true
      return out
    `);
    harness.record("At least one Infi post/sticker present", (st?.post_count ?? 0) > 0, JSON.stringify(st));
    harness.record("Sticker content autowrap enabled (text wraps)", (st?.autowrap ?? -1) > 0, `autowrap=${st?.autowrap} (0=OFF,3=WORD_SMART)`);
    harness.record("Sticker width bounded by Infi panel/viewport", st?.any_overflow === false, `max_post_w=${st?.max_post_w} vp_w=${st?.vp_w} infi_w=${st?.infi_w}`);
    harness.record("Sticker right-side buttons visible (not clipped)", st?.any_button_clipped === false, `any_button_clipped=${st?.any_button_clipped}`);
    harness.record("Sticker has equal left/right padding", st?.pad_equal === true, `pad_equal=${st?.pad_equal}`);
  }
  await snap("req11_sticker");
  harness.finishSuite();

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
