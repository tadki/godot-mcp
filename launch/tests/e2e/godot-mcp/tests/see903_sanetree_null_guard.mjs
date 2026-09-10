// SEE-903 regression test for SaneTree._fit_camera_to_all null guard.
// Verifies that the method does not crash when SaneTree is not mounted under a ZoomableCanvas.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";

const client = new GodotMcpClient();

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

async function main() {
  await client.connect();

  console.log("\n=== setup: run UIFramework ===");
  await client.editor("run", { frozen: true, scene_path: "res://scenes/ui/ui_framework.tscn" });
  await client.gameStep(15);

  console.log("\n=== test: _fit_camera_to_all with null _zoomable_canvas ===");
  // Do all assertions in GDScript and return a single primitive bool.
  const ok = await client.exec(`
    var sane = SaneTree.new()
    sane.name = "NullGuardSaneTree"
    tree.root.add_child(sane)

    # Force _setup_canvas() to create a local canvas because parent is not a ZoomableCanvas.
    sane._setup_canvas()

    var zoomable_null := sane._zoomable_canvas == null
    if not zoomable_null:
      return false

    # Populate a couple of fake node visuals so _fit_camera_to_all has bounds to compute.
    var node_a = preload("res://scenes/ui/sane/sane_node.tscn").instantiate()
    node_a.size = Vector2(100, 100)
    node_a.position = Vector2(0, 0)
    sane._canvas.add_child(node_a)

    var node_b = preload("res://scenes/ui/sane/sane_node.tscn").instantiate()
    node_b.size = Vector2(100, 100)
    node_b.position = Vector2(500, 500)
    sane._canvas.add_child(node_b)

    sane._node_visuals["a"] = node_a
    sane._node_visuals["b"] = node_b

    if sane._node_visuals.size() != 2:
      return false

    var before_pos: Vector2 = sane._canvas.position

    # This was the crash site before the null guard. It must return without error.
    sane._fit_camera_to_all()

    if sane._canvas.position == before_pos:
      return false

    return true
  `);

  console.log("  GDScript null-guard result:", ok);
  assert(ok === true, "_fit_camera_to_all tolerates null _zoomable_canvas without crashing");

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
