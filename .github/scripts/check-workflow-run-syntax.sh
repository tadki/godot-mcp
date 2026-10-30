#!/usr/bin/env bash
# SEE-1492 §SPEC-006 — static syntax gate for inline `run:` scripts in the
# GitHub workflow YAML.
#
# Why this gate exists: the SEE-1492 drift-watch break (a comment line inside
# an empty-list `for t in \` continuation swallowing the trailing `\`, leaving
# `; do` orphaned) was a shell syntax error inside a workflow `run:` block.
# No existing gate saw it — it is not a .sh file (so bash -n batches and
# lint:bash never touch it), and launch-special.yml is only schedule-triggered
# — so it sat red for a month. This gate parses the workflow YAML with a real
# YAML parser (no hand-rolled block-scalar scanning, so `|` literal, `>` folded
# and one-line run styles are all covered), extracts EVERY string-valued `run:`
# key anywhere in the document, substitutes `${{ ... }}` expressions with
# numbered placeholders (GHA templates are not shell; the surrounding quoting
# must still parse), and runs `bash -n` on each extracted script.
#
# Two detection arms, both per run block:
#   arm 1 — bash -n (parse errors)
#   arm 2 — backslash-at-EOL whose next line starts with a `#` comment. The
#           splice always destroys the continuation: either the remnants fail
#           to parse (the SEE-1492 drift-watch form) or the command silently
#           loses its arguments (parse-valid, invisible to bash -n). A comment
#           line can never legitimately sit inside a continuation, so this is
#           a zero-false-positive shape check.
#
# Known boundary: a `\` whose next line is a *non-comment* word list is a
# normal multi-line command — not decidable statically, not checked.
#
# Fail-closed policy — each of these is a gate failure, never a vacuous pass:
#   * no workflow files found to scan
#   * python3 / PyYAML unavailable
#   * a workflow file does not parse as YAML (including duplicate mapping keys,
#     which a last-wins parser would silently resolve while GitHub's parser
#     errors out)
#   * a `run:` value that is not a string (nothing to syntax-check)
#   * zero run blocks extracted in total, or launch-special.yml yielding zero
#     run blocks (extraction-parity guard: the file this gate exists for must
#     always contribute blocks)
#
# Known boundary: `bash -n` checks parseability. Backslash-continuation bugs
# that splice into a *parseable* command are out of scope for a syntax gate.
# A `${{ }}` expression containing `}}` inside its own quoted string would
# over-close the substitution and fail loud (none in this repo today).
#
# Usage: bash .github/scripts/check-workflow-run-syntax.sh [file.yml ...]
#        (default: every .yml/.yaml directly under .github/workflows/ of cwd)
set -uo pipefail

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

tmpdir=$(mktemp -d) || fail "mktemp failed"
trap 'rm -rf "$tmpdir"' EXIT

targets=()
if [ "$#" -gt 0 ]; then
    for f in "$@"; do
        [ -f "$f" ] || fail "target not found: $f"
        targets+=("$f")
    done
else
    for f in .github/workflows/*.yml .github/workflows/*.yaml; do
        [ -f "$f" ] && targets+=("$f")
    done
fi
[ "${#targets[@]}" -gt 0 ] || fail "no workflow files found to scan (looked in .github/workflows/ of cwd)"

command -v python3 >/dev/null 2>&1 || fail "python3 not available (gate is fail-closed)"
python3 -c 'import yaml' >/dev/null 2>&1 ||
    fail "PyYAML not importable — python3 -m pip install pyyaml (gate is fail-closed)"

python3 - "$tmpdir" "${targets[@]}" <<'PYEOF'
import itertools
import os
import re
import sys

import yaml

tmpdir = sys.argv[1]
targets = sys.argv[2:]
failures = []


class StrictLoader(yaml.SafeLoader):
    """SafeLoader that rejects duplicate mapping keys.

    A plain loader resolves duplicates last-wins, so the `run:` block an
    author thinks is live may not be the one that gets syntax-checked —
    GitHub's workflow parser errors out on duplicates instead, so parity
    here is fail-closed.
    """


def _construct_map_strict(loader, node, deep=False):
    loader.flatten_mapping(node)
    seen = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if isinstance(key, list):
            key = tuple(key)  # keep unhashable YAML keys from crashing the walk
        try:
            dup = key in seen
        except TypeError:
            dup = False
        if dup:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate mapping key: {key!r}", key_node.start_mark
            )
        seen[key] = value_node
    return {k: loader.construct_object(v, deep=deep) for k, v in seen.items()}


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_map_strict
)


def walk(node, path, out):
    if isinstance(node, dict):
        for k, v in node.items():
            kp = f"{path} :: {k}"
            if k == "run" and not isinstance(v, (dict, list)):
                if isinstance(v, str):
                    out.append((kp, v))
                else:
                    failures.append(f"{kp} -> run value is {type(v).__name__}, not a string (fail-closed)")
            else:
                walk(v, kp, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]", out)


os.makedirs(os.path.join(tmpdir, "blocks"), exist_ok=True)
manifest = os.path.join(tmpdir, "manifest.tsv")
splits_path = os.path.join(tmpdir, "splits.tsv")
counter = itertools.count(1)
total = 0
per_file = {}
# arm 2: `\` at EOL with a comment line inside the continuation
SPLITS = re.compile(r"\\\r?\n[ \t]*#")

with open(manifest, "w", encoding="utf-8") as sink, open(
    splits_path, "w", encoding="utf-8"
) as splits_out:
    for fname in targets:
        try:
            with open(fname, encoding="utf-8") as fh:
                doc = yaml.load(fh, Loader=StrictLoader)
        except Exception as exc:  # parse errors are fail-closed, not skip-and-continue
            failures.append(f"{fname}: YAML parse error: {exc}")
            continue
        blocks = []
        walk(doc, fname, blocks)
        per_file[fname] = len(blocks)
        total += len(blocks)
        for loc, script in blocks:
            idx = next(counter)
            # GHA expressions are not shell; replace each with a numbered,
            # identifier-shaped placeholder so quoting context stays intact.
            placeholders = itertools.count(1)
            subbed = re.sub(
                r"\$\{\{.*?\}\}",
                lambda m: f"__GHA_{next(placeholders)}__",
                script,
                flags=re.S,
            )
            block_path = os.path.join(tmpdir, "blocks", f"{idx:04d}.sh")
            with open(block_path, "w", encoding="utf-8") as bf:
                bf.write(subbed)
            sink.write(f"{idx:04d}\t{loc}\n")
            for m in SPLITS.finditer(script):
                line_no = script.count("\n", 0, m.start()) + 1
                splits_out.write(f"{idx:04d}\t{loc}\t{line_no}\n")

for fname, n in per_file.items():
    if fname.endswith("launch-special.yml") and n < 1:
        failures.append(
            f"{fname}: extracted 0 run blocks — extraction-parity guard tripped (fail-closed)"
        )
if total < 1:
    failures.append("total run blocks extracted = 0 across all targets (fail-closed)")

with open(os.path.join(tmpdir, "extract_failures.txt"), "w", encoding="utf-8") as ef:
    for line in failures:
        ef.write(line + "\n")
sys.exit(1 if failures else 0)
PYEOF
extract_rc=$?
if [ "$extract_rc" -ne 0 ]; then
    sed 's/^/EXTRACT-FAIL\t/' "$tmpdir/extract_failures.txt" >&2
    fail "run-block extraction reported failures (see EXTRACT-FAIL lines above)"
fi

pass=0
bad=0
bad_blocks=""
fail_log="$tmpdir/failures.txt"
: > "$fail_log"
note_block() { case "$bad_blocks" in *"|$1|"*) ;; *) bad_blocks="$bad_blocks|$1|";; esac; }

while IFS=$'\t' read -r idx loc; do
    if bash -n "$tmpdir/blocks/$idx.sh" 2>"$tmpdir/blocks/$idx.err"; then
        pass=$((pass + 1))
    else
        bad=$((bad + 1))
        note_block "$idx"
        {
            printf 'SYNTAX-FAIL\t%s\n' "$loc"
            sed 's/^/    /' "$tmpdir/blocks/$idx.err"
        } >> "$fail_log"
    fi
done < "$tmpdir/manifest.tsv"

if [ -s "$tmpdir/splits.tsv" ]; then
    while IFS=$'\t' read -r idx loc line_no; do
        bad=$((bad + 1))
        note_block "$idx"
        {
            printf 'SPLIT-FAIL\t%s (script line %s): a comment line sits inside a backslash\n' "$loc" "$line_no"
            printf '    continuation — the splice always destroys it (SEE-1492 drift-watch form:\n'
            printf '    either a bash syntax error, or the command silently loses its arguments)\n'
        } >> "$fail_log"
    done < "$tmpdir/splits.tsv"
fi

total_blocks=$(wc -l < "$tmpdir/manifest.tsv" | tr -d ' ')
failed_blocks=$(printf '%s' "$bad_blocks" | tr -cd '|' | wc -c | tr -d ' ')
failed_blocks=$((failed_blocks / 2))
echo "checked run blocks: $total_blocks (arm 1: bash -n after \${{ }} substitution; arm 2: continuation-comment scan)"
cat "$fail_log"
if [ "$bad" -gt 0 ]; then
    fail "$bad defect finding(s) across $failed_blocks run block(s)"
fi
echo "PASS: all inline run scripts in scanned workflow YAML passed the gate (bash -n + continuation-comment scan)"
exit 0
