// SEE-903 A/B test: compare SANE open behavior with and without an activated home node.
// Before the fix both scenarios were broken: the no-activation case clamped to zoom 0.3
// because `mini` truncated the fit-to-all ratio, and the activation case was mis-centered
// because SaneTree used its own zero size as the viewport.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const client = new GodotMcpClient();
// Anchor to this script's location, not cwd, to prevent self-nesting screenshot dirs.
const SCREENSHOT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "screenshots", "see903");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BTN_SANE = "/root/UIFramework/MainHBox/LeftPanel/BottomBar/BottomBarMargin/BottomBarHBox/SANEBox/ButtonSANE";
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

async function setup() {
  await client.connect();
  await client.editor("run", { frozen: true, scene_path: "res://scenes/ui/ui_framework.tscn" });
  await client.gameStep(15);
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE903AB")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
}

async function openSane() {
  await client.exec(`var btn = tree.root.get_node_or_null("${BTN_SANE}"); if btn != null: btn.pressed.emit()`);
  await client.gameStep(20);
}

async function closeSane() {
  await client.exec(`var btn = tree.root.get_node_or_null("${BTN_SANE}"); if btn != null: btn.pressed.emit()`);
  await client.gameStep(10);
}

async function readSaneState() {
  return await client.exec(`
    var sane = tree.root.get_node_or_null("${SANE_TREE}")
    var canvas = tree.root.get_node_or_null("${SANE_ZOOM_CANVAS}")
    return {
      "visible": sane.visible if sane != null else false,
      "node_count": sane._node_visuals.size() if sane != null else 0,
      "link_count": sane._link_visuals.size() if sane != null else 0,
      "zoom": canvas.get_zoom() if canvas != null else 0,
    }
  `);
}

async function main() {
  await setup();

  console.log("\n=== A: no activated nodes (fit-to-all fallback) ===");
  // Make sure no nodes are activated.
  await client.exec(`SaneSubsystem.deserialize({"home_node_id":"","available_sp":0,"activated_nodes":[]})`);
  await openSane();
  let stateA = await readSaneState();
  console.log("  state A:", JSON.stringify(stateA));
  assert(stateA.visible === true, "SANE opens in scenario A");
  assert(stateA.zoom < 0.3, `fit-to-all zoom is computed below the old 0.3 clamp (got ${stateA.zoom})`);
  assert(stateA.zoom >= 0.1, `fit-to-all zoom respects new MIN_ZOOM 0.1 (got ${stateA.zoom})`);
  saveScreenshot("ab_A_no_activation", await client.editorRead("screenshot_game", { max_width: 1280 }));
  await closeSane();

  console.log("\n=== B: home node activated (normal gameplay) ===");
  await client.exec(`
    var canvas = tree.root.get_node_or_null("${SANE_ZOOM_CANVAS}")
    if canvas != null:
      canvas.reset_view()
    var first = SaneSubsystem.get_all_node_ids()[0]
    SaneSubsystem.set_home_node(first)
  `);
  await openSane();
  let stateB = await readSaneState();
  console.log("  state B:", JSON.stringify(stateB));
  assert(stateB.visible === true, "SANE opens in scenario B");
  assert(stateB.zoom >= 0.9 && stateB.zoom <= 1.1, `SANE centers on home node at zoom ~1.0 (got ${stateB.zoom})`);
  saveScreenshot("ab_B_home_activated", await client.editorRead("screenshot_game", { max_width: 1280 }));
  await closeSane();

  await client.gameThaw();
  await client.editor("stop");
  await client.close();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    const logs = await client.editorReadText("get_log_messages", { severity: "error", limit: 30 });
    console.error("RECENT ERRORS:", JSON.stringify(logs));
  } catch {}
  await teardown(client);
  process.exit(2);
});
