#!/usr/bin/env bash
# SEE-1170 通道 1 对抗性 QA — checkout_repo() stale prune + 单次 retry
# 隔离环境：自建 bare repo + PATH 上伪造 multica，绝不触碰真实 workspace。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/repo-checkout.sh"

TMP="$(mktemp -d /tmp/see1170-c1.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1 (got=$2)" || bad "$1 (want=$3 got=$2)"; }
assert_grep() { grep -q "$2" "$3" && ok "$1" || bad "$1 (pattern '$2' not found)"; }
assert_ngrep() { ! grep -q "$2" "$3" && ok "$1" || bad "$1 (pattern '$2' unexpectedly found)"; }

# ---- fixture: bare repo with a stale registration ----
WS_ID="ws-see1170-c1-$$"
SLUG="example.com+test+KingOfLikes-Godot.git"
BARE_ROOT="$TMP/.repos/$WS_ID"
mkdir -p "$BARE_ROOT"
git init --bare -q "$BARE_ROOT/$SLUG" 2>/dev/null
git -C "$BARE_ROOT/$SLUG" commit --allow-empty -m init -q 2>/dev/null || {
  git -C "$BARE_ROOT/$SLUG" worktree add "$TMP/dummy-wt" -q 2>/dev/null; }
# ensure HEAD exists
if [ -z "$(git -C "$BARE_ROOT/$SLUG" rev-parse HEAD 2>/dev/null)" ]; then
  TMP_TREE="$TMP/tree"
  git init -q "$TMP_TREE"
  git -C "$TMP_TREE" commit --allow-empty -m init -q
  git -C "$BARE_ROOT/$SLUG" fetch -q "$TMP_TREE" HEAD:master
fi

# workdir where hook's PWD lives; slot layout <prefix>/workdir
SLOT_PREFIX="deadbeef"
WORKDIR="$TMP/$SLOT_PREFIX/workdir"
mkdir -p "$WORKDIR"
REPO_DIR="KingOfLikes-Godot"
STALE_WT="$WORKDIR/$REPO_DIR"
git -C "$BARE_ROOT/$SLUG" worktree add "$STALE_WT" -q 2>/dev/null
# stale: remove the dir but keep registration
rm -rf "$STALE_WT"
N_REG_BEFORE=$(git -C "$BARE_ROOT/$SLUG" worktree list --porcelain | grep -c '^worktree ' || true)

# ---- fake multica on PATH: fails with stale-stderr, then succeeds ----
FAKE_BIN="$TMP/bin"; mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/multica" <<'EOF'
#!/usr/bin/env bash
LOG="$FAKE_LOG"
echo "call:$*" >> "$LOG"
if [ -f "$FAKE_FAIL_FOREVER" ]; then
  echo "fatal: 'xxx' is a missing but already registered worktree" >&2
  exit 3
fi
if [ "$(grep -c '^call:' "$LOG")" -le "$FAKE_FAIL_FIRST_N" ]; then
  echo "fatal: 'yyy' is a missing but already registered worktree" >&2
  exit 3
fi
exit 0
EOF
chmod +x "$FAKE_BIN/multica"

# ---- extract checkout_repo block from hook (source-under-test without running whole hook) ----
# We source the hook functions by stubbing everything the surrounding script needs.
# Simpler robust approach: create a shim script that defines the needed env, then
# evals just the SEE-1170 function block extracted via sed markers.
extract_fn() {
  sed -n '/^resolve_bare_repo()/,/^checkout_repo()/p' "$HOOK" | sed '$d'
  sed -n '/^checkout_repo()/,/^# --- Entry point/p' "$HOOK" | sed '$d'
}

run_case() {
  local desc="$1" fail_first_n="$2" fail_forever="$3" stderr_text="$4" expect_prune="$5"
  export FAKE_FAIL_FIRST_N="$fail_first_n" FAKE_LOG="$TMP/fake.log" FAKE_FAIL_FOREVER="$TMP/fail_forever"
  rm -f "$FAKE_LOG"
  [ "$fail_forever" = "1" ] && touch "$FAKE_FAIL_FOREVER" || rm -f "$FAKE_FAIL_FOREVER"
  # customize stderr text if provided
  if [ -n "$stderr_text" ]; then
    sed -i "s|missing but already registered|${stderr_text}|" "$FAKE_BIN/multica" 2>/dev/null
  fi
  (
    cd "$WORKDIR"
    export MULTICA_WORKSPACE_ID="$WS_ID"
    export PATH="$FAKE_BIN:$PATH"
    REPO_CHECKOUT_TIMEOUT=10
    CHECKOUT_FAILED=false; CHECKOUT_DIAG=""
    eval "$(extract_fn)"
    checkout_repo "https://example.com/test/KingOfLikes-Godot.git" "$REPO_DIR"
    echo "RC=$?"
    echo "CHECKOUT_FAILED=$CHECKOUT_FAILED"
    echo "CHECKOUT_DIAG=$CHECKOUT_DIAG"
  ) > "$TMP/out.txt" 2>&1
}

# Adversarial discovery: resolve_bare_repo hardcodes /home/jerry/multica_workspaces/.repos
# To make the harness work we create that real path as a symlink to fixture (restored after).
REAL_ROOT="/home/jerry/multica_workspaces/.repos"
mkdir -p "$REAL_ROOT" 2>/dev/null
BACKUP=""
if [ -e "$REAL_ROOT/$WS_ID" ] || [ -L "$REAL_ROOT/$WS_ID" ]; then
  bad "fixture collision: $REAL_ROOT/$WS_ID already exists — aborting to avoid damaging real data"
  echo "SUMMARY: PASS=$PASS FAIL=$FAIL"; exit 1
fi
ln -s "$BARE_ROOT" "$REAL_ROOT/$WS_ID"
CLEANUP_LINK=1

# ===== S1: stale stderr hit -> prune once + retry once succeeds =====
run_case "S1" 1 0 "" 1
N_REG_AFTER=$(git -C "$BARE_ROOT/$SLUG" worktree list --porcelain | grep -c '^worktree ' || true)
CALLS=$(grep -c '^call:repo checkout' "$TMP/fake.log" 2>/dev/null || echo 0)
assert_eq "S1 retry exactly-once-extra call (2 calls)" "$CALLS" "2"
assert_eq "S1 stale registration pruned (reg count dropped)" "$N_REG_AFTER" "$((N_REG_BEFORE-1))"
assert_grep "S1 success diag recorded" "已对 bare repo 执行 git worktree prune，retry checkout 成功" "$TMP/out.txt"
grep -q "CHECKOUT_FAILED=false" "$TMP/out.txt" && ok "S1 CHECKOUT_FAILED=false" || bad "S1 CHECKOUT_FAILED not false"

# re-create stale for next cases
recreate_stale() {
  git -C "$BARE_ROOT/$SLUG" worktree prune
  git -C "$BARE_ROOT/$SLUG" worktree add "$STALE_WT" -q 2>/dev/null
  rm -rf "$STALE_WT"
}

# ===== S2: fallback triple-AND detection (no stderr text) =====
recreate_stale
# build shell dir: create empty target dir without .git (dir exists + .git missing + registration present)
mkdir -p "$STALE_WT"
FAKE_MSG="totally different network error text" run_case_v2=""
rm -f "$FAKE_LOG"; rm -f "$FAKE_FAIL_FOREVER"
export FAKE_FAIL_FIRST_N=1 FAKE_LOG="$TMP/fake.log"
# fake multica now fails with generic error (no stale text)
cat > "$FAKE_BIN/multica" <<'EOF'
#!/usr/bin/env bash
LOG="$FAKE_LOG"
echo "call:$*" >> "$LOG"
if [ "$(grep -c '^call:' "$LOG")" = "1" ]; then
  echo "fatal: some generic transient network error" >&2
  exit 4
fi
exit 0
EOF
chmod +x "$FAKE_BIN/multica"
(
  cd "$WORKDIR"
  export MULTICA_WORKSPACE_ID="$WS_ID" REPO_CHECKOUT_TIMEOUT=10 PATH="$FAKE_BIN:$PATH"
  CHECKOUT_FAILED=false; CHECKOUT_DIAG=""
  eval "$(extract_fn)"
  checkout_repo "https://example.com/test/KingOfLikes-Godot.git" "$REPO_DIR"
  echo "CHECKOUT_FAILED=$CHECKOUT_FAILED"
  echo "CHECKOUT_DIAG=$CHECKOUT_DIAG"
) > "$TMP/out2.txt" 2>&1
CALLS2=$(grep -c '^call:repo checkout' "$TMP/fake.log" || echo 0)
assert_eq "S2 fallback triggers single retry (2 calls)" "$CALLS2" "2"
assert_grep "S2 fallback diag success" "retry checkout 成功" "$TMP/out2.txt"

# ===== S3: generic network error, dir NOT existing -> no prune, no retry =====
recreate_stale
rm -rf "$STALE_WT"   # dir absent + stderr generic => neither trigger path
rm -f "$FAKE_LOG"; rm -f "$FAKE_FAIL_FOREVER"
export FAKE_LOG="$TMP/fake.log"
(
  cd "$WORKDIR"
  export MULTICA_WORKSPACE_ID="$WS_ID" REPO_CHECKOUT_TIMEOUT=10 PATH="$FAKE_BIN:$PATH"
  CHECKOUT_FAILED=false; CHECKOUT_DIAG=""
  eval "$(extract_fn)"
  checkout_repo "https://example.com/test/KingOfLikes-Godot.git" "$REPO_DIR"
  echo "CHECKOUT_FAILED=$CHECKOUT_FAILED"
  echo "CHECKOUT_DIAG=$CHECKOUT_DIAG"
) > "$TMP/out3.txt" 2>&1
CALLS3=$(grep -c '^call:repo checkout' "$TMP/fake.log" || echo 0)
assert_eq "S3 no retry on generic error (1 call)" "$CALLS3" "1"
grep -q "CHECKOUT_FAILED=true" "$TMP/out3.txt" && ok "S3 CHECKOUT_FAILED=true" || bad "S3 CHECKOUT_FAILED not true"
# note: with dir absent, bare_registration_exists check requires dir exists — so no prune.
N_REG3=$(git -C "$BARE_ROOT/$SLUG" worktree list --porcelain | grep -c '^worktree ' || true)
assert_eq "S3 registration NOT pruned by hook (no trigger)" "$N_REG3" "$N_REG_BEFORE"

# ===== S4: stale hit but retry fails forever =====
recreate_stale
rm -f "$FAKE_LOG"; touch "$FAKE_FAIL_FOREVER"
cat > "$FAKE_BIN/multica" <<'EOF'
#!/usr/bin/env bash
LOG="$FAKE_LOG"
echo "call:$*" >> "$LOG"
echo "fatal: 'zzz' is a missing but already registered worktree" >&2
exit 3
EOF
chmod +x "$FAKE_BIN/multica"
export FAKE_LOG="$TMP/fake.log"
(
  cd "$WORKDIR"
  export MULTICA_WORKSPACE_ID="$WS_ID" REPO_CHECKOUT_TIMEOUT=10 PATH="$FAKE_BIN:$PATH"
  CHECKOUT_FAILED=false; CHECKOUT_DIAG=""
  eval "$(extract_fn)"
  checkout_repo "https://example.com/test/KingOfLikes-Godot.git" "$REPO_DIR"
  echo "CHECKOUT_FAILED=$CHECKOUT_FAILED"
  echo "CHECKOUT_DIAG=$CHECKOUT_DIAG"
) > "$TMP/out4.txt" 2>&1
CALLS4=$(grep -c '^call:repo checkout' "$TMP/fake.log" || echo 0)
assert_eq "S4 exactly 2 calls, no loop" "$CALLS4" "2"
grep -q "CHECKOUT_FAILED=true" "$TMP/out4.txt" && ok "S4 CHECKOUT_FAILED=true" || bad "S4 CHECKOUT_FAILED not true"
assert_grep "S4 diag still-failing" "retry checkout 仍失败" "$TMP/out4.txt"

# ===== S5: stale hit but bare repo unresolvable =====
recreate_stale
rm -f "$FAKE_LOG"
export FAKE_LOG="$TMP/fake.log"
(
  cd "$WORKDIR"
  export MULTICA_WORKSPACE_ID="no-such-ws-xyz" REPO_CHECKOUT_TIMEOUT=10 PATH="$FAKE_BIN:$PATH"
  CHECKOUT_FAILED=false; CHECKOUT_DIAG=""
  eval "$(extract_fn)"
  checkout_repo "https://example.com/test/KingOfLikes-Godot.git" "$REPO_DIR"
  echo "CHECKOUT_FAILED=$CHECKOUT_FAILED"
  echo "CHECKOUT_DIAG=$CHECKOUT_DIAG"
) > "$TMP/out5.txt" 2>&1
CALLS5=$(grep -c '^call:repo checkout' "$TMP/fake.log" || echo 0)
assert_eq "S5 no retry when bare unresolved (1 call)" "$CALLS5" "1"
assert_grep "S5 explicit skip diag" "bare repo 路径无法推导，跳过 prune" "$TMP/out5.txt"
grep -q "CHECKOUT_FAILED=true" "$TMP/out5.txt" && ok "S5 CHECKOUT_FAILED=true" || bad "S5 CHECKOUT_FAILED not true"

# ===== S6: prune no-op on LIVE worktree (git built-in guarantee) =====
LIVE_WT="$TMP/live-wt"
git -C "$BARE_ROOT/$SLUG" worktree add "$LIVE_WT" -q
git -C "$BARE_ROOT/$SLUG" worktree prune
[ -d "$LIVE_WT/.git" ] || [ -f "$LIVE_WT/.git" ] && ok "S6 live worktree survives prune" || bad "S6 live worktree damaged by prune"
git -C "$BARE_ROOT/$SLUG" worktree remove "$LIVE_WT" --force 2>/dev/null || true

# cleanup fixture link
[ -n "${CLEANUP_LINK:-}" ] && rm -f "$REAL_ROOT/$WS_ID"

echo "=========================================="
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
