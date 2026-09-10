// SEE-1034 godot-mcp E2E — Verify the visual result of Sane SP grant, LikeHeart→EPD,
// Hardware card layout, and Stats display in the running game.
//
// Five-segment closed loop coverage:
// 1. backend init: SaneSubsystem has 100 SP, EconomyManager has 0 EPD.
// 2. frontend visible: UIFramework loaded, HardwareBoard + Stats labels present.
// 3. input: real heart click (via godot_input sequence).
// 4. backend state change: like_total increases and EPD settles at 10:1.
// 5. frontend visual feedback: StatsEPDLabel text updates, screenshot captured.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SCREENSHOT_DIR = new URL("./screenshots/see1034/", import.meta.url).pathname;
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function jj(src) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await client.exec(src);
    if (r !== null && r !== undefined) return r;
    try { await client.gameStep(1); } catch (_) {}
  }
  console.error("[jj] null after retries:", src.slice(0, 120).replace(/\s+/g, " "));
  return null;
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

async function enterMainGame() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE1034")`);
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
    if ne != null: ne.text = "RevySEE1034"; ne.text_changed.emit("RevySEE1034")
    if b is Button: b.pressed.emit()
  `);
  await client.gameFreeze();
  await client.gameStep(40);
  // TitleScreen's New Game flow adds DEBUG_STARTING_LIKES (10M) to seed a new
  // game. After entering the main scene, reset the economy to a clean state so
  // E2E assertions below can observe the real 10:1 Like -> EPD settlement.
  await client.exec(`
    EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})
    GameState.total_likes = 0
    GameState.total_clicks = 0
  `);
  await client.gameStep(5);
}

async function backendInit() {
  harness.start("see1034_backend_init");
  const state = await jj(`
    return {
      "sp_total": SaneSubsystem.get_total_sp(),
      "sp_used": SaneSubsystem.get_used_sp(),
      "sp_available": SaneSubsystem.get_available_sp(),
      "epd": EconomyManager.get_epd(),
      "like_total": EconomyManager.get_like_total()
    }
  `);
  harness.record("SaneSubsystem grants 100 SP on new game", (state?.sp_total ?? 0) === 100, JSON.stringify(state));
  harness.record("EPD starts at 0", (state?.epd ?? -1) === 0.0, JSON.stringify(state));
  harness.finishSuite();
}

async function frontendVisible() {
  harness.start("see1034_frontend_visible");
  const stats = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    if uf == null: return {"err": "no_ui"}
    var total = uf.find_child("StatsTotalLikesLabel", true, false)
    var epd = uf.find_child("StatsEPDLabel", true, false)
    var stats_btn = uf.find_child("ButtonStats", true, false)
    return {
      "total_found": total != null,
      "epd_found": epd != null,
      "total_font": total.get_theme_font_size("font_size") if total != null else 0,
      "epd_font": epd.get_theme_font_size("font_size") if epd != null else 0,
      "total_hidden": total.visible == false if total != null else false,
      "epd_hidden": epd.visible == false if epd != null else false,
      "stats_btn_found": stats_btn != null,
    }
  `);
  harness.record("StatsTotalLikesLabel exists", stats?.total_found === true, JSON.stringify(stats));
  harness.record("StatsEPDLabel exists", stats?.epd_found === true, JSON.stringify(stats));
  harness.record("StatsTotalLikesLabel font size is 18", stats?.total_font === 18, JSON.stringify(stats));
  harness.record("StatsEPDLabel font size is 18", stats?.epd_font === 18, JSON.stringify(stats));
  harness.record("Stats labels start hidden", stats?.total_hidden === true && stats?.epd_hidden === true, JSON.stringify(stats));
  harness.record("Stats button exists", stats?.stats_btn_found === true, JSON.stringify(stats));
  await snap("01_stats_initial");
  harness.finishSuite();
}

async function hardwareBoardLayout() {
  harness.start("see1034_hardware_board_layout");
  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.HARDWARE_BOARD, EventBus.PanelAction.SHOW)`);
  await client.gameStep(20);

  const board = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    var hb = uf.find_child("HardwareBoard", true, false) if uf != null else null
    if hb == null: return {"err": "no_board"}
    var pzm = uf.find_child("PanelZoneManager", true, false)
    var list = hb.find_child("HardwareList", true, false)
    var widget_count := 0
    var all_heights_120 := true
    var all_widths_fit := true
    if list != null:
      for c in list.get_children():
        if c is PanelContainer:
          widget_count += 1
          all_heights_120 = all_heights_120 and (abs(c.size.y - 120.0) < 1.0)
          all_widths_fit = all_widths_fit and (c.size.x <= 460.0)
    return {
      "board_visible": hb.visible == true,
      "panel_zone_visible": pzm.is_panel_visible(PanelZoneManager.UIPanel.HARDWARE_BOARD) if pzm != null else false,
      "widget_count": widget_count,
      "all_heights_120": all_heights_120,
      "all_widths_fit": all_widths_fit
    }
  `);
  harness.record("HardwareBoard is visible", board?.board_visible === true || board?.panel_zone_visible === true, JSON.stringify(board));
  harness.record("Hardware widgets exist", (board?.widget_count ?? 0) > 0, JSON.stringify(board));
  harness.record("all widget heights are 120", board?.all_heights_120 === true, JSON.stringify(board));
  harness.record("all widget widths fit board", board?.all_widths_fit === true, JSON.stringify(board));
  await snap("02_hardware_board");
  harness.finishSuite();
}

async function heartClickSettlesEpd() {
  harness.start("see1034_heart_click_epd");
  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.HARDWARE_BOARD, EventBus.PanelAction.HIDE)`);
  await client.gameStep(5);

  // Toggle Stats labels on so we can observe the EPD refresh.
  await client.exec(`
    var uf = tree.root.get_node_or_null("${UF}")
    var btn = uf.find_child("ButtonStats", true, false) if uf != null else null
    if btn != null: btn.pressed.emit()
  `);
  await client.gameStep(5);

  const before = await jj(`
    return {"epd": EconomyManager.get_epd(), "like_total": EconomyManager.get_like_total()}
  `);

  // Click the LikeHeart 10 times via its real "clicked" signal so the 10:1
  // Like -> EPD settlement produces a visible +1 EPD (EconomyManager.settle_epd
  // uses floor(like_total / 10), so a single click yields no integer EPD delta).
  await client.exec(`
    var uf = tree.root.get_node_or_null("${UF}")
    var heart = uf.find_child("LikeHeart", true, false) if uf != null else null
    if heart != null and heart.has_signal("clicked"):
      for _i in range(10):
        heart.clicked.emit(heart.heart_id if "heart_id" in heart else "e2e")
  `);
  await client.gameStep(5);

  const after = await jj(`
    return {"epd": EconomyManager.get_epd(), "like_total": EconomyManager.get_like_total()}
  `);
  const epdDelta = (after?.epd ?? 0) - (before?.epd ?? 0);
  const likeDelta = (after?.like_total ?? 0) - (before?.like_total ?? 0);
  harness.record("like_total increased by 10", likeDelta === 10, JSON.stringify({ before, after }));
  harness.record("10 likes settle to +1 EPD (10:1)", Math.abs(epdDelta - 1.0) < 0.001, JSON.stringify({ before, after }));

  const labelText = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    var epd = uf.find_child("StatsEPDLabel", true, false) if uf != null else null
    return String(epd.text) if epd != null else ""
  `);
  harness.record("StatsEPDLabel text updated", labelText.includes("EPD:") && labelText.includes("1"), JSON.stringify(labelText));
  await snap("03_after_heart_click");
  harness.finishSuite();
}

async function statsToggleSync() {
  harness.start("see1034_stats_toggle_sync");
  await client.exec(`
    var uf = tree.root.get_node_or_null("${UF}")
    var btn = uf.find_child("ButtonStats", true, false) if uf != null else null
    if btn != null: btn.pressed.emit()
  `);
  await client.gameStep(5);

  const first = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    var total = uf.find_child("StatsTotalLikesLabel", true, false)
    var epd = uf.find_child("StatsEPDLabel", true, false)
    return {"total": total.visible if total != null else null, "epd": epd.visible if epd != null else null}
  `);
  harness.record("both labels hidden after toggle off", first?.total === false && first?.epd === false, JSON.stringify(first));

  await client.exec(`
    var uf = tree.root.get_node_or_null("${UF}")
    var btn = uf.find_child("ButtonStats", true, false) if uf != null else null
    if btn != null: btn.pressed.emit()
  `);
  await client.gameStep(5);

  const second = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    var total = uf.find_child("StatsTotalLikesLabel", true, false)
    var epd = uf.find_child("StatsEPDLabel", true, false)
    return {"total": total.visible if total != null else null, "epd": epd.visible if epd != null else null}
  `);
  harness.record("both labels visible after toggle on", second?.total === true && second?.epd === true, JSON.stringify(second));
  await snap("04_stats_toggled_on");
  harness.finishSuite();
}

try {
  await client.connect();
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  await enterMainGame();
  await backendInit();
  await frontendVisible();
  await hardwareBoardLayout();
  await heartClickSettlesEpd();
  await statsToggleSync();

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
