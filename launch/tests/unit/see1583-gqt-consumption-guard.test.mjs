// SEE-1583 §SPEC-007 — godot-mcp 消费面 gqt v0.3.0 守护（Harti hardener）。
//
// 判据面：active 消费文件（workflows、tests/gd/README.md、.dev/tests/
// scripts/*.sh）不得出现旧一级调用形态（literal `gqt <old>` / `$GQT <old>`
// / `python3 -m godot_qa_toolkit.cli <old>` / 多空白分隔 / 旧名大小写
// 变体）。`gqt mutation` / `gqt measure coverage` / `gqt doctor` 等新四
// 入口形态不受影响。
//
// allowlist（不在扫描范围）：docs/ci-cache-matrix.md、
// docs/mutation-exemptions.md（dated 台账/豁免记录）、package-lock.json
// （依赖清单）、eslint/launch 内注释性提及。

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../..');

const OLD_NAMES = ['accept', 'canonical', 'canonical-diagnose',
  'attr-update', 'recipe', 'registry', 'arch', 'complexity', 'coverage',
  'parity', 'risk'];
const nameRe = `(?i:${OLD_NAMES.join('|')})`;
const prefixes = [
  String.raw`\bgqt\s+`,
  String.raw`\$[Gg][Qq][Tt]\s+`,
  String.raw`\bpython3?\s+-m\s+godot_qa_toolkit\.cli\s+`,
];
const OLD_INVOCATION = new RegExp(
  prefixes.map((p) => `${p}${nameRe}([^-a-z0-9]|$)`).join('|'));

const EXPLICIT_FILES = ['.github/workflows/ci.yml', 'tests/gd/README.md'];
const SCRIPT_DIR = '.dev/tests/scripts';

function scanTargets() {
  const files = EXPLICIT_FILES.map((rel) => path.join(ROOT, rel));
  const scriptDir = path.join(ROOT, SCRIPT_DIR);
  for (const name of readdirSync(scriptDir).sort()) {
    if (name.endsWith('.sh')) files.push(path.join(scriptDir, name));
  }
  return files;
}

describe('SEE-1583 gqt consumption guard', () => {
  it('active consumption files have no old top-level invocation forms',
    () => {
      const bad = [];
      for (const file of scanTargets()) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          if (OLD_INVOCATION.test(line)) {
            bad.push(`${path.relative(ROOT, file)}:${idx + 1}: `
              + `${line.trim().slice(0, 100)}`);
          }
        });
      }
      expect(bad, `old gqt invocation forms:\n${bad.slice(0, 20).join('\n')}`)
        .toEqual([]);
    });
});
