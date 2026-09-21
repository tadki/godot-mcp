import { rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

// §4.5 T1: the addon body moved to the repo ROOT (no godot/ tree). Previously
// this copied `../godot/addons/godot_mcp` wholesale (minus its dev test/).
// Now the addon's source is a fixed set of top-level dirs/files at the repo
// root, so we copy each of those explicitly — the root also holds `server/`
// (which is where this destination lives) and other non-addon trees that must
// not be copied into the published addon.
const ADDON_PARTS = [
  'command_router.gd', 'command_router.gd.uid',
  'commands', 'core', 'game_bridge', 'ui',
  'lease_controller.gd', 'plugin.cfg', 'plugin.gd', 'plugin.gd.uid',
  'websocket_server.gd', 'websocket_server.gd.uid',
];

const srcBase = resolve(process.cwd(), '..');
const dest = resolve(process.cwd(), 'addon');

// SEE-1328 D-fix: the git-tracked .gdignore lives INSIDE dest, so the wipe
// below would delete it on every build. Preserve it across rmSync and write
// it back — the Godot scan-skip contract must survive npm run build.
const GDI = resolve(dest, '.gdignore');
const gdignoreBackup = existsSync(GDI) ? readFileSync(GDI) : null;

rmSync(dest, { recursive: true, force: true });
for (const part of ADDON_PARTS) {
  const s = resolve(srcBase, part);
  cpSync(s, resolve(dest, part), {
    recursive: true,
    filter: (source) => {
      const rel = relative(s, source);
      return rel === '' || rel.split(sep)[0] !== 'test';
    },
  });
}
if (gdignoreBackup !== null) {
  writeFileSync(GDI, gdignoreBackup);
}
console.log(`addon copied: ${srcBase} (${ADDON_PARTS.length} parts) → ${dest}${gdignoreBackup ? ' (.gdignore preserved)' : ''}`);
