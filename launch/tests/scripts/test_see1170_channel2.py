"""SEE-1170 通道 2 — find_bare_repo_path 派生式 bare repo 解析测试

在隔离 tmp 目录构造 bare repo + 假 workspace slots，验证：
- 从非标准 workspace_root 通过 linked-worktree 的 .git 指针逐级上溯解析 bare repo
- 无 workdir 的 slot 目录安全跳过
- 全部候选（walk + 派生 fallback）都不可解析时精确返回空串

SEE-1181: B0 sweep（b0_sweep / _b0_fetch_issue_status / 空壳门限）与 --fast 已删除，
职责上移到 repo-checkout.sh 与 godot-mcp-proxy 的进程内 prune；FastMode 与 B0Fixture
测试类随之移除。find_bare_repo_path 的 fallback 改为派生式
（$MULTICA_WORKSPACE_ID 或 ws_root basename + 逐级上溯 .repos/<ws_id>），
walk 解析路径测试保留。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / ".dev" / "autopilots"))
import local_repo_check as lrc  # noqa: E402


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, check=True, text=True,
                          capture_output=True, **kw).stdout


class FindBareRepoPath(unittest.TestCase):
    """find_bare_repo_path must resolve via walk on NON-standard workspace_root.

    Regression: prior implementation's inner `break` fired at depth=0 (workdir
    itself), so the walk never descended into <workdir>/<repo> and the function
    only ever worked via the hardcoded /home/jerry/multica_workspaces/.repos
    fallback. These tests pin the walk-based resolution path so the fallback is
    genuinely a fallback, not the only working route.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="see1170-findbare-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.bare = self.tmp / "bare.git"
        sh(f'git init --bare -q "{self.bare}"')
        seed = self.tmp / "seed"
        sh(f'git init -q "{seed}"')
        (seed / "f.txt").write_text("x")
        sh(f'git -C "{seed}" add .')
        sh(f'git -C "{seed}" -c user.email=t@t -c user.name=t commit -qm init')
        sh(f'git -C "{self.bare}" fetch -q "{seed}" HEAD:master')

    def test_walk_resolves_linked_worktree_under_nonstandard_ws_root(self):
        """Non-standard ws_root (any tmp dir) + linked worktree → walk resolves."""
        ws = self.tmp / "ws_anything"
        slot = ws / "aaaaaaaa" / "workdir"
        slot.mkdir(parents=True)
        sh(f'git -C "{self.bare}" worktree add -b qa-x "{slot / "repo"}" -q')
        # Sanity: linked worktree layout, .git is a file containing "gitdir: ..."
        git_pointer = slot / "repo" / ".git"
        self.assertTrue(git_pointer.is_file())
        self.assertTrue(git_pointer.read_text().startswith("gitdir: "))

        resolved = lrc.find_bare_repo_path(str(ws))
        self.assertEqual(str(self.bare), resolved,
                         "walk must resolve bare repo from linked-worktree .git pointer")

    def test_walk_skips_slots_without_workdir(self):
        """ws slot dir without workdir/ must be skipped without crashing."""
        ws = self.tmp / "ws_mixed"
        (ws / "deadbeef").mkdir(parents=True)  # slot with no workdir
        slot = ws / "aaaaaaaa" / "workdir"
        slot.mkdir(parents=True)
        sh(f'git -C "{self.bare}" worktree add -b qa-y "{slot / "repo"}" -q')
        resolved = lrc.find_bare_repo_path(str(ws))
        self.assertEqual(str(self.bare), resolved)

    def test_walk_returns_empty_when_no_worktree_resolves(self):
        """Isolated env where ALL fallback candidates are dead → assert exact empty return.

        The derived fallback builds candidates from $MULTICA_WORKSPACE_ID (or
        basename(ws_root)) plus $MULTICA_BARE_REPOS_ROOT / walk-up `.repos/<ws_id>`
        / legacy /home/jerry/multica_workspaces/.repos/<ws_id>. Stub os.path.isdir
        to return False for every `.repos/` path so even on a host where a repo
        exists the fallback is guaranteed dead. Then:
        1. CANARY — a sibling ws_root whose slot has a real linked worktree
           must resolve via walk. This proves the empty return below is not
           vacuous: if the walk is fully broken (e.g. the old depth=0 `break`
           bug), the canary fails first and this test FAILS.
        2. The empty ws (slot with workdir but no repo) must return exactly
           "" — a strong assertion, not `if resolved: assertTrue(...)`.
        """
        # CANARY fixture: sibling ws_root with a resolvable linked worktree
        canary_ws = self.tmp / "ws_canary_ok"
        canary_slot = canary_ws / "aaaaaaaa" / "workdir"
        canary_slot.mkdir(parents=True)
        sh(f'git -C "{self.bare}" worktree add -b qa-canary "{canary_slot / "repo"}" -q')

        ws = self.tmp / "ws_empty_zzz"
        (ws / "aaaaaaaa" / "workdir").mkdir(parents=True)  # empty workdir, no repo
        real_isdir = os.path.isdir

        def isdir_without_fallback(path):
            if "/.repos/" in path:
                return False
            return real_isdir(path)

        os.path.isdir = isdir_without_fallback
        try:
            canary = lrc.find_bare_repo_path(str(canary_ws))
            resolved = lrc.find_bare_repo_path(str(ws))
        finally:
            os.path.isdir = real_isdir
        self.assertEqual(str(self.bare), canary,
                         "canary: walk must be functional in this isolated env, "
                         "else the empty-return assertion below is vacuous")
        self.assertEqual("", resolved,
                         "with walk finding nothing and fallback dead, must return exactly empty string")


if __name__ == "__main__":
    unittest.main(verbosity=2)
