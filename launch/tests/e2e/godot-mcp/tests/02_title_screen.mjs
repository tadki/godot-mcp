// Tests the title screen scene: buttons exist, input actions, and basic navigation.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

const TITLE_ROOT = "/root/TitleScreen/BackgroundPanel/CenterContainer/ContentPanel/MarginContainer/VBoxContainer";

async function nodeVisible(nodePath) {
  try {
    const props = await client.nodeReadText("get_properties", { node_path: nodePath });
    return props?.visible === true;
  } catch {
    return false;
  }
}

try {
  await client.connect();
  harness.start("02_title_screen");

  // Ensure we're on the title screen
  const state = await client.editorReadText("get_state");
  harness.record("current scene is title_screen", state.current_scene?.includes("title_screen"), state.current_scene);

  // Verify the scene tree contains expected title UI nodes
  const tree = await client.nodeReadText("get_scene_tree", { max_depth: 5, max_children: 30 });
  const allNames = collectNames(tree);
  harness.record("title screen has TitleLabel", allNames.includes("TitleLabel"), `found ${allNames.filter(n => n.toLowerCase().includes("title")).join(",")}`);
  harness.record("title screen has start/new game button", allNames.some(n => /newgame|start/i.test(n)), `buttons=${allNames.filter(n => /button/i.test(n)).join(",")}`);

  // Frontend visibility: title and buttons are rendered
  const titleVisible = await nodeVisible(`${TITLE_ROOT}/TitleLabel`);
  harness.record("TitleLabel is visible", titleVisible);

  const newGameVisible = await nodeVisible(`${TITLE_ROOT}/ButtonVBox/ButtonNewGame`);
  harness.record("NewGame button is visible", newGameVisible);

  const loadSaveProps = await client.nodeReadText("get_properties", { node_path: `${TITLE_ROOT}/ButtonVBox/ButtonLoadSave` }).catch(() => ({}));
  harness.record("LoadSave button visibility matches render state", loadSaveProps?.visible === true, `visible=${loadSaveProps?.visible} disabled=${loadSaveProps?.disabled} text=${loadSaveProps?.text}`);

  // Input map sanity. Built-in ui_* actions aren't returned by get_map; just assert it responds.
  const inputMapText = await client.callText("godot_input", { action: "get_map" });
  const mapOk = typeof inputMapText === "string" && inputMapText.length > 0 && !inputMapText.startsWith("Error:");
  harness.record("input map readable", mapOk, inputMapText.slice(0, 120));

  harness.finishSuite();
  await client.close();
  harness.printSummary();
  process.exit(harness.exitCode());
} catch (e) {
  console.error("FATAL:", e);
  await teardown(client);
  process.exit(2);
}

function collectNames(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.name) out.push(node.name);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectNames(child, out);
  }
  return out;
}
