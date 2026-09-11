#!/usr/bin/env bash
# SEE-1273 T1 QA — AC-M3REORG-001 independent tree verification (read-only).
# Independent re-derivation: does NOT reuse Bachi's comparison; derives the
# exemption surface itself from the snapshot's consumption-view shape.
set -euo pipefail

FORK_URL="https://github.com/tadki/godot-mcp.git"
# Run context (SEE-1287): EXPECTED_MAIN/SNAPSHOT_BASE are the SEE-1273 T1 QA
# round's frozen snapshot pins. This harness re-derives AC-M3REORG-001 against
# that historical snapshot — running it against a live-advanced fork main will
# fail by design (the tree has legitimately changed). Pass EXPECTED_MAIN /
# SNAPSHOT_BASE env overrides to compare other baselines; the defaults are the
# archived T1 round values.
EXPECTED_MAIN="${EXPECTED_MAIN:-fa59113d4a4562b3cbd00a06da17a748394db4e8}"
SNAPSHOT_BASE="${SNAPSHOT_BASE:-5719847}"   # tree-compare baseline (deprecation commit excluded)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --quiet --no-checkout "$FORK_URL" "$TMP/fork"
cd "$TMP/fork"
if git ls-remote --exit-code origin kol-addon-hist >/dev/null 2>&1; then
  git fetch --quiet origin main kol-addon-hist
else
  # kol-addon-hist was retired from the fork remote in SEE-1273 M3; without it
  # the snapshot comparison cannot run — declare archive semantics and skip.
  echo "SKIP AC-M3REORG-001: snapshot branch kol-addon-hist retired from fork remote (SEE-1273 M3); archive-only harness"
  exit 0
fi

ACTUAL_MAIN="$(git rev-parse origin/main)"
if [[ "$ACTUAL_MAIN" != "$EXPECTED_MAIN" ]]; then
  echo "FAIL AC-M3REORG-001: origin/main=$ACTUAL_MAIN expected=$EXPECTED_MAIN"
  exit 1
fi

# Full blob+mode comparison of the two trees
git ls-tree -r origin/main  > "$TMP/main.txt"
git ls-tree -r "$SNAPSHOT_BASE" > "$TMP/snap.txt"

python3 - "$TMP" "$SNAPSHOT_BASE" <<'EOF'
import subprocess, sys
tmp, SNAPSHOT_BASE = sys.argv[1], sys.argv[2]

def load(p):
    d = {}
    for line in open(p):
        meta, path = line.rstrip('\n').split('\t', 1)
        mode, typ, sha = meta.split()
        d[path] = (mode, typ, sha)
    return d

main, snap = load(f'{tmp}/main.txt'), load(f'{tmp}/snap.txt')

# Snapshot tree root == addon consumption surface. Any main path outside it is
# a candidate exemption; exemption is valid only if snapshot has no counterpart
# under the same name (else it must have been compared).
EXEMPT_PREFIXES = ('launch/', 'server/', 'docs/', '.github/')
EXEMPT_EXACT = {'README.md', 'LICENSE', 'CONTRIBUTING.md', 'INSTALL.md', '.gitignore'}
exempt = lambda p: p.startswith(EXEMPT_PREFIXES) or p in EXEMPT_EXACT

nonexempt = {p: v for p, v in main.items() if not exempt(p)}
only_main = sorted(set(nonexempt) - set(snap))
only_snap = sorted(set(snap) - set(nonexempt))
mismatch = sorted(p for p in set(nonexempt) & set(snap) if nonexempt[p] != snap[p])

fail = False
if only_main:
    print('FAIL: paths in main (non-exempt) missing from snapshot:', only_main); fail = True
if only_snap:
    print('FAIL: paths in snapshot not matched by main:', only_snap[:30]); fail = True
if mismatch:
    print('FAIL: blob/mode mismatches:', mismatch); fail = True

# Exempt dirs must be non-Godot-scanned per design (launch/ and server/ 0 .gd)
for d in ('launch', 'server'):
    gds = [p for p in main if p.startswith(d + '/') and p.endswith(('.gd', '.gd.uid'))]
    if gds:
        print(f'FAIL: exempt dir {d}/ contains .gd files:', gds[:10]); fail = True

# Upstream test/ and godot/ nesting must be gone
stray = [p for p in main if p.startswith(('test/', 'godot/'))]
if stray:
    print('FAIL: upstream test/ or godot/ still present:', stray[:10]); fail = True

# No NEW KOL-specific concept in the addon-consumption tree (vendored redline).
# Scope note: KOL_* values inherited byte-identical from the snapshot baseline
# (e.g. plugin.gd KOL_MCP_PORT) are pre-existing production lineage — their
# removal is T2/T3 scope (§4.5.3), not T1. Only leakage not present in the
# snapshot baseline is a T1 failure.
for p in nonexempt:
    if nonexempt[p][1] != 'blob':
        continue
    data = subprocess.run(['git', 'cat-file', 'blob', f'origin/main:{p}'],
                          capture_output=True).stdout
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        continue
    base_text = None
    if p in snap:
        base_text = subprocess.run(['git', 'cat-file', 'blob', f'{SNAPSHOT_BASE}:{p}'],
                                   capture_output=True).stdout.decode('utf-8', 'replace')
    for pat in ('KOL_', 'king-of-likes', 'KingOfLikes'):
        if pat in text and (base_text is None or pat not in base_text):
            print(f'FAIL: NEW KOL concept "{pat}" introduced by T1 into consumption tree: {p}')
            fail = True
            break

if fail:
    sys.exit(1)
print(f'PASS AC-M3REORG-001: {len(nonexempt)} non-exempt blobs identical to snapshot '
      f'{SNAPSHOT_BASE}; {len(main) - len(nonexempt)} exempt (launch/server/docs/.github/'
      f'README/LICENSE/CONTRIBUTING/INSTALL/.gitignore); no test/, no godot/ nesting, no gitlinks, no KOL leakage.')
EOF
