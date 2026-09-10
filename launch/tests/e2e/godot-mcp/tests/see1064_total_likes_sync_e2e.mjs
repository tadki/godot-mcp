// SEE-1064 godot-mcp E2E — TotalLikes UI sync (B3) + Mouse LCPS integer (B4).
//
// Five-segment closed loop (per /godot-mcp-e2e skill):
// 1. backend init: EconomyManager clean, GameState.total_likes = 0.
// 2. frontend visible: UIFramework + StatsTotalLikesLabel + HardwareBoard + Mouse widget.
// 3. input: upgrade Mouse via the real EventBus.hardware_upgrade_requested signal
//    (same path the + button takes), several levels.
// 4. backend state change: Mouse LCPS grows integer-per-level (B4); passive LCPS
//    accumulation mirrors into GameState.total_likes over stepped frames (B3);
//    EPD grant baseline advances from the synced likes (EPD chain intact).
// 5. frontend visual feedback: StatsTotalLikesLabel text updates to reflect the
//    synced total; the Mouse HardwareWidget LCPS line reads 10.00 at Lv10, not
//    10.05 (B4 display regression); screenshot captured.
//
// RUN REQUIREMENT: the Godot editor must be running the shared/SEE-1064 branch
// (commit 9fcbfc5) with the godot-mcp addon connected. On master/9fcbfc5^ the
// B3 assertions (TotalLikes sync) and the B4 Lv10=10.00 assertion will FAIL —
// which is exactly the A/B signal.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SCREENSHOT_DIR = new URL("./screenshots/see1064/", import.meta.url).pathname;
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function jj(src) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await client.exec(src);
    if (r !== null && r !== undefined) return r;
    try { await client.gameStep(1); } catch (_) {}
  }
  console.error("[jj] null after retries:", src.slice(0, 140).replace(/\s+/g, " "));
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
  await client.exec(`ProfileManager.create_profile("RevySEE1064")`);
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
    var b = s.find_child("*Start*", true, false)
    if b is Button: b.pressed.emit()
  `);
  await client.gameFreeze();
  await client.gameStep(40);
  // Clean economy baseline so the B3 sync delta is observable.
  await client.exec(`
    EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})
    GameState.total_likes = 0
    GameState.total_clicks = 0
  `);
  await client.gameStep(5);
}

// Locate the Mouse hardware id at runtime (CSV HardwareType "Mouse (T1)").
async function findMouseId() {
  return jj(`
    var all = HardwareManager.get_all_hardware()
    for k in all.keys():
      var hw = all[k]
      if hw.data.display_name.findn("Mouse") != -1 or String(k).findn("mouse") != -1:
        return {"id": String(k), "name": hw.data.display_name}
    # Fallback: first hardware sorted by sort_order (Mouse is sort_order 1 / T1).
    var keys = all.keys()
    if keys.size() > 0:
      var k0 = keys[0]
      return {"id": String(k0), "name": all[k0].data.display_name}
    return {"id": "", "name": ""}
  `);
}

async function backendInit() {
  harness.start("see1064_backend_init");
  const st = await jj(`return {"like_total": EconomyManager.get_like_total(), "total_likes": GameState.total_likes, "lcps": EconomyManager.get_lcps()}`);
  harness.record("EconomyManager starts at like_total 0", (st?.like_total ?? -1) === 0, JSON.stringify(st));
  harness.record("GameState.total_likes starts at 0", (st?.total_likes ?? -1) === 0, JSON.stringify(st));
  harness.finishSuite();
}

async function frontendVisible() {
  harness.start("see1064_frontend_visible");
  await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.HARDWARE_BOARD, EventBus.PanelAction.SHOW)`);
  await client.gameStep(20);
  const ui = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    if uf == null: return {"err": "no_ui"}
    var total = uf.find_child("StatsTotalLikesLabel", true, false)
    var hb = uf.find_child("HardwareBoard", true, false)
    return {
      "total_found": total != null,
      "total_text": total.text if total != null else "",
      "board_found": hb != null
    }
  `);
  harness.record("StatsTotalLikesLabel exists", ui?.total_found === true, JSON.stringify(ui));
  harness.record("HardwareBoard exists", ui?.board_found === true, JSON.stringify(ui));
  await snap("01_initial");
  harness.finishSuite();
}

async function b4MouseLcpsInteger() {
  harness.start("see1064_b4_mouse_lcps_integer");
  const mouse = await findMouseId();
  harness.record("Mouse hardware located", !!mouse?.id, JSON.stringify(mouse));
  if (!mouse?.id) { harness.finishSuite(); return; }

  // Unlock + purchase Mouse so upgrades are accepted (idempotent — no-op if done).
  await client.exec(`
    var mid = StringName("${mouse.id}")
    var hw = HardwareManager.get_hardware(mid)
    if hw != null:
      if not hw.state.is_unlocked: EventBus.hardware_unlock_requested.emit(mid)
    `);
  await client.gameStep(5);
  await client.exec(`
    var mid = StringName("${mouse.id}")
    var hw = HardwareManager.get_hardware(mid)
    if hw != null and not hw.state.is_purchased: EventBus.hardware_purchase_requested.emit(mid)
  `);
  await client.gameStep(10);

  // Upgrade Mouse to Lv10 via the real upgrade signal (the + button path).
  for (let i = 0; i < 10; i++) {
    await client.exec(`EventBus.hardware_upgrade_requested.emit(StringName("${mouse.id}"))`);
    await client.gameStep(3);
  }

  // Read the Mouse HardwareWidget LCPS display line + the raw calculator value.
  const lcps = await jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    var mid = StringName("${mouse.id}")
    var raw_lcps = EconomyManager.get_hardware_lcps(mid)
    var widget_text = ""
    var hb = uf.find_child("HardwareBoard", true, false) if uf != null else null
    if hb != null:
      var list = hb.find_child("HardwareList", true, false)
      if list != null:
        for c in list.get_children():
          if c is PanelContainer and c.get("hardware_id") == mid:
            var lbl = c.find_child("StatsLabel", true, false)
            if lbl != null: widget_text = lbl.text
            break
    return {"raw_lcps": raw_lcps, "widget_text": widget_text}
  `);
  // B4: raw LCPS at Lv10 must be exactly 10.0 (was 10.05).
  harness.record("Mouse Lv10 raw LCPS == 10.0 (B4)", (lcps?.raw_lcps ?? -1) === 10.0, JSON.stringify(lcps));
  // B4 display: the widget "Like Click Per Second: 10.00" line, not "10.05".
  const txt = String(lcps?.widget_text ?? "");
  harness.record("Mouse widget LCPS shows 10.00 not 10.05 (B4)", txt.includes("10.00") && !txt.includes("10.05"), JSON.stringify({widget_text: txt}));
  await snap("02_mouse_lv10");
  harness.finishSuite();
}

async function b3TotalLikesSync() {
  harness.start("see1064_b3_total_likes_sync");
  // With Mouse at Lv10 LCPS=10, step ~3s of game time and watch GameState.total_likes
  // (the UI's source) advance alongside EconomyManager._like_total. On the before
  // code total_likes stays 0; on the after code it grows ~LCPS*seconds.
  const before = await jj(`return {"total_likes": GameState.total_likes, "like_total": EconomyManager.get_like_total()}`);
  await client.gameThaw();
  await client.gameStepMs(3000);
  await client.gameFreeze();
  const after = await jj(`
    return {
      "total_likes": GameState.total_likes,
      "like_total": EconomyManager.get_like_total(),
      "epd_granted_from_likes": EconomyManager._epd_granted_from_likes,
      "label_text": (tree.root.get_node_or_null("${UF}")?.find_child("StatsTotalLikesLabel", true, false)?.text) ?? ""
    }
  `);
  harness.record("GameState.total_likes grew from LCPS (B3)", (after?.total_likes ?? 0) > (before?.total_likes ?? 0), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  harness.record("GameState.total_likes tracks like_total (B3)", (after?.total_likes ?? 0) >= Math.floor((after?.like_total ?? 0)) - 1, JSON.stringify(after));
  harness.record("EPD grant baseline advanced (EPD chain intact)", (after?.epd_granted_from_likes ?? -1) > 0, JSON.stringify(after));
  harness.record("StatsTotalLikesLabel text is non-zero (B3 UI)", Number((after?.label_text ?? "").replace(/[^0-9.]/g, "")) > 0, JSON.stringify(after));
  await snap("03_total_likes_synced");
  harness.finishSuite();
}

// --- main ---
try {
  await client.connect();
  await runFrozenAndBoot();
  await enterMainGame();
  await backendInit();
  await frontendVisible();
  await b4MouseLcpsInteger();
  await b3TotalLikesSync();
} catch (e) {
  harness.record("see1064_e2e_fatal", false, String(e).slice(0, 400));
} finally {
  await teardown(client);
}

const { pass, total } = harness.summary();
console.log(`\nSEE-1064 E2E summary: ${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

async function runFrozenAndBoot() {
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
}
