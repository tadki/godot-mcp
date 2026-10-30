#!/usr/bin/env bash
# SEE-1494 §SPEC-007 — upstream fork-identity regression gate.
#
# Why this gate exists: the godot-mcp fork carried upstream namespace / package
# / URL references for two years precisely because nothing stopped them from
# flowing back in. SEE-1494 repointed every live reference to the independent
# owner; this gate freezes that result so the same class of identity regression
# fails CI instead of silently surviving.
#
# Criterion (aligned with §SPEC-001 — the allowlist is NOT widened):
#   every tracked file outside the 3-file identity allowlist must be free of the
#   upstream fork-owner token (case-insensitive). Allowlist, root-anchored,
#   exactly these three:
#     README.md                        — retained Origins credit (§SPEC-001)
#     server/CHANGELOG.md              — historical release records
#     docs/design/mouse-input-spike.md — upstream PR historical reference
#
# Two independent detection arms (mirrors check-workflow-run-syntax.sh shape):
#   arm 1 — literal upstream-owner token, case-insensitive
#   arm 2 — separator/obfuscation variants (dash / underscore / dot / space),
#           defense-in-depth: a "fix" that only swaps the spelling of the token
#           would otherwise slip past arm 1's literal scan
#
# Fail-closed policy — each of these is a FAIL, never a vacuous PASS:
#   * git unavailable / not inside a git work tree
#   * empty or implausibly small scan surface (wrong root / empty checkout)
#   * an allowlist path missing from the tracked set (path-resolution drift —
#     would silently widen the allowlist if left unchecked)
#   * git grep returning anything other than matches (0) or no-match (1)
#   * either detector failing its known-positive self-test
#
# Usage: bash .github/scripts/check-fork-identity.sh
set -uo pipefail

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Assembled at runtime so this gate's own (tracked, scanned) source carries no
# contiguous positive to flag itself.
TOKEN=$(printf '%s%s' 'satellite' 'oflove')
VARIANT_RE='satellite[-_. ]+of[-_. ]+love\b'
ALLOWLIST=(
    'README.md'
    'server/CHANGELOG.md'
    'docs/design/mouse-input-spike.md'
)
MIN_TRACKED_FILES=20

command -v git >/dev/null 2>&1 || fail "git not available (gate is fail-closed)"
git rev-parse --show-toplevel >/dev/null 2>&1 || fail "not inside a git work tree (gate is fail-closed)"
root=$(git rev-parse --show-toplevel) || fail "cannot resolve repo root (fail-closed)"
root=${root%$'\n'}

# Detector self-tests: a detector that cannot see a known positive must FAIL.
# Probe strings are assembled so the source does not carry a matchable literal.
probe_literal="Satellite""Of""Love"
probe_variant="satellite-""of""-love"
printf '%s\n' "$probe_literal" | grep -qiF -- "$TOKEN" ||
    fail "arm-1 self-test: literal detector cannot see a known positive (fail-closed)"
printf '%s\n' "$probe_variant" | grep -qiE -- "$VARIANT_RE" ||
    fail "arm-2 self-test: variant detector cannot see a known positive (fail-closed)"

# Scan-surface guards.
tracked_count=$(git -C "$root" ls-files | wc -l | tr -d ' ')
[ "${tracked_count:-0}" -ge "$MIN_TRACKED_FILES" ] ||
    fail "scan surface too small ($tracked_count tracked files < $MIN_TRACKED_FILES) — wrong root or empty checkout (fail-closed)"

# Engine liveness: git grep must see at least one tracked line.
git -C "$root" grep -q -e . -- . >/dev/null 2>&1 ||
    fail "git grep engine self-test failed: cannot see any tracked content (fail-closed)"

# Allowlist integrity: each path must resolve to a tracked file. A missing path
# means the exclusion below would silently stop protecting that file.
for p in "${ALLOWLIST[@]}"; do
    git -C "$root" ls-files --error-unmatch -- "$p" >/dev/null 2>&1 ||
        fail "allowlist path not tracked: $p — path resolution failed (fail-closed)"
done
excludes=()
for p in "${ALLOWLIST[@]}"; do excludes+=(":(top,exclude)$p"); done

tmpdir=$(mktemp -d) || fail "mktemp failed"
trap 'rm -rf "$tmpdir"' EXIT
: > "$tmpdir/hits"
: > "$tmpdir/arms"

# arm_grep <label> <grep-mode> <pattern>
# Scans every tracked file except the allowlist; records any match.
arm_grep() {
    local label="$1" mode="$2" pattern="$3" out rc
    out=$(git -C "$root" grep -i -n "$mode" "$pattern" -- . "${excludes[@]}" 2>"$tmpdir/grep.err")
    rc=$?
    case "$rc" in
        1) return 0 ;;   # no match outside allowlist
        0)               # match -> record and keep scanning the other arm
           printf '%s\n' "$out" >> "$tmpdir/hits"
           printf '%s\n' "$label" >> "$tmpdir/arms"
           return 0 ;;
        *) fail "$label: git grep returned rc=$rc (expected 0/1) — $(tr '\n' ' ' <"$tmpdir/grep.err") (fail-closed)" ;;
    esac
}

echo "fork-identity gate: scanning $tracked_count tracked files; allowlist: ${ALLOWLIST[*]}"
arm_grep "arm 1 (literal token, case-insensitive)" -F "$TOKEN"
arm_grep "arm 2 (separator/obfuscation variants)" -E "$VARIANT_RE"

if [ -s "$tmpdir/hits" ]; then
    echo "upstream fork-identity references found outside the allowlist:"
    echo "--- arms that fired ---"
    sort -u "$tmpdir/arms"
    echo "--- offending locations (file:line:content) ---"
    cat "$tmpdir/hits"
    files=$(cut -d: -f1 "$tmpdir/hits" | sort -u | tr '\n' ' ')
    fail "fork-identity regression: upstream token present in non-allowlist file(s): ${files% }"
fi

echo "PASS: no upstream fork-identity references outside the allowlist (arms 1+2, fail-closed guards clear)"
exit 0
