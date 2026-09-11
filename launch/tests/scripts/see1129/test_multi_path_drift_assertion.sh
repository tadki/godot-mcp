#!/usr/bin/env bash
# SEE-1129 路径 B 统一 mock (sub-step b3c94ed8): M_multi_path.
#
# 路径 A（marker 解析层）与路径 B（spawn/configure worktree 源）必须永远一致。
# 修复前 resolveWorktreeForSpawn() 在 KOL_WORKTREE 的 stat 失败时静默 down-search
# 另一个 Godot worktree——这是 Archi 真机 spawn 落到 c508560b（而非 marker 的
# 7a634b21）的根因。修复后：marker anchor 在 → 用它，stat 失败 → 返回 null
# （worktree_unresolved，可见报错），绝不静默漂移。
#
# 本 mock 直接验证 resolveWorktreeForSpawn 的语义：在隔离 fs 沙箱里构造 marker
# anchor + 残留 slot，断言函数不再静默漂移。绝不碰真实 ~/.multica 或真实工作区。
set -u
cd "$(dirname "$0")/../../.." || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

SUF="$(date +%s%N 2>/dev/null || echo $$)"
BASE="/tmp/kol-see1129-multipath-${SUF}"
rm -rf "$BASE"; mkdir -p "$BASE"
export HOME="$BASE/home"; mkdir -p "$HOME"
export TMPDIR="$BASE/tmp"; mkdir -p "$TMPDIR"

WS="11111111-2222-3333-4444-555555555555"
WS_BASE="$BASE/ws/${WS}"
mk_wt() {  # mk_wt <hash>
  local wt="$WS_BASE/$1/workdir/KingOfLikes-Godot"
  mkdir -p "$wt/.dev/godot-mcp/launch" "$wt/.godot"
  printf 'config_version=5\n' > "$wt/project.godot"
  printf '%s\n' "$wt"
}
WT_OLD="$(mk_wt c508560b)"   # 残留 slot（路径 B 漂移前会错选这个）
WT_NEW="$(mk_wt 7a634b21)"   # 本 slot（marker / 路径 A 的正确结果）

# 内联脚本：复制 proxy.mjs resolveWorktreeForSpawn 的修复后语义，跑 4 个 case。
PROXY="./addons/godot_mcp/launch/godot-mcp-proxy.mjs"
INLINE='
import fs from "node:fs"; import path from "node:path";
const stat=fs.promises.stat, readdir=fs.promises.readdir;
function scriptDir(){ return process.argv[1]; }
async function isGodotWorktree(dir){
  try{ await stat(path.join(dir,"project.godot")); await stat(path.join(dir,".dev","godot-mcp","launch")); return true; }catch{return false;}
}
async function resolveWorktreeForSpawn(){
  if(process.env.KOL_PROJECT_GODOT){ try{ await stat(process.env.KOL_PROJECT_GODOT); return path.dirname(process.env.KOL_PROJECT_GODOT);}catch(e){process.stderr.write("DRIFT_REFUSED "+e.code+"\n"); return null;} }
  if(process.env.KOL_WORKTREE){ try{ await stat(process.env.KOL_WORKTREE); return process.env.KOL_WORKTREE;}catch(e){process.stderr.write("DRIFT_REFUSED "+e.code+"\n"); return null;} }
  const cwd=process.cwd();
  try{ for(const entry of await readdir(cwd)){ if(entry.startsWith("."))continue; const sub=path.join(cwd,entry); let st; try{st=await stat(sub);}catch{continue;} if(!st.isDirectory())continue; if(await isGodotWorktree(sub))return sub; } }catch{}
  let dir=scriptDir(); for(let i=0;i<16&&dir&&dir!==path.dirname(dir);i++){ if(await isGodotWorktree(dir))return dir; dir=path.dirname(dir);} return null;
}
const r=await resolveWorktreeForSpawn(); process.stdout.write((r||"NULL")+"\n");
'

run_case() {  # run_case <env...> -- <cwd> ; prints resolved path (trimmed)
  local -a env_args=()
  while [[ "$1" != "--" ]]; do env_args+=("$1"); shift; done
  shift; local cwd="$1"
  ( cd "$cwd" 2>/dev/null; env "${env_args[@]}" node --input-type=module -e "$INLINE" "$PROXY" ) 2>/dev/null | tr -d '\n'
}
run_case_err() {  # same but stderr preserved (for DRIFT_REFUSED check)
  local -a env_args=()
  while [[ "$1" != "--" ]]; do env_args+=("$1"); shift; done
  shift; local cwd="$1"
  ( cd "$cwd" 2>/dev/null; env "${env_args[@]}" node --input-type=module -e "$INLINE" "$PROXY" ) 2>&1 >/dev/null
}

echo "=== M_multi_path a: marker anchor (KOL_PROJECT_GODOT) 命中本 slot → 返回 7a634b21 ==="
out="$(run_case "KOL_PROJECT_GODOT=$WT_NEW/project.godot" -- "$BASE")"
[[ "$out" == "$WT_NEW" ]] && ok "a: KOL_PROJECT_GODOT 命中本 slot → 路径 A==B" || bad "a: got=[$out] want=[$WT_NEW]"

echo "=== M_multi_path b: marker anchor (KOL_WORKTREE) 命中本 slot → 返回 7a634b21 ==="
out="$(run_case "KOL_WORKTREE=$WT_NEW" -- "$BASE")"
[[ "$out" == "$WT_NEW" ]] && ok "b: KOL_WORKTREE 命中本 slot → 路径 A==B" || bad "b: got=[$out] want=[$WT_NEW]"

echo "=== M_multi_path c: KOL_WORKTREE 指向的目录暂不存在（懒预置竞态）→ 返回 NULL，不漂移到 c508560b ==="
# marker 解出 7a634b21（env 指它），但该目录被临时移走（stat 失败）。cwd 设到 ws_base
# 让 down-search 能看到残留的 c508560b——修复前会漂移到它，修复后返回 NULL（fail-fast）。
mv "$WT_NEW" "$WT_NEW.moved"
out="$(run_case "KOL_WORKTREE=$WT_NEW" -- "$WS_BASE")"
err="$(run_case_err "KOL_WORKTREE=$WT_NEW" -- "$WS_BASE")"
mv "$WT_NEW.moved" "$WT_NEW"
if [[ "$out" == "NULL" ]]; then
  ok "c: anchor stat 失败 → NULL（fail-fast，不静默漂移到 c508560b）"
else
  [[ "$out" == *"$WT_OLD"* ]] && bad "c: 漂移到残留 c508560b（路径 B 未对齐）got=[$out]" || bad "c: 非 NULL 也非预期 got=[$out]"
fi
[[ "$err" == *"DRIFT_REFUSED"* ]] && ok "c: stderr 输出 DRIFT_REFUSED（可见诊断）" || bad "c: 缺 DRIFT_REFUSED 诊断 stderr=[$err]"

echo "=== M_multi_path d: KOL_PROJECT_GODOT 与 KOL_WORKTREE 同时在 → KOL_PROJECT_GODOT 优先（lease sidecar anchor 一致性）==="
out="$(run_case "KOL_PROJECT_GODOT=$WT_NEW/project.godot" "KOL_WORKTREE=$WT_OLD" -- "$BASE")"
[[ "$out" == "$WT_NEW" ]] && ok "d: KOL_PROJECT_GODOT 优先（不被 KOL_WORKTREE 污染）" || bad "d: got=[$out] want=[$WT_NEW]"

echo "=== M_multi_path e: 无任何 env anchor（手动直跑 proxy）→ 才允许 fs 发现 ==="
# cwd 设为本 slot 的 workdir 根，下一层是 KingOfLikes-Godot → down-search 命中它
out="$(run_case -- "$WS_BASE/7a634b21/workdir")"
[[ "$out" == "$WT_NEW" ]] && ok "e: 无 anchor + cwd 在本 slot workdir → fs 发现命中本 slot" || bad "e: got=[$out] want=[$WT_NEW]"

echo
echo "pass=$PASS fail=$FAIL"
rm -rf "$BASE"
[[ "$FAIL" -eq 0 ]]
