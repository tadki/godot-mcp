#!/usr/bin/env bash
# SEE-1170 修复轮复测 — resolve_bare_repo 三级推导对抗（通道 1 缺陷 2 修复）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# SEE-1291 H2: repo-checkout.sh is a KOL-repo hook, not a fork asset. Resolve
# via KOL_ROOT (explicit env, else the enclosing superproject when this is a
# submodule checkout); hard-fail with guidance when unavailable.
KOL_ROOT="${KOL_ROOT:-$(git -C "$REPO_ROOT" rev-parse --show-superproject-working-tree 2>/dev/null || true)}"
KOL_ROOT="${KOL_ROOT:-$REPO_ROOT}"
HOOK="$KOL_ROOT/.claude/hooks/repo-checkout.sh"

TMP="$(mktemp -d /tmp/see1170-fix2.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1 (got=$2)" || bad "$1 (want=$3 got=$2)"; }

extract_fn() {
  sed -n '/^resolve_bare_repo()/,/^bare_registration_exists()/p' "$HOOK" | sed '$d'
}

# fixture: a non-standard bare root layout
NS_ROOT="$TMP/custom/repos-root"
WS_ID="wsfix-$$"
SLUG="example.com+test+KingOfLikes-Godot.git"
mkdir -p "$NS_ROOT/$WS_ID/$SLUG"
git init --bare -q "$NS_ROOT/$WS_ID/$SLUG"

# hook run PWD: simulate a workdir under a custom ancestor of .repos
WORKDIR="$TMP/custom/wsroot/$WS_ID/aaaa1111/workdir"
mkdir -p "$WORKDIR"

resolve() {
  (
    cd "$1"
    export MULTICA_WORKSPACE_ID="$WS_ID"
    unset MULTICA_BARE_REPOS_ROOT
    eval "$(extract_fn)"
    resolve_bare_repo "https://example.com/test/KingOfLikes-Godot.git"
  )
}

# ===== T1: Tier 2 upward walk — .repos ancestor above PWD =====
# place .repos as sibling-ancestor: $TMP/custom/wsroot/.repos/<ws_id>/...
mkdir -p "$TMP/custom/wsroot/.repos/$WS_ID/$SLUG"
git init --bare -q "$TMP/custom/wsroot/.repos/$WS_ID/$SLUG"
GOT=$(resolve "$WORKDIR")
assert_eq "T1 tier2 walk-up finds .repos ancestor" "$GOT" "$TMP/custom/wsroot/.repos/$WS_ID/$SLUG"

# ===== T2: Tier 1 env override wins over tier 2 =====
GOT=$(
  (
    cd "$WORKDIR"
    export MULTICA_WORKSPACE_ID="$WS_ID"
    export MULTICA_BARE_REPOS_ROOT="$NS_ROOT"
    eval "$(extract_fn)"
    resolve_bare_repo "https://example.com/test/KingOfLikes-Godot.git"
  )
)
assert_eq "T2 tier1 env override" "$GOT" "$NS_ROOT/$WS_ID/$SLUG"

# ===== T3: env pointing at nonexistent path falls through to tier 2 =====
GOT=$(
  (
    cd "$WORKDIR"
    export MULTICA_WORKSPACE_ID="$WS_ID"
    export MULTICA_BARE_REPOS_ROOT="$TMP/does-not-exist"
    eval "$(extract_fn)"
    resolve_bare_repo "https://example.com/test/KingOfLikes-Godot.git"
  )
)
assert_eq "T3 bad env falls to tier2 walk" "$GOT" "$TMP/custom/wsroot/.repos/$WS_ID/$SLUG"

# ===== T4: empty-string env treated as unset (tier 2) =====
GOT=$(
  (
    cd "$WORKDIR"
    export MULTICA_WORKSPACE_ID="$WS_ID"
    export MULTICA_BARE_REPOS_ROOT=""
    eval "$(extract_fn)"
    resolve_bare_repo "https://example.com/test/KingOfLikes-Godot.git"
  )
)
assert_eq "T4 empty env string falls to tier2" "$GOT" "$TMP/custom/wsroot/.repos/$WS_ID/$SLUG"

# ===== T5: multiple .repos ancestors — nearest wins (walk starts at PWD upward) =====
mkdir -p "$TMP/custom/wsroot/$WS_ID/inner/.repos/$WS_ID/$SLUG"
git init --bare -q "$TMP/custom/wsroot/$WS_ID/inner/.repos/$WS_ID/$SLUG"
DEEP_WD="$TMP/custom/wsroot/$WS_ID/inner/aaaa2222/workdir"
mkdir -p "$DEEP_WD"
GOT=$(resolve "$DEEP_WD")
assert_eq "T5 nearest .repos ancestor wins" "$GOT" "$TMP/custom/wsroot/$WS_ID/inner/.repos/$WS_ID/$SLUG"

# ===== T6: no .repos anywhere → tier 3 legacy default; wsfix-$$ has no bare there → empty (slug dir missing) =====
# resolve_bare_repo checks [ -d bare_root/slug ]; legacy default path lacks it, and
# the glob fallback also misses => returns empty. Verify it does NOT return a bogus path.
ISOLATED="$TMP/nowhere-$$/zz3333/workdir"
mkdir -p "$ISOLATED"
GOT=$(resolve "$ISOLATED")
assert_eq "T6 isolated env yields empty (no bogus path)" "$GOT" ""

# ===== T6b: tier3 legacy default actually used when bare exists there =====
LEGACY_WS="wsfix-legacy-$$"
mkdir -p "/home/jerry/multica_workspaces/.repos/$LEGACY_WS/$SLUG"
LEGACY_WD="$TMP/legacy-ws-$$/aaaa4444/workdir"
mkdir -p "$LEGACY_WD"
GOT=$(
  (
    cd "$LEGACY_WD"
    export MULTICA_WORKSPACE_ID="$LEGACY_WS"
    unset MULTICA_BARE_REPOS_ROOT
    eval "$(extract_fn)"
    resolve_bare_repo "https://example.com/test/KingOfLikes-Godot.git"
  )
)
assert_eq "T6b tier3 legacy default fires when no walk/env hit" "$GOT" \
  "/home/jerry/multica_workspaces/.repos/$LEGACY_WS/$SLUG"
rm -rf "/home/jerry/multica_workspaces/.repos/$LEGACY_WS"

# ===== T7: production default unchanged (real workspace id, PWD inside real ws) =====
GOT=$(
  (
    cd "$TMP"
    unset MULTICA_WORKSPACE_ID MULTICA_BARE_REPOS_ROOT
    # ws_id derived from PWD/../.. — craft so basename is real ws id
    FAKEWS="$TMP/1a011680-a476-4553-929d-478690824e46/slotx/workdir"
    mkdir -p "$FAKEWS"
    cd "$FAKEWS"
    eval "$(extract_fn)"
    resolve_bare_repo "https://github.com/tadki/KingOfLikes-Godot.git"
  )
)
assert_eq "T7 production layout resolves via tier3 (real ws)" "$GOT" \
  "/home/jerry/multica_workspaces/.repos/1a011680-a476-4553-929d-478690824e46/github.com+tadki+KingOfLikes-Godot.git"

# ===== T8: slug glob fallback still works (slug drift) =====
GOT=$(
  (
    cd "$WORKDIR"
    export MULTICA_WORKSPACE_ID="$WS_ID"
    unset MULTICA_BARE_REPOS_ROOT
    # remove exact-slug dir, keep differently-slugged bare ending in same repo name
    mv "$TMP/custom/wsroot/.repos/$WS_ID/$SLUG" "$TMP/custom/wsroot/.repos/$WS_ID/otherhost.com+other+KingOfLikes-Godot.git"
    eval "$(extract_fn)"
    resolve_bare_repo "https://example.com/test/KingOfLikes-Godot.git"
  )
)
assert_eq "T8 slug-drift glob fallback" "$GOT" \
  "$TMP/custom/wsroot/.repos/$WS_ID/otherhost.com+other+KingOfLikes-Godot.git"

echo "=========================================="
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
