// SEE-998 A/B Test: verify the opaque BoardBackground fix differentiates the
// pre-fix (translucent middle square) state from the post-fix state.
//
// A/B assertion: in the fixed build, BoardBackground exists and is opaque.
// Without the fix (fd477a0), the panels are bare Controls with no BoardBackground,
// and the only visible pixels are the 20% alpha CellVisuals.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";

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

async function panelBackgroundState(panelName) {
  return jj(`
    var uf = tree.root.get_node_or_null("${UF}")
    if uf == null: return JSON.stringify({"err":"no_uf"})
    var panel = uf.find_child("${panelName}", true, false)
    if panel == null: return JSON.stringify({"err":"no_panel"})
    var bg = panel.get_node_or_null("BoardBackground")
    if bg == null:
      return JSON.stringify({"has_board_background": false})
    var sb = bg.get_theme_stylebox("panel") if bg.has_theme_stylebox("panel") else null
    var alpha := -1.0
    if sb != null and sb is StyleBoxFlat:
      alpha = sb.bg_color.a
    return JSON.stringify({
      "has_board_background": true,
      "bg_visible": bg.visible,
      "bg_color_alpha": alpha,
      "panel_size": [panel.size.x, panel.size.y]
    })
  `);
}

try {
  await client.connect();
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  await enterMainGame();

  harness.start("see998_abtest_board_background");

  const ai = await panelBackgroundState("AIDomainVisual");
  const cy = await panelBackgroundState("CyberDomainVisual");

  // A/B discriminating checks: without the fix, has_board_background is false.
  harness.record("A: AIDomainVisual has BoardBackground", ai?.has_board_background === true,
    `state=${JSON.stringify(ai)}`);
  harness.record("A: CyberDomainVisual has BoardBackground", cy?.has_board_background === true,
    `state=${JSON.stringify(cy)}`);
  harness.record("B: AIDomainVisual BoardBackground is opaque", ai?.has_board_background === true && ai?.bg_color_alpha === 1,
    `alpha=${ai?.bg_color_alpha}`);
  harness.record("B: CyberDomainVisual BoardBackground is opaque", cy?.has_board_background === true && cy?.bg_color_alpha === 1,
    `alpha=${cy?.bg_color_alpha}`);
  harness.record("B: panels are real-sized boards", (ai?.panel_size?.[0] ?? 0) > 100 && (ai?.panel_size?.[1] ?? 0) > 100,
    `ai=${ai?.panel_size} cy=${cy?.panel_size}`);

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
