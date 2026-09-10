// SEE-1080 QA — REAL-EDITOR visual probe for the two STATIC visual items Atlas
// demands: (B1) InfiPostVisual header 2x2 button layout, (B5-visual) pinned
// blue-border distinction. Runs on the interactive Windows editor (real GPU),
// NOT headless. Also re-confirms Track-A #1 click->drag entry for a fresh
// screenshot. The drag mid-flow (rotate/hover/confirm/rollback) and
// DragProxy-follow feel are NOT drivable here — synthetic input cannot reach
// autoload _input / drive GUI hover in the embedded editor (see931, documented
// across SEE-918/926/1028 + this session). Those remain GUT-covered only.
import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";
import fs from "node:fs";

const client = new GodotMcpClient();
const UF = "/root/UIFramework";
const SHOT = new URL("./screenshots/see1080/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });

const execJSON = (src) => client.exec(src);

async function snap(name, maxW = 1100) {
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

async function enterMainGame() {
  await client.exec(`GameState.mcp_reset_player_state()`);
  await client.exec(`ProfileManager.create_profile("RevySEE1080Vis")`);
  await client.exec(`EconomyManager.deserialize({"like_total":0.0,"lcps":0.0,"like_time_scale":1.0,"like_success_rate":1.0,"epd":0.0,"tp":0.0,"last_active_timestamp":0.0})`);
  await client.exec(`var s = tree.current_scene; var b = s.find_child("*NewGame*", true, false); if b is Button: b.pressed.emit()`);
  await client.gameStep(2); await client.gameThaw(); await client.gameStep(20);
  await client.exec(`var s = tree.current_scene; var ne = s.find_child("*NameEdit*", true, false); var b = s.find_child("*Start*", true, false); if ne != null: ne.text = "RevySEE1080Vis"; ne.text_changed.emit("RevySEE1080Vis"); if b is Button: b.pressed.emit()`);
  await client.gameFreeze(); await client.gameStep(40);
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

  let sceneOk = false;
  await suite("A_setup", async () => {
    sceneOk = await execJSON(`return tree.current_scene != null and String(tree.current_scene.name) == "UIFramework"`);
    harness.record("reached UIFramework game scene", sceneOk === true, `scene=${sceneOk}`);
    await snap("v00_gameplay_fresh");
  });
  if (sceneOk !== true) throw new Error("did not reach UIFramework");

  // ---- B1 + B5-visual: instantiate a REAL InfiPostVisual on the live scene,
  // drive its PUBLIC setup()/set_pinned() API (the same calls the real render
  // path infi_visual.gd:363-371 makes), and read back the computed layout +
  // panel stylebox. This is pure visual verification — no input dispatch.
  await suite("C_infi_post_visual_layout_and_pinned_border", async () => {
    const made = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var data = InfiPostData.new()
data.infi_id = 5001
data.sender_name = "QA Probe"
data.post_source = "SEE-1080"
data.topic = "Header & Pin"
data.content_text = "real-machine pinned blue-border + 2x2 header check"
data.post_time = 1000.0
var card = preload("res://scenes/ui/infi/infi_post_visual.tscn").instantiate()
uf.add_child(card)
card.set_position(Vector2(180, 110))
card.size = Vector2(380, 280)
card.setup(data, false, false)
return {"added": true, "card_path": String(card.get_path())}
`);
    harness.record("instantiated InfiPostVisual on live scene", made?.added === true, JSON.stringify(made));
    await client.gameStep(3);

    const layout = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var cards = uf.find_children("InfiPostVisual", "", true, false)
var card = cards[0] if cards.size() > 0 else null
if card == null: return {"found": false}
var top = card.get_node("VBoxContainer/HeaderRow/ButtonArea/HeaderBtnTop")
var bot = card.get_node("VBoxContainer/HeaderRow/ButtonArea/HeaderBtnBottom")
var hide = card.get_node_or_null("VBoxContainer/HeaderRow/ButtonArea/HideButton")
var out := {"found": true, "hide_visible": false, "top": [], "bottom": []}
if hide != null: out.hide_visible = bool(hide.visible)
for c in top.get_children():
  if c is Button:
    var r = c.get_global_rect()
    out.top.append({"name": String(c.name), "text": String(c.text), "vis": bool(c.visible), "x": int(r.position.x), "y": int(r.position.y), "w": int(r.size.x), "h": int(r.size.y)})
for c in bot.get_children():
  if c is Button:
    var r = c.get_global_rect()
    out.bottom.append({"name": String(c.name), "text": String(c.text), "vis": bool(c.visible), "x": int(r.position.x), "y": int(r.position.y), "w": int(r.size.x), "h": int(r.size.y)})
return out
`);
    harness.record("InfiPostVisual header found in tree", layout?.found === true, JSON.stringify(layout));

    // B1: 2x2 = top row (Pin+Dismiss) + bottom row (Bookmark+Share), 2 distinct
    // x-positions per row, bottom row at a greater y than top row.
    const top = layout?.top || [], bottom = layout?.bottom || [];
    const topVisible = top.filter((b) => b.vis);
    const botVisible = bottom.filter((b) => b.vis);
    const twoRows = topVisible.length >= 2 && botVisible.length >= 2;
    const topNames = topVisible.map((b) => b.name).sort().join(",");
    const botNames = botVisible.map((b) => b.name).sort().join(",");
    const xSpanTop = topVisible.length >= 2 ? Math.abs(topVisible[0].x - topVisible[1].x) : 0;
    const yRowGap = topVisible.length >= 2 && botVisible.length >= 2 ? Math.abs(botVisible[0].y - topVisible[0].y) : 0;
    harness.record("B1 header renders 2x2 (Pin+Dismiss / Bookmark+Share)", twoRows && xSpanTop > 0 && yRowGap > 0, `top=[${topNames}] bot=[${botNames}] xSpanTop=${xSpanTop} yRowGap=${yRowGap}`);

    // B5-visual: border color unpinned (default beige) vs pinned (blue).
    const unpinned = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var card = uf.find_children("InfiPostVisual", "", true, false)[0]
var sb = card.get_theme_stylebox("panel") as StyleBoxFlat
if sb == null: return {"has": false}
return {"has": true, "r": float(sb.border_color.r), "g": float(sb.border_color.g), "b": float(sb.border_color.b), "bw": int(sb.border_width_bottom)}
`);
    harness.record("B5 unpinned border = default beige", unpinned?.has === true, `border=(${unpinned?.r?.toFixed(2)},${unpinned?.g?.toFixed(2)},${unpinned?.b?.toFixed(2)}) bw=${unpinned?.bw}`);

    const pinned = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var card = uf.find_children("InfiPostVisual", "", true, false)[0]
card.set_pinned(true)
var sb = card.get_theme_stylebox("panel") as StyleBoxFlat
if sb == null: return {"has": false, "pin_text": String(card.get_node("%PinButton").text)}
var pb = card.get_node("%PinButton")
return {"has": true, "r": float(sb.border_color.r), "g": float(sb.border_color.g), "b": float(sb.border_color.b), "bw": int(sb.border_width_bottom), "pin_text": String(pb.text)}
`);
    // Blue target ~ Color(0.20,0.45,0.85), width 3.
    const isBlue = pinned?.has === true && pinned.r < 0.35 && pinned.g > 0.3 && pinned.g < 0.6 && pinned.b > 0.7;
    harness.record("B5 pinned border = blue accent width 3", isBlue === true && pinned?.bw === 3, `border=(${pinned?.r?.toFixed(2)},${pinned?.g?.toFixed(2)},${pinned?.b?.toFixed(2)}) bw=${pinned?.bw} pinBtn="${pinned?.pin_text}"`);
    const contrast = unpinned?.has === true && pinned?.has === true && (Math.abs(unpinned.b - pinned.b) > 0.3);
    harness.record("B5 pinned visually distinct from unpinned (blue vs beige)", contrast === true, `unpinned.b=${unpinned?.b?.toFixed(2)} pinned.b=${pinned?.b?.toFixed(2)}`);
    await snap("v20_infi_post_pinned_blue");
  });

  // ---- Track A #1 refresh: real click on an inventory item starts a drag and
  // spawns the DragProxy visual. (Mid-flow rotate/hover/confirm = see931 limit.)
  await suite("A_click_starts_drag_refresh", async () => {
    await client.exec(`EventBus.emit_signal("panel_requested", PanelZoneManager.UIPanel.INVENTORY_VISUAL, EventBus.PanelAction.TOGGLE)`); await client.gameStep(15);
    const t = await execJSON(`
var uf = tree.root.get_node_or_null("${UF}")
var iv = uf.find_child("InventoryVisual", true, false)
var info := {"item_center": null}
if iv != null:
  var iitem = iv.find_child("Item_*", true, false)
  if iitem != null:
    var r = iitem.get_global_rect()
    info.item_center = {"x": r.position.x + r.size.x*0.5, "y": r.position.y + r.size.y*0.5}
return info
`);
    if (!t?.item_center) { harness.record("real click started drag (#1 entry)", false, "no item target"); return; }
    await client.exec(`
var uf = tree.root.get_node_or_null("${UF}")
var ev = InputEventMouseMotion.new(); ev.position = Vector2(${t.item_center.x}, ${t.item_center.y}); ev.global_position = Vector2(${t.item_center.x}, ${t.item_center.y}); uf.get_viewport().push_input(ev, true)
`);
    await client.gameStep(3);
    await client.exec(`
var uf = tree.root.get_node_or_null("${UF}")
var ev = InputEventMouseButton.new(); ev.button_index = MOUSE_BUTTON_LEFT; ev.pressed = true; ev.position = Vector2(${t.item_center.x}, ${t.item_center.y}); ev.global_position = Vector2(${t.item_center.x}, ${t.item_center.y}); uf.get_viewport().push_input(ev, true)
`);
    await client.gameStep(5);
    const ds = await execJSON(`return {"dragging": DragManager.is_dragging, "item": String(DragManager.dragged_item_id), "is_proxy": is_instance_valid(DragManager._proxy)}`);
    harness.record("real click started DragManager drag (#1 entry)", ds?.dragging === true && !!ds?.item, JSON.stringify(ds));
    await snap("v30_drag_entry_proxy");
    await client.exec(`if DragManager.is_dragging: DragManager.cancel_drag()`);
    await client.gameStep(3);
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
