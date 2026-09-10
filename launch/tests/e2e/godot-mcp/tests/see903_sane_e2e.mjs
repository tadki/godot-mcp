// SEE-903 E2E visual/layout/zoom regression test for the SANE panel.
// Runs UIFramework directly, opens SANE, and asserts layout, visibility, zoom,
// and canvas attachment. Screenshots are written for human inspection.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const client = new GodotMcpClient();
// Anchor to this script's location, not cwd, to prevent self-nesting screenshot dirs.
const SCREENSHOT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "screenshots", "see903");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BTN_SANE = "/root/UIFramework/MainHBox/LeftPanel/BottomBar/BottomBarMargin/BottomBarHBox/SANEBox/ButtonSANE";
const RIGHT_PANEL = "/root/UIFramework/MainHBox/RightPanel";
const SANE_TREE = "/root/UIFramework/MainHBox/LeftPanel/SceneArea/SceneCanvas/MiddleOverlay/SaneZoomableCanvas/SaneTree";
const SANE_ZOOM_CANVAS = "/root/UIFramework/MainHBox/LeftPanel/SceneArea/SceneCanvas/MiddleOverlay/SaneZoomableCanvas";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed += 1;
  } else {
    console.error(`  FAIL: ${message}`);
    failed += 1;
  }
}

function saveScreenshot(name, screenshotResult) {
  const imgText = screenshotResult?.content?.find((c) => c.type === "image")?.data;
  if (!imgText) {
    console.error(`  FAIL: screenshot ${name} returned no image data`);
    failed += 1;
    return;
  }
  const buf = Buffer.from(imgText, "base64");
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  writeFileSync(path, buf);
  console.log(`  SS: ${path} (${buf.length} bytes)`);
}

async function runTest() {
  await client.connect();

  console.log("\n=== setup: run UIFramework directly ===");
  await client.editor("run", { frozen: true, scene_path: "res://scenes/ui/ui_framework.tscn" });
  await client.gameStep(15);
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE903")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
  // Activate the first node as the home node so SANE centers on something playable.
  await client.exec(`var first = SaneSubsystem.get_all_node_ids()[0]; SaneSubsystem.set_home_node(first)`);

  console.log("\n=== baseline: SANE closed ===");
  saveScreenshot("01_baseline_sane_closed", await client.editorRead("screenshot_game", { max_width: 1280 }));
  const baselineLayout = await client.exec(`
    var sane = tree.root.get_node_or_null("${SANE_TREE}")
    var right = tree.root.get_node_or_null("${RIGHT_PANEL}")
    var saneBtn = tree.root.get_node_or_null("${BTN_SANE}")
    return {
      "sane_visible": sane.visible if sane != null else null,
      "right_panel_visible": right.visible if right != null else null,
      "sane_btn_size": saneBtn.size if saneBtn != null else null,
    }
  `);
  assert(baselineLayout.sane_visible !== true, "SANE tree is hidden before opening");
  assert(baselineLayout.right_panel_visible !== false, "Right panel is visible before opening SANE");

  console.log("\n=== action: open SANE ===");
  await client.exec(`var btn = tree.root.get_node_or_null("${BTN_SANE}"); if btn != null: btn.pressed.emit()`);
  await client.gameStep(20);

  const openState = await client.exec(`
    var sane = tree.root.get_node_or_null("${SANE_TREE}")
    var right = tree.root.get_node_or_null("${RIGHT_PANEL}")
    var canvas = tree.root.get_node_or_null("${SANE_ZOOM_CANVAS}")
    return {
      "sane_found": sane != null,
      "sane_visible": sane.visible if sane != null else false,
      "node_count": sane._node_visuals.size() if sane != null else 0,
      "link_count": sane._link_visuals.size() if sane != null else 0,
      "right_panel_visible": right.visible if right != null else true,
      "zoom": canvas.get_zoom() if canvas != null else 0,
      "same_canvas": sane._canvas == canvas.content_canvas() if sane != null and canvas != null else false,
    }
  `);
  assert(openState.sane_found, "SANE tree node exists");
  assert(openState.sane_visible === true, "SANE tree is visible after opening");
  assert(openState.node_count === 108, `SANE has 108 node visuals (got ${openState.node_count})`);
  assert(openState.link_count === 151, `SANE has 151 link visuals (got ${openState.link_count})`);
  assert(openState.right_panel_visible === false, "Right panel is hidden while SANE is open");
  assert(openState.zoom >= 0.9 && openState.zoom <= 1.1, `SANE opens centered at zoom ~1.0 (got ${openState.zoom})`);
  assert(openState.same_canvas === true, "SANE tree attaches visuals to the ZoomableCanvas content canvas");

  saveScreenshot("02_sane_open", await client.editorRead("screenshot_game", { max_width: 1280 }));

  console.log("\n=== action: zoom out with mouse wheel ===");
  const zoomOutState = await client.exec(`
    var canvas = tree.root.get_node_or_null("${SANE_ZOOM_CANVAS}")
    if canvas == null: return {"found": false}
    var before = canvas.get_zoom()
    for i in range(10):
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_WHEEL_DOWN
      ev.pressed = true
      canvas._gui_input(ev)
    return {"found": true, "before": before, "after": canvas.get_zoom()}
  `);
  assert(zoomOutState.found && zoomOutState.after < zoomOutState.before, "Zoom out decreases zoom level");
  saveScreenshot("03_sane_zoomed_out", await client.editorRead("screenshot_game", { max_width: 1280 }));

  console.log("\n=== action: zoom in with mouse wheel ===");
  const zoomInState = await client.exec(`
    var canvas = tree.root.get_node_or_null("${SANE_ZOOM_CANVAS}")
    if canvas == null: return {"found": false}
    var before = canvas.get_zoom()
    for i in range(10):
      var ev = InputEventMouseButton.new()
      ev.button_index = MOUSE_BUTTON_WHEEL_UP
      ev.pressed = true
      canvas._gui_input(ev)
    return {"found": true, "before": before, "after": canvas.get_zoom()}
  `);
  assert(zoomInState.found && zoomInState.after > zoomInState.before, "Zoom in increases zoom level");
  saveScreenshot("04_sane_zoomed_in", await client.editorRead("screenshot_game", { max_width: 1280 }));

  console.log("\n=== action: close SANE ===");
  await client.exec(`var btn = tree.root.get_node_or_null("${BTN_SANE}"); if btn != null: btn.pressed.emit()`);
  await client.gameStep(10);
  const closeState = await client.exec(`
    var sane = tree.root.get_node_or_null("${SANE_TREE}")
    var right = tree.root.get_node_or_null("${RIGHT_PANEL}")
    return {
      "sane_visible": sane.visible if sane != null else true,
      "right_panel_visible": right.visible if right != null else false,
    }
  `);
  assert(closeState.sane_visible === false, "SANE tree is hidden after closing");
  assert(closeState.right_panel_visible === true, "Right panel is visible after closing SANE");
  saveScreenshot("05_sane_closed", await client.editorRead("screenshot_game", { max_width: 1280 }));

  await client.gameThaw();
  await client.editor("stop");
  await client.close();
}

runTest()
  .then(() => {
    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("FATAL:", e);
    try {
      const logs = await client.editorReadText("get_log_messages", { severity: "error", limit: 30 });
      console.error("RECENT ERRORS:", JSON.stringify(logs));
    } catch {}
    await teardown(client);
    process.exit(2);
  });
