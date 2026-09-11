#!/usr/bin/env bash
# T3-D1 修复的防放水对照：确认无祖先关系（tip 对象齐备 + sha 确实不在 remote）
# 仍必须判 dangling——修复不能把真 dangling 也放行。
set -uo pipefail
# Run context (SEE-1287): KOL_ROOT must point at a KingOfLikes-Godot checkout
# providing .claude/hooks/lib/gitlink-probe.sh. The original hardcoded path
# referenced the retired SEE-1273 QA worktree.
KOL="${KOL_ROOT:?KOL_ROOT must point at a KingOfLikes-Godot checkout with .claude/hooks/lib/gitlink-probe.sh}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

git init -q --bare "$TMP/origin.git"
git init -q "$TMP/seed"
(
  cd "$TMP/seed"
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m m1
  git push -q "$TMP/origin.git" HEAD:refs/heads/other
)
# child：clone 后额外做一个 origin 上不存在的 ghost commit（本地有对象、remote 无）。
git clone -q "$TMP/origin.git" "$TMP/child"
(
  cd "$TMP/child"
  git checkout -q other
  GHOST="$(git -c user.email=t@t -c user.name=t commit -q --allow-empty -m ghost && git rev-parse HEAD)"
  echo "$GHOST" > "$TMP/ghost.sha"
  # ghost 不推到 remote；把本地 main 停在与 remote 一致的 tip 上
  git reset -q --hard origin/other
)
GHOST="$(cat "$TMP/ghost.sha")"
mkdir -p "$TMP/parent/sub"
cp -r "$TMP/child/." "$TMP/parent/sub/"
printf '[submodule "sub"]\n\tpath = sub\n\turl = %s\n' "$TMP/origin.git" > "$TMP/parent/.gitmodules"
source "$KOL/.claude/hooks/lib/gitlink-probe.sh"
v="$(qa_gitlink_classify "$TMP/parent" sub "$GHOST")"
[[ "$v" == "dangling" ]] && ok "真 dangling（child 本地有 ghost sha、origin 无此对象）仍判 dangling" || bad "真 dangling 被放水为 '$v'"
GOOD="$(git -C "$TMP/child" rev-parse origin/other)"
v2="$(qa_gitlink_classify "$TMP/parent" sub "$GOOD")"
[[ "$v2" == "healthy" ]] && ok "sha==remote tip 仍判 healthy" || bad "healthy 形态误判为 '$v2'"

echo "==== anti-drown: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
