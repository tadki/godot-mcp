// SEE-998 E2E QA: verify V/C domain visuals render as solid boards (opaque
// cream BoardBackground) in the MIDDLE_RIGHT zone, not as a translucent square.
// Regression: B/InventoryVisual toggle + HardwareBoard position unchanged.
//
// Pre-fix bug: AIDomainVisual/CyberDomainVisual roots were bare Control with
// only 20%-alpha CellVisuals, so V/C showed a faint translucent square in the
// middle. Fix (fd477a0) adds a BoardBackground Panel with opaque StyleBoxFlat.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SCREENSHOT_DIR = new URL("./screenshots/see998/", import.meta.url).pathname;
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function snap(name) {
  const shot = await client.editorRead("screenshot_game", { max_width: 960 }).catch(() => null);
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
  await client.exec(`ProfileManager.create_profile("RevySEE998")`);
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
    if ne != null: ne.text = "RevySEE998"; ne.text_changed.emit("RevySEE998")
    if b is Button: b.pressed.emit()
  `);
  await client.gameFreeze();
  await client.gameStep(40);
}

// Structural check: BoardBackground exists and is opaque (the SEE-998 fix).
async function probeBoardBackground(panelPath) {
  return client.exec(`
    var uf = tree.root.get_node_or_null("${UF}")
    if uf == null: return JSON.stringify({"err":"no_uf"})
    var panel = uf.find_child("${panelPath}", true, false)
    if panel == null: return JSON.stringify({"err":"no_panel"})
    var bg = panel.get_node_or_null("BoardBackground")
    var info := {"panel_exists": true, "has_bg": bg != null}
    if bg != null:
      var sb = bg.get_theme_stylebox("panel") if bg.has_theme_stylebox("panel") else null
      var alpha := -1.0
      var sb_class := ""
      if sb != null:
        sb_class = sb.get_class()
        if sb is StyleBoxFlat:
          alpha = sb.bg_color.a
      info["bg_visible"] = bg.visible
      info["bg_global_rect"] = [bg.get_global_rect().position.x, bg.get_global_rect().position.y, bg.get_global_rect().size.x, bg.get_global_rect().size.y]
      info["bg_color_alpha"] = alpha
      info["bg_sb_class"] = sb_class
    return JSON.stringify(info)
  `);
}

async function panelVisible(name) {
  return jj(`var uf = tree.root.get_node_or_null("${UF}"); var p = uf.find_child("${name}", true, false); return p != null and p.visible`);
}

async function panelGlobalRect(name) {
  return jj(`var uf = tree.root.get_node_or_null("${UF}"); var p = uf.find_child("${name}", true, false); var r = p.get_global_rect(); return {"x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y}`);
}

async function emitToggle(panelEnum) {
  await client.exec(`EventBus.emit_signal("panel_requested", ${panelEnum}, EventBus.PanelAction.TOGGLE)`);
  await client.gameStep(20);
}

try {
  await client.connect();
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  await enterMainGame();

  const sceneOk = await client.exec(`return tree.current_scene != null and String(tree.current_scene.name) == "UIFramework"`);
  harness.start("see998_setup");
  harness.record("reached UIFramework game scene", sceneOk === true, `scene=${sceneOk}`);
  await snap("00_baseline");
  harness.finishSuite();

  // ── Structural fix (SEE-998): BoardBackground opaque panel exists ──
  harness.start("see998_board_background_structure");
  {
    const ai = await probeBoardBackground("AIDomainVisual");
    const cy = await probeBoardBackground("CyberDomainVisual");
    harness.record("AIDomainVisual has BoardBackground", ai?.has_bg === true, JSON.stringify(ai));
    harness.record("AIDomainVisual BoardBackground opaque (alpha==1)", ai?.bg_color_alpha === 1, `alpha=${ai?.bg_color_alpha}`);
    harness.record("AIDomainVisual BoardBackground has nonzero rect", (ai?.bg_global_rect?.[2] ?? 0) > 0 && (ai?.bg_global_rect?.[3] ?? 0) > 0, JSON.stringify(ai?.bg_global_rect));
    harness.record("CyberDomainVisual has BoardBackground", cy?.has_bg === true, JSON.stringify(cy));
    harness.record("CyberDomainVisual BoardBackground opaque (alpha==1)", cy?.bg_color_alpha === 1, `alpha=${cy?.bg_color_alpha}`);
    harness.record("CyberDomainVisual BoardBackground has nonzero rect", (cy?.bg_global_rect?.[2] ?? 0) > 0 && (cy?.bg_global_rect?.[3] ?? 0) > 0, JSON.stringify(cy?.bg_global_rect));
  }
  harness.finishSuite();

  // ── V key: AI domain visual toggles on, renders solid board ──
  harness.start("see998_v_key_ai_domain");
  {
    const beforeVisible = await panelVisible("AIDomainVisual");
    harness.record("AIDomainVisual hidden before V", beforeVisible === false, `visible=${beforeVisible}`);
    await emitToggle("PanelZoneManager.UIPanel.AI_DOMAIN_VISUAL");
    const afterVisible = await panelVisible("AIDomainVisual");
    harness.record("AIDomainVisual visible after V", afterVisible === true, `visible=${afterVisible}`);
    const rect = await panelGlobalRect("AIDomainVisual");
    harness.record("AIDomainVisual renders with real size", (rect?.w ?? 0) > 50 && (rect?.h ?? 0) > 50, JSON.stringify(rect));
    await snap("01_v_on");
    // toggle off
    await emitToggle("PanelZoneManager.UIPanel.AI_DOMAIN_VISUAL");
    const offVisible = await panelVisible("AIDomainVisual");
    harness.record("AIDomainVisual hidden after V toggle-off", offVisible === false, `visible=${offVisible}`);
  }
  harness.finishSuite();

  // ── C key: Cyber domain visual toggles on, renders solid board ──
  harness.start("see998_c_key_cyber_domain");
  {
    const beforeVisible = await panelVisible("CyberDomainVisual");
    harness.record("CyberDomainVisual hidden before C", beforeVisible === false, `visible=${beforeVisible}`);
    await emitToggle("PanelZoneManager.UIPanel.CYBER_DOMAIN_VISUAL");
    const afterVisible = await panelVisible("CyberDomainVisual");
    harness.record("CyberDomainVisual visible after C", afterVisible === true, `visible=${afterVisible}`);
    const rect = await panelGlobalRect("CyberDomainVisual");
    harness.record("CyberDomainVisual renders with real size", (rect?.w ?? 0) > 50 && (rect?.h ?? 0) > 50, JSON.stringify(rect));
    await snap("02_c_on");
    // toggle off
    await emitToggle("PanelZoneManager.UIPanel.CYBER_DOMAIN_VISUAL");
    const offVisible = await panelVisible("CyberDomainVisual");
    harness.record("CyberDomainVisual hidden after C toggle-off", offVisible === false, `visible=${offVisible}`);
  }
  harness.finishSuite();

  // ── Regression: B key InventoryVisual still toggles ──
  harness.start("see998_regression_b_inventory");
  {
    const beforeVisible = await panelVisible("InventoryVisual");
    harness.record("InventoryVisual initial state captured", beforeVisible !== null, `visible=${beforeVisible}`);
    await emitToggle("PanelZoneManager.UIPanel.INVENTORY_VISUAL");
    const afterVisible = await panelVisible("InventoryVisual");
    harness.record("InventoryVisual toggled by B", afterVisible === !beforeVisible, `before=${beforeVisible} after=${afterVisible}`);
    await snap("03_b_on");
    // toggle back to restore
    await emitToggle("PanelZoneManager.UIPanel.INVENTORY_VISUAL");
  }
  harness.finishSuite();

  // ── Regression: HardwareBoard position unchanged (MiddleLeft) ──
  harness.start("see998_regression_hardware_board");
  {
    const rect = await panelGlobalRect("HardwareBoard");
    harness.record("HardwareBoard present with size", (rect?.w ?? 0) > 0 && (rect?.h ?? 0) > 0, JSON.stringify(rect));
    const hwInfo = await jj(`var uf = tree.root.get_node_or_null("${UF}"); var p = uf.find_child("HardwareBoard", true, false); var parent := ""; if p != null and p.get_parent() != null: parent = String(p.get_parent().name); return {"parent": parent, "visible": p.visible if p != null else false}`);
    harness.record("HardwareBoard parent is MiddleLeftContent", hwInfo?.parent === "MiddleLeftContent", JSON.stringify(hwInfo));
    await snap("04_hardware_unchanged");
  }
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
    console.error("RECENT ERRORS:", JSON.stringify(logs).slice(0, 1500));
  } catch {}
  await teardown(client);
  process.exit(2);
}
