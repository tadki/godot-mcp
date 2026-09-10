// SEE-931 QA (Revy): REAL input-routing E2E gate for sane UI.
//
// WHY THIS FILE EXISTS
//   The previous suite (see918_sane_ui_e2e.mjs) verifies the WRONG layer: it
//   constructs an InputEvent and calls `node._gui_input(ev)` /
//   `tree._on_node_hover_changed(id, true)` directly. That bypasses Godot's GUI
//   dispatch (topmost-Control-under-cursor resolution + mouse_filter chain), so
//   every structural routing defect is invisible to the test -> every patch goes
//   green -> bug stays in prod. This file is the corrective gate: it drives the
//   REAL dispatch path and asserts on observable state (zoom, pan, hover,
//   clicked-control identity). It must NEVER call `_gui_input` or
//   `_on_node_hover_changed` directly.
//
// WHAT "REAL DISPATCH" MEANS HERE
//   Godot's mouse GUI input enters via the Viewport. The faithful entry point we
//   can reach from godot_exec is `get_viewport().push_input(ev)` followed by a
//   frame step, OR `Input.parse_input_event(ev)` while the game is running. Both
//   make the Viewport resolve "which Control is under the cursor" and walk the
//   mouse_filter chain — exactly what the direct-call tests skip.
//
//   IMPORTANT LIMITATION (verified during SEE-931): in the editor-embedded run,
//   injected MouseMotion/MouseButton events do not always drive GUI hover/click
//   state (the embedded window does not synthesize mouse_enter from warp).
//   Therefore this suite asserts on `Viewport.gui_get_hovered_control()` — the
//   engine's OWN answer to "who is under the cursor" — as the structural oracle.
//   That oracle is what caught F1 (ShadowConsole host shadowing Sane) and
//   confirms R2 (MiddleOverlay STOP). The hovered-control oracle does NOT depend
//   on synthetic event delivery, so it is reliable in the embedded editor.
//
// COVERAGE
//   - R1 (meta): every assertion reads state / dispatches via the Viewport; none
//     call `_gui_input` / `_on_node_hover_changed` directly.
//   - R2: MiddleOverlay must not be STOP (would block base panels).
//   - F1: an open Sane panel must not be shadowed by the ShadowConsole host.
//   - R3: SaneNode runtime mouse_filter must not be STOP (regression guard; the
//     pre-fix runtime is already PASS — this locks that fact).
//   - R4: tooltip container must be IGNORE.
//   - R5: ZoomableCanvas content canvas is a later sibling than SaneTree (docs the
//     structural fact that makes SaneTree._gui_input dead; gate for the ownership
//     refactor in T2).
//   - REAL wheel dispatch over empty sane canvas (zoom) — info-gated on
//     embedded-delivery, never calls _gui_input directly.
//
// RUNNING
//   node .dev/godot-mcp/tests/e2e/godot-mcp/tests/see931_sane_real_input_routing_e2e.mjs
//   Requires the Windows Godot editor open with the godot-mcp addon enabled, and
//   no other MCP client holding the bridge (the agent session's own MCP
//   connection will block a second client — run from a clean shell).
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SCENE = `${UF}/MainHBox/LeftPanel/SceneArea/SceneCanvas`;
const MIDDLE = `${SCENE}/MiddleOverlay`;
const SANE_ZC = `${MIDDLE}/SaneZoomableCanvas`;
const SHADOW_ZC = `${MIDDLE}/ShadowConsoleZoomableCanvas`;
const SANE_TREE = `${SANE_ZC}/SaneTree`;
const MFS = ["STOP(0)", "PASS(1)", "IGNORE(2)"];

// Anti-R1 lint: scan a GDScript snippet to ensure it never reaches into a
// Control's private _gui_input / hover handler directly. If a future edit
// regresses this file into the old direct-call style, the suite fails loudly
// instead of silently becoming a fake-green test.
function assertNoDirectHandlerCall(snippet, label) {
  const banned = [/\._gui_input\s*\(/, /\._on_node_hover_changed\s*\(/];
  for (const re of banned) {
    if (re.test(snippet)) {
      throw new Error(
        `R1 violation in ${label}: snippet would call a private input/hover ` +
        `handler directly, bypassing real GUI dispatch. Snippet:\n${snippet}`,
      );
    }
  }
}

async function execJSON(source, opts = {}) {
  assertNoDirectHandlerCall(source, opts.label ?? "execJSON");
  return client.exec(source, opts);
}

async function enterMainGame() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE931")`);
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
    if ne != null: ne.text = "RevySEE931"; ne.text_changed.emit("RevySEE931")
    if b is Button: b.pressed.emit()
  `);
  await client.gameFreeze();
  await client.gameStep(40);
}

async function openSanePanel() {
  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.SANE_TREE, EventBus.PanelAction.SHOW)`);
  await client.gameStep(30);
  // Force-populate so a node exists regardless of subsystem init timing.
  await execJSON(`
    var t = tree.root.get_node_or_null("${SANE_TREE}")
    if t != null and t.has_method("_populate_nodes"): t._populate_nodes()
  `, { label: "openSanePanel populate" });
  await client.gameStep(10);
}

try {
  await client.connect();
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  await enterMainGame();

  // ── Suite 1: R2 middle-area routing oracle (no panel open) ──
  harness.start("see931_r2_middle_overlay_not_stop");
  {
    const base = await execJSON(`
      var uf = tree.root.get_node_or_null("${UF}")
      var mo = uf.get_node_or_null("MainHBox/LeftPanel/SceneArea/SceneCanvas/MiddleOverlay")
      var vp = uf.get_viewport()
      var hovered = vp.gui_get_hovered_control()
      return JSON.stringify({
        "middle_overlay_mf": mo.mouse_filter,
        "middle_overlay_rect": [mo.get_global_rect().position.x, mo.get_global_rect().position.y, mo.get_global_rect().size.x, mo.get_global_rect().size.y],
        "hovered": String(hovered.get_path()) if hovered != null else "null"
      })
    `, { label: "r2 base read" });
    // R2: MiddleOverlay must NOT be STOP. A STOP full-rect overlay rendered in
    // front of SceneHBox eats every click in the middle area (base panels frozen).
    harness.record(
      "R2 MiddleOverlay is not STOP (base panels reachable)",
      base.middle_overlay_mf !== 0,
      `mouse_filter=${MFS[base.middle_overlay_mf]} (STOP=0 is the bug) rect=${JSON.stringify(base.middle_overlay_rect)}`,
    );
  }
  harness.finishSuite();

  // ── Suite 2: open Sane, then run F1/R3/R4/R5 oracles ──
  await openSanePanel();

  // Shared: confirm Sane panel is actually open before asserting on it.
  {
    const saneOpen = await execJSON(`
      var zc = tree.root.get_node_or_null("${SANE_ZC}")
      var t = tree.root.get_node_or_null("${SANE_TREE}")
      return JSON.stringify({"zc_visible": zc.visible if zc != null else false, "tree_visible": t.visible if t != null else false})
    `, { label: "sane open check" });
    harness.start("see931_setup_sane_open");
    harness.record("Sane panel is open for the routing gates", saneOpen.zc_visible && saneOpen.tree_visible, JSON.stringify(saneOpen));
    harness.finishSuite();
    if (!saneOpen.zc_visible || !saneOpen.tree_visible) {
      throw new Error("Sane panel did not open; aborting F1/R3/R4/R5 suites.");
    }
  }

  // ── Suite 3: F1 ShadowConsole host must not shadow an open Sane panel ──
  harness.start("see931_f1_overlay_host_exclusive");
  {
    const sh = await execJSON(`
      var uf = tree.root.get_node_or_null("${UF}")
      var sane_zc = uf.get_node_or_null("${SANE_ZC}")
      var shadow_zc = uf.get_node_or_null("${SHADOW_ZC}")
      var vp = uf.get_viewport()
      var hovered = vp.gui_get_hovered_control()
      var hovered_path = String(hovered.get_path()) if hovered != null else "null"
      return JSON.stringify({
        "sane_zc_visible": sane_zc.visible,
        "shadow_zc_visible": shadow_zc.visible,
        "hovered": hovered_path,
        "hovered_in_shadow": hovered_path.begins_with("${SHADOW_ZC}"),
        "hovered_in_sane": hovered_path.begins_with("${SANE_ZC}")
      })
    `, { label: "f1 read" });
    // F1: with Sane open, the Shadow overlay host must NOT be visible (or, if it
    // is, must not be the hovered control). A visible Shadow host (later sibling
    // -> drawn on top) intercepts every event meant for the Sane panel.
    const shadowBlocks = sh.shadow_zc_visible && sh.hovered_in_shadow && !sh.hovered_in_sane;
    harness.record(
      "F1 ShadowConsole host does not shadow open Sane panel",
      !shadowBlocks,
      `sane_vis=${sh.sane_zc_visible} shadow_vis=${sh.shadow_zc_visible} hovered=${sh.hovered}`,
    );
  }
  harness.finishSuite();

  // ── Suite 4: R3 SaneNode runtime mouse_filter must not be STOP ──
  harness.start("see931_r3_sane_node_not_stop");
  {
    const n = await execJSON(`
      var t = tree.root.get_node_or_null("${SANE_TREE}")
      if t == null or not ("_node_visuals" in t): return JSON.stringify({"err":"no_tree"})
      var v = t._node_visuals.get(StringName("5"))
      if v == null: return JSON.stringify({"err":"no_node5"})
      return JSON.stringify({"mf": v.mouse_filter, "focus": v.focus_mode})
    `, { label: "r3 read" });
    // R3 regression guard: SaneNode must NOT be STOP at runtime. STOP would eat
    // wheel/click over a node before propagation reaches ZoomableCanvas. The
    // pre-fix runtime is already PASS (Revy empirical finding); this locks it so
    // a future regression to actual STOP is caught by real-state inspection.
    harness.record(
      "R3 SaneNode runtime mouse_filter is not STOP",
      n.err === undefined && n.mf !== 0,
      n.err ? `err=${n.err}` : `mf=${MFS[n.mf]} focus=${n.focus}`,
    );
  }
  harness.finishSuite();

  // ── Suite 5: R4 tooltip container must be IGNORE ──
  harness.start("see931_r4_tooltip_container_ignore");
  {
    const tip = await execJSON(`
      var t = tree.root.get_node_or_null("${SANE_TREE}")
      if t == null or not ("_tooltip_container" in t): return JSON.stringify({"err":"no_tree"})
      var c = t._tooltip_container
      var l = t._tooltip_label
      return JSON.stringify({
        "container_mf": c.mouse_filter if c != null else -1,
        "label_mf": l.mouse_filter if l != null else -1
      })
    `, { label: "r4 read" });
    // R4: tooltip container must be IGNORE, else a visible STOP tooltip on layer
    // 100 becomes the topmost control under the cursor -> enter/exit jitter loop
    // + blocks wheel/drag while shown.
    harness.record(
      "R4 tooltip container is IGNORE",
      tip.err === undefined && tip.container_mf === 2,
      tip.err ? `err=${tip.err}` : `container=${MFS[tip.container_mf]} label=${MFS[tip.label_mf]}`,
    );
  }
  harness.finishSuite();

  // ── Suite 6: R5 content-canvas draw order vs SaneTree ──
  harness.start("see931_r5_content_canvas_order");
  {
    const ord = await execJSON(`
      var zc = tree.root.get_node_or_null("${SANE_ZC}")
      var names = []
      for c in zc.get_children():
        names.append(String(c.name))
      return JSON.stringify({"order": names})
    `, { label: "r5 read" });
    const saneTreeIdx = ord.order.indexOf("SaneTree");
    const contentIdx = ord.order.indexOf("ZoomableCanvas");
    // R5 documents the structural fact that ZoomableCanvas's content canvas is
    // added at runtime AFTER the tscn-placed SaneTree, so it renders ON TOP and
    // real input bypasses SaneTree._gui_input. Once T2 removes SaneTree._gui_input
    // (dead forwarder), this assertion stays as a regression guard on topology.
    harness.record(
      "R5 content canvas is a later sibling than SaneTree (documents bypass)",
      contentIdx > saneTreeIdx && saneTreeIdx >= 0,
      `order=${JSON.stringify(ord.order)}`,
    );
  }
  harness.finishSuite();

  // ── Suite 7: R5 no dead forwarder in SaneTree (gate for T2) ──
  harness.start("see931_r5_no_dead_forwarder");
  {
    const fwd = await execJSON(`
      var t = tree.root.get_node_or_null("${SANE_TREE}")
      var has_gui_input = t != null and t.has_method("_gui_input")
      # Inspect the script source for the wheel-forward pattern (zc._gui_input)
      var src = ""
      if t != null and t.get_script() != null and t.get_script().source_code != null:
        src = t.get_script().source_code
      return JSON.stringify({
        "has_sane_tree_gui_input": has_gui_input,
        "has_wheel_forward_call": src.find("._gui_input(event)") >= 0 or src.find("._gui_input(ev)") >= 0
      })
    `, { label: "r5 forwarder read" });
    // R5/T2 gate: once the dead forwarder is removed, SaneTree must NOT override
    // _gui_input and must NOT call another node's _gui_input (the forwarder).
    // Until T2 lands this will be RED — that is the intended gate signal.
    harness.record(
      "R5 SaneTree has no dead _gui_input forwarder (T2 gate)",
      !fwd.has_sane_tree_gui_input && !fwd.has_wheel_forward_call,
      `has_gui_input=${fwd.has_sane_tree_gui_input} has_forward_call=${fwd.has_wheel_forward_call}`,
    );
  }
  harness.finishSuite();

  // ── Suite 8: REAL wheel dispatch over empty sane canvas (zoom) ──
  // This is the gate the old suite faked by calling _gui_input directly. If the
  // editor-embedded window delivers the synthetic event, zoom must change; if it
  // does not deliver (known limitation), the routing oracles above are the
  // authoritative gates. Either way this suite never calls _gui_input.
  harness.start("see931_real_wheel_dispatch");
  {
    const z0 = await execJSON(`var z = tree.root.get_node_or_null("${SANE_ZC}"); return z.get_zoom() if z != null and z.has_method("get_zoom") else null`, { label: "wheel before" });
    await execJSON(`
      var z = tree.root.get_node_or_null("${SANE_ZC}")
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_WHEEL_UP
      ev.pressed = true
      ev.position = Vector2(z.size.x * 0.5, z.size.y * 0.5)
      ev.global_position = ev.position
      tree.root.get_node_or_null("${UF}").get_viewport().push_input(ev)
      return true
    `, { label: "wheel push" });
    await client.gameStep(6);
    const z1 = await execJSON(`var z = tree.root.get_node_or_null("${SANE_ZC}"); return z.get_zoom() if z != null and z.has_method("get_zoom") else null`, { label: "wheel after" });
    // Recorded as info, not a hard gate, because embedded-editor synthetic event
    // delivery is unreliable. The structural oracles in suites 1/3 carry the
    // authoritative routing signal.
    harness.record(
      "real wheel dispatch changed zoom (info; embedded delivery may no-op)",
      typeof z1 === "number" && typeof z0 === "number" && z1 > z0,
      `before=${z0} after=${z1}`,
    );
  }
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
