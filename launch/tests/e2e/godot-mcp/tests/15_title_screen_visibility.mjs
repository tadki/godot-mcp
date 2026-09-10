// Frontend visibility test: run the title screen and verify key UI nodes are visible,
// then capture a runtime screenshot to confirm the game renders correctly.

import { GodotMcpClient, teardown } from "../mcp_client.mjs";
import { harness } from "../harness.mjs";

const client = new GodotMcpClient();

const TITLE_ROOT = "/root/TitleScreen/BackgroundPanel/CenterContainer/ContentPanel/MarginContainer/VBoxContainer";

try {
  await client.connect();
  harness.start("15_title_screen_visibility");

  await client.editor("run", { frozen: true });
  await client.gameStep(5);

  const runtimeScene = await client.exec(`return {"scene": String(tree.current_scene.name)}`);
  harness.record("game boots to title screen", runtimeScene?.scene === "TitleScreen", JSON.stringify(runtimeScene));

  // Verify frontend visibility of key CanvasItem nodes.
  const titleProps = await client.nodeReadText("get_properties", { node_path: `${TITLE_ROOT}/TitleLabel` }).catch(() => ({}));
  harness.record("TitleLabel visible at runtime", titleProps?.visible === true, `visible=${titleProps?.visible} text=${titleProps?.text}`);

  const newGameProps = await client.nodeReadText("get_properties", { node_path: `${TITLE_ROOT}/ButtonVBox/ButtonNewGame` }).catch(() => ({}));
  harness.record("NewGame button visible and enabled", newGameProps?.visible === true && newGameProps?.disabled === false, `visible=${newGameProps?.visible} disabled=${newGameProps?.disabled}`);

  const subtitleProps = await client.nodeReadText("get_properties", { node_path: `${TITLE_ROOT}/SubtitleLabel` }).catch(() => ({}));
  harness.record("SubtitleLabel visible", subtitleProps?.visible === true, `visible=${subtitleProps?.visible}`);

  // Runtime game screenshot to confirm the title screen renders as a valid PNG.
  const screenshot = await client.editorRead("screenshot_game", { max_width: 640 });
  const imgText = screenshot?.content?.find((c) => c.type === "image")?.data;
  const pngBuffer = imgText ? Buffer.from(imgText, "base64") : null;
  const isPng = pngBuffer != null && pngBuffer.length > 0 && pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50 && pngBuffer[2] === 0x4E && pngBuffer[3] === 0x47;
  harness.record("runtime screenshot is valid PNG", isPng, `bytes=${pngBuffer?.length ?? 0}`);

  await client.gameThaw();
  await client.editor("stop");
  harness.finishSuite();
  await client.close();
  harness.printSummary();
  process.exit(harness.exitCode());
} catch (e) {
  console.error("FATAL:", e);
  await teardown(client);
  process.exit(2);
}
