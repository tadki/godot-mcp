// SEE-1080 QA — real GUI editor E2E (Revy). Drives the interactive Windows
// editor (NOT headless) through the godot-mcp bridge.
//
// HONEST SCOPE: the embedded editor's synthetic-input path delivers mouse
// presses to GUI _gui_input (so a real click on an inventory item DOES start a
// DragManager drag — verified across 4 runs), but it does NOT reach autoload
// _input handlers. DragManager._input owns R-rotate + the confirm click, and
// DragManager._process owns hover resolution — none drivable from the harness.
// That is the documented embedded-editor synthetic-input limitation (see931),
// NOT a SEE-1080 defect. Those mid-drag branches are proven at the data layer
// by the GUT suite (1029/1029: test_see1080_drag_lifecycle_qa,
// test_see1080_infi_pin_compaction_qa, test_see1080_two_reflections_shape_qa).
//
// This GUI run therefore proves what ONLY the real editor can: rendering on the
// real GPU (D3D12), panel layout, runtime seeding, the click->drag-entry
// pipeline, and the live Infi pin contract on the runtime service instance.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SHOT = new URL("./screenshots/see1080/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });

async function snap(name, maxW = 1000) {
  try {
    const s = await client.editorRead("screenshot_game", { max_width: maxW });
    const img = s?.content?.find((c) => c.type === "image")?.data;
    const buf = img ? Buffer.from(img, "base64") : null;
    const ok = buf != null && buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (ok) fs.writeFileSync(`${SHOT}/${name}.png`, buf);
    harness.record(`screenshot ${name}`, ok, `bytes=${buf?.length ?? 0}`);
    return ok;
  } catch (e) { harness.record(`screenshot ${name}`, false, String(e).slice(0, 120)); return false; }
}
const execJSON = (src) => client.exec(src);
const limit = (msg) => console.log(`  [HARNESS-LIMIT] ${msg}`);

// Mouse motion + click -> uf.get_viewport() with local_coords=true. This is the
// exact combination proven (4/4 runs) to reach GUI _gui_input and start a drag.
async function moveMouse(pos) {
  return client.exec(`
var uf = tree.root.get_node_or_null("${UF}")
var ev = InputEventMouseMotion.new()
ev.position = Vector2(${pos.x}, ${pos.y}); ev.global_position = Vector2(${pos.x}, ${pos.y})
uf.get_viewport().push_input(ev, true)
return true
`);
}
async function clickAt(pos) {
  return client.exec(`
var uf = tree.root.get_node_or_null("${UF}")
var ev = InputEventMouseButton.new()
ev.button_index = MOUSE_BUTTON_LEFT; ev.pressed = true
ev.position = Vector2(${pos.x}, ${pos.y}); ev.global_position = Vector2(${pos.x}, ${pos.y})
uf.get_viewport().push_input(ev, true)
return true
`);
}

const findChild = (root, name) => execJSON(`var n = tree.root.get_node_or_null("${root}"); return n.find_child("${name}", true, false) != null`);

async function enterMainGame() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE1080")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
  await client.exec(`var s = tree.current_scene; var b = s.find_child("*NewGame*", true, false); if b is Button: b.pressed.emit()`);
  await client.gameStep(2); await client.gameThaw(); await client.gameStep(20);
  await client.exec(`var s = tree.current_scene; var ne = s.find_child("*NameEdit*", true, false); var b = s.find_child("*Start*", true, false); if ne != null: ne.text = "RevySEE1080"; ne.text_changed.emit("RevySEE1080"); if b is Button: b.pressed.emit()`);
  await client.gameFreeze(); await client.gameStep(40);
}
async function togglePanel(panelEnum) {
  await client.exec(`EventBus.emit_signal("panel_requested", ${panelEnum}, EventBus.PanelAction.TOGGLE)`);
  await client.gameStep(20);
}
async function suite(name, fn) {
  harness.start(name);
  try { await fn(); } catch (e) { harness.record(`${name} exception`, false, String(e).slice(0, 200)); }
  harness.finishSuite();
}

try {
  await client.connect();
  await client.editor("run", { frozen: true });
  await client.gameStep(5);
  await enterMainGame();

  const sceneOk = await execJSON(`return tree.current_scene != null and String(tree.current_scene.name) == "UIFramework"`);
  await suite("A_setup", async () => {
    harness.record("reached UIFramework game scene", sceneOk === true, `scene=${sceneOk}`);
    await snap("00_gameplay");
  });
  if (sceneOk !== true) throw new Error("did not reach UIFramework");

  await suite("A_panels_render", async () => {
    await togglePanel("PanelZoneManager.UIPanel.INVENTORY_VISUAL");
    await togglePanel("PanelZoneManager.UIPanel.CYBER_DOMAIN_VISUAL");
    harness.record("InventoryVisual present", await findChild(UF, "InventoryVisual") === true);
    harness.record("CyberDomainVisual present", await findChild(UF, "CyberDomainVisual") === true);
    const invRect = await execJSON(`var uf = tree.root.get_node_or_null("${UF}"); var p = uf.find_child("InventoryVisual", true, false); var r = p.get_global_rect(); return {"x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y}`);
    const cdRect = await execJSON(`var uf = tree.root.get_node_or_null("${UF}"); var p = uf.find_child("CyberDomainVisual", true, false); var r = p.get_global_rect(); return {"x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y}`);
    harness.record("Inventory renders real size", (invRect?.w ?? 0) > 50 && (invRect?.h ?? 0) > 50, JSON.stringify(invRect));
    harness.record("CyberDomain renders real size", (cdRect?.w ?? 0) > 50 && (cdRect?.h ?? 0) > 50, JSON.stringify(cdRect));
    await snap("01_inv_cd_panels");
  });

  await suite("A_reflections_seeded", async () => {
    const tpl = await execJSON(`
var f = ReflectionDataFactory.new()
var ts = f.load_all()
var out := {"count": ts.size(), "shapes": []}
for d in ts:
  var cells = []
  for cc in d.occupied_cell: cells.append([cc.x, cc.y])
  out.shapes.append(cells)
return out
`);
    harness.record("two reflection templates load with distinct shapes (#3)", tpl?.count === 2 && Array.isArray(tpl?.shapes) && tpl.shapes.length === 2 && JSON.stringify(tpl.shapes[0]) !== JSON.stringify(tpl.shapes[1]), JSON.stringify(tpl));
    const invCount = await execJSON(`var uf = tree.root.get_node_or_null("${UF}"); var iv = uf.find_child("InventoryVisual", true, false); var c = iv.get_container_data(); return int(c.get_all_items().size())`);
    harness.record("inventory seeded with items at runtime", (invCount ?? 0) >= 2, `items=${invCount}`);
  });

  await suite("A_click_starts_drag", async () => {
    const targets = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var iv = uf.find_child("InventoryVisual", true, false)
var cdv = uf.find_child("CyberDomainVisual", true, false)
var info := {"item_center": null, "dm_visuals": -1, "cd_prio": -1}
if iv != null:
  var iitem = iv.find_child("Item_*", true, false)
  if iitem != null:
    var r = iitem.get_global_rect()
    info.item_center = {"x": r.position.x + r.size.x * 0.5, "y": r.position.y + r.size.y * 0.5}
if cdv != null:
  info.cd_prio = int(cdv.hover_priority) if "hover_priority" in cdv else -1
info.dm_visuals = DragManager._visuals.size() if "_visuals" in DragManager else -1
return info
`);
    harness.record("DragManager wired with registered visuals", (targets?.dm_visuals ?? -1) >= 2 && (targets?.cd_prio ?? -1) >= 0, `visuals=${targets?.dm_visuals} cd_prio=${targets?.cd_prio}`);
    if (!targets?.item_center) { harness.record("real click started DragManager drag (#1 entry)", false, "no item target"); return; }
    await moveMouse(targets.item_center); await client.gameStep(3);
    await clickAt(targets.item_center); await client.gameStep(5);
    const ds = await execJSON(`return {"dragging": DragManager.is_dragging, "item": String(DragManager.dragged_item_id), "is_proxy": is_instance_valid(DragManager._proxy)}`);
    harness.record("real click started DragManager drag (#1 entry)", ds?.dragging === true && !!ds?.item, JSON.stringify(ds));
    await snap("02_dragging");
    // R-rotate / hover / confirm live in DragManager._input / _process, which the
    // embedded editor's synthetic-input path cannot reach (see931). Proven via
    // GUT test_a1/a4/a5/a6/a7 (1029/1029). Not a feature defect.
    limit("R-rotate, hover placement, confirm place/rollback: autoload _input unreachable in embedded editor -> covered by GUT data-layer suite.");
    await client.exec(`if DragManager.is_dragging: DragManager.cancel_drag()`); // sanctioned rollback entry (ESC/focus-loss path)
    await client.gameStep(3);
  });

  await suite("B_infi_panel_and_service", async () => {
    const infiPanel = await execJSON(`var uf = tree.root.get_node_or_null("${UF}"); var p = uf.find_child("InfiReviewQueue*", true, false); return {"found": p != null, "name": String(p.name) if p != null else ""}`);
    harness.record("Infi review-queue panel present in UI", infiPanel?.found === true, JSON.stringify(infiPanel));
    if (!infiPanel?.found) return;
    await snap("10_infi_panel");
    const header = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var p = uf.find_child("${infiPanel.name}", true, false)
var hdr = p.find_child("*Header*", true, false)
var info := {"header": hdr != null, "buttons": 0, "names": []}
var start_node = hdr if hdr != null else p
var stack = [start_node]
while stack.size() > 0:
  var n = stack.pop_back()
  if n is Button:
    info.buttons += 1
    info.names.append(String(n.name))
  for c in n.get_children(): stack.append(c)
return info
`);
    harness.record("Infi header renders with action buttons (#B1)", header?.buttons >= 1, `buttons=${header?.buttons} names=${JSON.stringify(header?.names)}`);
    const svc = await execJSON(`var s = InfiSubsystem.get_service() if InfiSubsystem.has_method("get_service") else null; var arr = []; if s != null: for i in range(3): arr.append(int(s._state.review_slot_ids[i]) if i < s._state.review_slot_ids.size() else -1); return {"has": s != null, "slots": arr}`);
    harness.record("InfiService reachable at runtime", svc?.has === true, JSON.stringify(svc));
    // B5 on the LIVE service instance the UI binds to: ensure a review post,
    // pin it, over-advance its timer, tick, assert it survives (same contract as
    // GUT test_b5, exercised on the runtime object instead of a fresh one).
    const b5 = await execJSON(`
var s = InfiSubsystem.get_service()
if s == null: return {"ran": false}
var idx = -1
for i in range(s._state.review_slot_ids.size()):
  if int(s._state.review_slot_ids[i]) >= 0: idx = i; break
if idx < 0:
  s._state.review_slot_ids[0] = 9001
  s._slot_timers[0] = 0.0
  s._pinned_slots[0] = -1
  idx = 0
var pid = int(s._state.review_slot_ids[idx])
s.set_pinned(idx, true)
var pinned_after = bool(s.is_pinned(pid))
if "_slot_lifetime" in s: s._slot_timers[idx] = float(s._slot_lifetime) + 5.0
s._tick(1.0)
var survives = int(s._state.review_slot_ids[idx]) == pid
return {"ran": true, "idx": idx, "pid": pid, "pinned": pinned_after, "survives_timeout": survives}
`);
    harness.record("pinned slot timer frozen, survives timeout (#B5) on live service", b5?.ran === true && b5?.pinned === true && b5?.survives_timeout === true, JSON.stringify(b5));
    await snap("11_infi_pinned");
  });

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
