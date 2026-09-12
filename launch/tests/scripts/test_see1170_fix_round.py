#!/usr/bin/env python3
"""SEE-1170 修复轮复测 — find_bare_repo_path walk 修复的对抗性复核

目标 1：
  - 非标准 ws_root 下 walk 真的能解析（不触发 fallback）
  - fallback 兜底路径仍工作（生产布局行为不变）
  - 对抗误解析：多 repo（两个 bare）、深层嵌套（depth>2 不泄漏）、symlink
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# SEE-1291 H2: local_repo_check lives in the KOL consumer repo, not this fork.
# Anchor via KOL_ROOT (explicit env, else the enclosing superproject when this
# is a submodule checkout); give fix_round.py an interpreter shebang too.
_KOL_ROOT = os.environ.get("KOL_ROOT") or subprocess.run(
    ["git", "-C", str(Path(__file__).resolve().parents[3]),
     "rev-parse", "--show-superproject-working-tree"],
    capture_output=True, text=True).stdout.strip()
REPO_ROOT = Path(_KOL_ROOT or Path(__file__).resolve().parents[3])
sys.path.insert(0, str(REPO_ROOT / ".dev" / "autopilots"))
import local_repo_check as lrc  # noqa: E402


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, check=True, text=True,
                          capture_output=True, **kw).stdout


def make_bare(path):
    sh(f'git init --bare -q "{path}"')
    seed = path.parent / (path.stem + "-seed")
    sh(f'git init -q "{seed}"')
    (seed / "f.txt").write_text("x")
    sh(f'git -C "{seed}" add .')
    sh(f'git -C "{seed}" -c user.email=t@t -c user.name=t commit -qm init')
    sh(f'git -C "{path}" fetch -q "{seed}" HEAD:master')
    return path


class WalkResolution(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="see1170-fix1-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_walk_resolves_nonstandard_ws_root_without_fallback(self):
        """ws_root is a tmp dir NOT named like a multica ws id — fallback cannot
        match, so any successful resolution must come from the walk."""
        bare = make_bare(self.tmp / "bare.git")
        ws = self.tmp / "ws_definitely_not_a_multica_id"
        slot = ws / "aaaaaaaa" / "workdir"
        slot.mkdir(parents=True)
        sh(f'git -C "{bare}" worktree add -b qa "{slot / "repo"}" -q')
        got = lrc.find_bare_repo_path(str(ws))
        self.assertEqual(str(bare), got)

    def test_production_layout_still_resolves(self):
        """Real multica workspace (production layout) must still resolve — the
        fallback or walk, whichever fires first, must yield the real bare."""
        got = lrc.find_bare_repo_path(
            "/home/jerry/multica_workspaces/1a011680-a476-4553-929d-478690824e46"
        )
        self.assertTrue(got.endswith("github.com+tadki+KingOfLikes-Godot.git"),
                        f"production resolution drifted: {got}")

    def test_multiple_bare_repos_returns_first_in_sorted_slot_order(self):
        """Two slots pointing to two different bare repos. The walk iterates
        sorted(os.listdir(ws_root)) — result must be deterministic (slot sort
        order), not arbitrary. Pin behavior, don't assert which bare wins."""
        bare_a = make_bare(self.tmp / "bareA.git")
        bare_b = make_bare(self.tmp / "bareB.git")
        ws = self.tmp / "ws_multi"
        s1 = ws / "aaaaaaaa" / "workdir"
        s1.mkdir(parents=True)
        sh(f'git -C "{bare_a}" worktree add -b qa-a "{s1 / "repo"}" -q')
        s2 = ws / "bbbbbbbb" / "workdir"
        s2.mkdir(parents=True)
        sh(f'git -C "{bare_b}" worktree add -b qa-b "{s2 / "repo"}" -q')
        got = lrc.find_bare_repo_path(str(ws))
        # Slot "aaaaaaaa" sorts first -> bare_a expected
        self.assertEqual(str(bare_a), got,
                         "sorted-slot walk must pick the first slot's bare deterministically")

    def test_deep_nesting_beyond_depth2_does_not_leak(self):
        """A fake .git pointer buried at depth>2 (e.g. nested project subdirs)
        must NOT be picked up — the walk prunes depth>2. This guards against
        resolving to a random nested repo inside a worktree."""
        bare = make_bare(self.tmp / "bare.git")
        ws = self.tmp / "ws_deep"
        slot = ws / "aaaaaaaa" / "workdir"
        # decoy: a nested directory with its own .git pointer at depth 4
        decoy = slot / "repo" / "sub" / "deep"
        decoy.mkdir(parents=True)
        (decoy / ".git").write_text(f"gitdir: {self.tmp}/decoy.git/worktrees/x\n")
        (self.tmp / "decoy.git").mkdir()
        # real linked worktree at proper depth
        sh(f'git -C "{bare}" worktree add -b qa "{slot / "repo2"}" -q')
        got = lrc.find_bare_repo_path(str(ws))
        self.assertEqual(str(bare), got,
                         "walk must not leak into depth>2 nested .git pointers")

    def test_symlinked_ws_root_resolves_through_link(self):
        """ws_root passed as a symlink must still resolve (os.walk follows
        the root path itself; only descending into symlinked dirs would need
        followlinks=True)."""
        bare = make_bare(self.tmp / "bare.git")
        real_ws = self.tmp / "ws_real"
        slot = real_ws / "aaaaaaaa" / "workdir"
        slot.mkdir(parents=True)
        sh(f'git -C "{bare}" worktree add -b qa "{slot / "repo"}" -q')
        link = self.tmp / "ws_link"
        link.symlink_to(real_ws)
        got = lrc.find_bare_repo_path(str(link))
        self.assertEqual(str(bare), got)

    def test_empty_slot_dir_skipped_without_crash(self):
        """Slot dir with no workdir/ at all — must skip silently."""
        bare = make_bare(self.tmp / "bare.git")
        ws = self.tmp / "ws_partial"
        (ws / "deadbeef").mkdir(parents=True)
        slot = ws / "aaaaaaaa" / "workdir"
        slot.mkdir(parents=True)
        sh(f'git -C "{bare}" worktree add -b qa "{slot / "repo"}" -q')
        self.assertEqual(str(bare), lrc.find_bare_repo_path(str(ws)))

    def test_git_pointer_to_nonexistent_bare_rejected(self):
        """A .git pointer whose derived bare path does not exist on disk must
        NOT be returned (os.path.isdir check)."""
        ws = self.tmp / "ws_dangling"
        slot = ws / "aaaaaaaa" / "workdir"
        repo = slot / "repo"
        repo.mkdir(parents=True)
        (repo / ".git").write_text(f"gitdir: {self.tmp}/ghost.git/worktrees/x\n")
        # ghost.git does not exist
        got = lrc.find_bare_repo_path(str(ws))
        # should NOT return the ghost path; fallback also won't match tmp name
        self.assertNotEqual(str(self.tmp / "ghost.git"), got)


if __name__ == "__main__":
    unittest.main(verbosity=2)
