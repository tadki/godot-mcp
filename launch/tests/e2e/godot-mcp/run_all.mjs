// Orchestrator: runs every godot-mcp E2E test sequentially.
// Each test owns its own MCP client and tears down (thaw + stop) the game before exit.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, "tests");

// Preflight: the suite imports @modelcontextprotocol/sdk. If node_modules is
// missing (fresh checkout, cleared by .gitignore), auto-restore from the
// version-controlled package-lock.json via `npm ci`. If that fails, surface a
// clear dependency error instead of letting every test fail with obscure
// module-not-found stack traces.
const sdkMarker = join(__dirname, "node_modules/@modelcontextprotocol/sdk/package.json");
if (!existsSync(sdkMarker)) {
  console.log("[preflight] node_modules/@modelcontextprotocol/sdk missing — running `npm ci` …");
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const ci = spawnSync(npmBin, ["ci", "--no-audit", "--no-fund"], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (ci.status !== 0) {
    console.error(`\n[preflight] ERROR: \`npm ci\` failed (exit ${ci.status}).`);
    console.error("[preflight] Restore deps manually in .dev/godot-mcp/tests/e2e/godot-mcp/:");
    console.error("[preflight]   npm install");
    console.error("[preflight] Required dependency: @modelcontextprotocol/sdk (see package.json).");
    process.exit(1);
  }
  if (!existsSync(sdkMarker)) {
    console.error("\n[preflight] ERROR: `npm ci` completed but @modelcontextprotocol/sdk still missing.");
    console.error("[preflight] Check package.json / package-lock.json integrity.");
    process.exit(1);
  }
  console.log("[preflight] dependencies restored.\n");
}

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".mjs"))
  .sort();

console.log(`\n# KingOfLikes godot-mcp E2E Suite — ${files.length} tests\n`);

const results = [];
for (const f of files) {
  console.log(`\n>>> Running ${f}`);
  const r = await runOnce(join(testsDir, f));
  results.push({ name: f, ...r });
  console.log(`<<< ${f} exit=${r.code}`);
  // Give npx/godot-mcp a moment to fully disconnect between tests
  await sleep(2000);
}

const pass = results.filter((r) => r.code === 0).length;
const fail = results.filter((r) => r.code !== 0).length;
console.log(`\n========== ORCHESTRATOR SUMMARY ==========`);
console.log(`PASS: ${pass}/${results.length}`);
console.log(`FAIL: ${fail}/${results.length}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? "OK" : "FAIL"} ${r.name}`);
}
console.log(`==========================================\n`);

process.exit(fail === 0 ? 0 : 1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runOnce(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { stdio: "inherit" });
    p.on("exit", (code) => resolve({ code }));
    p.on("error", (e) => resolve({ code: 127, err: String(e) }));
  });
}
