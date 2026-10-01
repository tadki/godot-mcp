// @ts-nocheck
// proxy/log.mjs — stderr logging helpers (extracted from godot-mcp-proxy.mjs,
// SEE-1334 Phase 0a). stageLog honors the KOL_STAGE_LOG kill switch and stamps
// [t=+Nms] against the proxy start time in shared state.
//
// SEE-1356 L6 (§SPEC-L6-01): daemon contexts swallow stderr ("stderr alone is
// swallowed", launcher 自评). log()/stageLog() are the SINGLE tee point: every
// line also appends to $GODOT_MCP_HOME/godot-editor/<runtime_id>.proxy.log.
//   - append-only file writes (the atomic-write family in state-file.mjs is a
//     different discipline — logs stream, state publishes);
//   - pid prefix on every line: a concurrent writer is attributable without
//     any file lock (bare-name, no locking);
//   - startup rotate: a log ≥5MB at proxy boot renames to `.1` (one
//     generation, keep-last) so long-lived daemons stay bounded;
//   - open failure → silent degrade to stderr-only (the tee must never break
//     the proxy);
//   - the tee carries ONLY log lines — stdout (the JSON-RPC channel) is never
//     written here, so no JSON-RPC can contaminate the file.
// Bare process.stderr.write audit (implementation-time checklist): the npx
// child-stream passthrough (npx.mjs) routes through teeStderrLine(); the
// config.mjs FATAL banner runs before this module is importable-by-state and
// stays stderr-only by design (no home/state dir may exist yet).
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { EOL } from 'node:os';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import { GODOT_MCP_HOME, GODOT_PORT, RUNTIME_ID, STAGE_LOG_ENABLED } from './config.mjs';
import { resolveWorkdirHash } from './workdir-hash.mjs';
import { isSlotRuntimeId, legacyFormName } from './runtime-id.mjs';
export const PROXY_LOG_ROTATE_BYTES = stryMutAct_9fa48("0") ? 5 * 1024 / 1024 : (stryCov_9fa48("0"), (stryMutAct_9fa48("1") ? 5 / 1024 : (stryCov_9fa48("1"), 5 * 1024)) * 1024);
const LEGACY_LABEL = legacyFormName();
const PID_TAG = stryMutAct_9fa48("2") ? `` : (stryCov_9fa48("2"), `[pid=${process.pid}]`);

// Lazy single open: an append fd held for the process lifetime. null = not
// initialized yet; false = open failed (silent stderr-only degrade).
let logFd = null;
let logPath = null;

// Naming rule (SSOT: isSlotRuntimeId / legacyFormName in runtime-id.mjs).
function proxyLogPath() {
  if (stryMutAct_9fa48("3")) {
    {}
  } else {
    stryCov_9fa48("3");
    const dir = path.join(GODOT_MCP_HOME, stryMutAct_9fa48("4") ? "" : (stryCov_9fa48("4"), 'godot-editor'));
    const file = isSlotRuntimeId(RUNTIME_ID) ? path.join(dir, stryMutAct_9fa48("5") ? `` : (stryCov_9fa48("5"), `${RUNTIME_ID}.proxy.log`)) : path.join(dir, stryMutAct_9fa48("6") ? `` : (stryCov_9fa48("6"), `godot-editor-${LEGACY_LABEL}.proxy.log`));
    return file;
  }
}

// rotateIfNeeded(): startup-time one-generation rotation (≥5MB → `.1`).
function rotateIfNeeded(file) {
  if (stryMutAct_9fa48("7")) {
    {}
  } else {
    stryCov_9fa48("7");
    try {
      if (stryMutAct_9fa48("8")) {
        {}
      } else {
        stryCov_9fa48("8");
        if (stryMutAct_9fa48("11") ? existsSync(file) || statSync(file).size >= PROXY_LOG_ROTATE_BYTES : stryMutAct_9fa48("10") ? false : stryMutAct_9fa48("9") ? true : (stryCov_9fa48("9", "10", "11"), existsSync(file) && (stryMutAct_9fa48("14") ? statSync(file).size < PROXY_LOG_ROTATE_BYTES : stryMutAct_9fa48("13") ? statSync(file).size > PROXY_LOG_ROTATE_BYTES : stryMutAct_9fa48("12") ? true : (stryCov_9fa48("12", "13", "14"), statSync(file).size >= PROXY_LOG_ROTATE_BYTES)))) {
          if (stryMutAct_9fa48("15")) {
            {}
          } else {
            stryCov_9fa48("15");
            try {
              if (stryMutAct_9fa48("16")) {
                {}
              } else {
                stryCov_9fa48("16");
                renameSync(file, stryMutAct_9fa48("18") ? `` : (stryCov_9fa48("18"), `${file}.1`));
              }
            } catch {/* a concurrent rotator won; append anyway */}
          }
        }
      }
    } catch {/* stat failure — append anyway */}
  }
}
function ensureProxyLogOpen() {
  if (stryMutAct_9fa48("19")) {
    {}
  } else {
    stryCov_9fa48("19");
    if (stryMutAct_9fa48("22") ? logFd === null : stryMutAct_9fa48("21") ? false : stryMutAct_9fa48("20") ? true : (stryCov_9fa48("20", "21", "22"), logFd !== null)) return stryMutAct_9fa48("25") ? logFd === false : stryMutAct_9fa48("24") ? false : stryMutAct_9fa48("23") ? true : (stryCov_9fa48("23", "24", "25"), logFd !== (stryMutAct_9fa48("26") ? true : (stryCov_9fa48("26"), false)));
    logPath = proxyLogPath();
    try {
      if (stryMutAct_9fa48("27")) {
        {}
      } else {
        stryCov_9fa48("27");
        if (stryMutAct_9fa48("28")) {
          ;
        } else {
          stryCov_9fa48("28");
          rotateIfNeeded(logPath);
        }
        mkdirSync(path.dirname(logPath), stryMutAct_9fa48("30") ? {} : (stryCov_9fa48("30"), {
          recursive: stryMutAct_9fa48("31") ? false : (stryCov_9fa48("31"), true)
        }));
        logFd = openSync(logPath, stryMutAct_9fa48("32") ? "" : (stryCov_9fa48("32"), 'a'));
        if (stryMutAct_9fa48("33")) {
          ;
        } else {
          stryCov_9fa48("33");
          writeStartupHeader();
        }
      }
    } catch {
      if (stryMutAct_9fa48("34")) {
        {}
      } else {
        stryCov_9fa48("34");
        logFd = stryMutAct_9fa48("35") ? true : (stryCov_9fa48("35"), false); // silent degrade — stderr-only logging continues
      }
    }
    return stryMutAct_9fa48("38") ? logFd === false : stryMutAct_9fa48("37") ? false : stryMutAct_9fa48("36") ? true : (stryCov_9fa48("36", "37", "38"), logFd !== (stryMutAct_9fa48("39") ? true : (stryCov_9fa48("39"), false)));
  }
}

// Startup header (§SPEC-L6-01): pid/port/worktree/workdir_hash — the hash via
// the L2 SSOT (workdir-hash.mjs), same 口径 as status/registry/get_info.
function writeStartupHeader() {
  if (stryMutAct_9fa48("40")) {
    {}
  } else {
    stryCov_9fa48("40");
    const worktree = stryMutAct_9fa48("43") ? (process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE) && '' : stryMutAct_9fa48("42") ? false : stryMutAct_9fa48("41") ? true : (stryCov_9fa48("41", "42", "43"), (stryMutAct_9fa48("45") ? process.env.GODOT_MCP_WORKTREE && process.env.KOL_WORKTREE : stryMutAct_9fa48("44") ? false : (stryCov_9fa48("44", "45"), process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE)) || (stryMutAct_9fa48("46") ? "Stryker was here!" : (stryCov_9fa48("46"), '')));
    let hashPart = stryMutAct_9fa48("47") ? "Stryker was here!" : (stryCov_9fa48("47"), '');
    try {
      if (stryMutAct_9fa48("48")) {
        {}
      } else {
        stryCov_9fa48("48");
        const resolved = worktree ? resolveWorkdirHash(worktree) : null;
        hashPart = resolved ? stryMutAct_9fa48("49") ? `` : (stryCov_9fa48("49"), ` workdir_hash=${resolved.workdir_hash} hash_source=${resolved.hash_source}`) : stryMutAct_9fa48("50") ? "" : (stryCov_9fa48("50"), ' workdir_hash=<unresolved>');
      }
    } catch {
      if (stryMutAct_9fa48("51")) {
        {}
      } else {
        stryCov_9fa48("51");
        hashPart = stryMutAct_9fa48("52") ? "" : (stryCov_9fa48("52"), ' workdir_hash=<unresolved>');
      }
    }
    writeTee(stryMutAct_9fa48("54") ? `` : (stryCov_9fa48("54"), `=== proxy start pid=${process.pid} port=${stryMutAct_9fa48("57") ? GODOT_PORT && '?' : stryMutAct_9fa48("56") ? false : stryMutAct_9fa48("55") ? true : (stryCov_9fa48("55", "56", "57"), GODOT_PORT || (stryMutAct_9fa48("58") ? "" : (stryCov_9fa48("58"), '?')))} worktree=${stryMutAct_9fa48("61") ? worktree && '<unresolved>' : stryMutAct_9fa48("60") ? false : stryMutAct_9fa48("59") ? true : (stryCov_9fa48("59", "60", "61"), worktree || (stryMutAct_9fa48("62") ? "" : (stryCov_9fa48("62"), '<unresolved>')))}${hashPart} ===`));
  }
}
function writeTee(line) {
  if (stryMutAct_9fa48("63")) {
    {}
  } else {
    stryCov_9fa48("63");
    if (stryMutAct_9fa48("66") ? logFd === null || !ensureProxyLogOpen() : stryMutAct_9fa48("65") ? false : stryMutAct_9fa48("64") ? true : (stryCov_9fa48("64", "65", "66"), (stryMutAct_9fa48("68") ? logFd !== null : stryMutAct_9fa48("67") ? true : (stryCov_9fa48("67", "68"), logFd === null)) && (stryMutAct_9fa48("69") ? ensureProxyLogOpen() : (stryCov_9fa48("69"), !ensureProxyLogOpen())))) return;
    if (stryMutAct_9fa48("72") ? logFd !== false : stryMutAct_9fa48("71") ? false : stryMutAct_9fa48("70") ? true : (stryCov_9fa48("70", "71", "72"), logFd === (stryMutAct_9fa48("73") ? true : (stryCov_9fa48("73"), false)))) return;
    try {
      if (stryMutAct_9fa48("74")) {
        {}
      } else {
        stryCov_9fa48("74");
        writeSync(logFd, stryMutAct_9fa48("76") ? `` : (stryCov_9fa48("76"), `${line}${EOL}`));
      }
    } catch {
      // A write failure (disk full, rotated-away fd) degrades silently —
      // never break the caller's logging path.
    }
  }
}
export function log(msg) {
  if (stryMutAct_9fa48("77")) {
    {}
  } else {
    stryCov_9fa48("77");
    // stderr keeps the EXACT legacy line shape — the SEE-1152 stage-log
    // contract test pins `[godot-mcp-proxy] ...` byte-for-byte. The pid tag
    // (L6 归因) rides ONLY the tee artifact, whose format is new.
    process.stderr.write(stryMutAct_9fa48("79") ? `` : (stryCov_9fa48("79"), `[godot-mcp-proxy] ${msg}${EOL}`));
    writeTee(stryMutAct_9fa48("81") ? `` : (stryCov_9fa48("81"), `[godot-mcp-proxy] ${PID_TAG} ${msg}`));
  }
}

// teeStderrLine(): the bare-stderr passthrough seams (npx child streams) use
// this so relayed child output lands in the tee too, with the same pid tag.
export function teeStderrLine(chunk) {
  if (stryMutAct_9fa48("82")) {
    {}
  } else {
    stryCov_9fa48("82");
    if (stryMutAct_9fa48("83")) {
      ;
    } else {
      stryCov_9fa48("83");
      process.stderr.write(chunk);
    }
    const text = (stryMutAct_9fa48("86") ? typeof chunk !== 'string' : stryMutAct_9fa48("85") ? false : stryMutAct_9fa48("84") ? true : (stryCov_9fa48("84", "85", "86"), typeof chunk === (stryMutAct_9fa48("87") ? "" : (stryCov_9fa48("87"), 'string')))) ? chunk : String(chunk);
    if (stryMutAct_9fa48("90") ? false : stryMutAct_9fa48("89") ? true : stryMutAct_9fa48("88") ? text.includes('\n') : (stryCov_9fa48("88", "89", "90"), !text.includes(stryMutAct_9fa48("91") ? "" : (stryCov_9fa48("91"), '\n')))) {
      if (stryMutAct_9fa48("92")) {
        {}
      } else {
        stryCov_9fa48("92");
        writeTee(stryMutAct_9fa48("94") ? `` : (stryCov_9fa48("94"), `[godot-mcp-proxy] ${PID_TAG} [npx] ${text}`));
        return;
      }
    }
    for (const line of text.split(stryMutAct_9fa48("95") ? /\r\n/ : (stryCov_9fa48("95"), /\r?\n/))) {
      if (stryMutAct_9fa48("96")) {
        {}
      } else {
        stryCov_9fa48("96");
        if (stryMutAct_9fa48("98") ? false : stryMutAct_9fa48("97") ? true : (stryCov_9fa48("97", "98"), line)) writeTee(stryMutAct_9fa48("100") ? `` : (stryCov_9fa48("100"), `[godot-mcp-proxy] ${PID_TAG} [npx] ${line}`));
      }
    }
  }
}

// SEE-1152 (Owner): end-to-end cold-start stage timing. Every emit carries
//   [stage=<NAME>]           machine-greppable stage token
//   [t=+Nms]                 milliseconds since proxy start (startedAt)
//   [ts=<iso8601>]           absolute wall-clock (UTC)
// Default ON (KOL_STAGE_LOG=off to silence). The stage names mirror the
// SEE-1110 warmup enum plus finer-grained spawn-path events the protocol
// cannot see (arbiterDecide, helper scripts, render-stable gate, npx CLI).
// Emitted to stderr AND the L6 tee — never to stdout, so the JSON-RPC channel
// stays clean. Tests can grep stderr for `stage=` lines without parsing stdout.
export function stageLog(stage, msg = stryMutAct_9fa48("101") ? "Stryker was here!" : (stryCov_9fa48("101"), '')) {
  if (stryMutAct_9fa48("102")) {
    {}
  } else {
    stryCov_9fa48("102");
    if (stryMutAct_9fa48("105") ? false : stryMutAct_9fa48("104") ? true : stryMutAct_9fa48("103") ? STAGE_LOG_ENABLED : (stryCov_9fa48("103", "104", "105"), !STAGE_LOG_ENABLED)) return;
    const now = Date.now();
    const rel = stryMutAct_9fa48("106") ? now + S.startedAt : (stryCov_9fa48("106"), now - S.startedAt);
    const iso = new Date(now).toISOString();
    const suffix = msg ? stryMutAct_9fa48("107") ? `` : (stryCov_9fa48("107"), ` ${msg}`) : stryMutAct_9fa48("108") ? "Stryker was here!" : (stryCov_9fa48("108"), '');
    // stderr = legacy contract shape verbatim; tee = pid-tagged twin (L6).
    const body = stryMutAct_9fa48("109") ? `` : (stryCov_9fa48("109"), `[stage=${stage}] [t=+${rel}ms] [ts=${iso}]${suffix}`);
    process.stderr.write(stryMutAct_9fa48("111") ? `` : (stryCov_9fa48("111"), `[godot-mcp-proxy] ${body}${EOL}`));
    writeTee(stryMutAct_9fa48("113") ? `` : (stryCov_9fa48("113"), `[godot-mcp-proxy] ${PID_TAG} ${body}`));
  }
}

// testSeams (unit use only): reset the lazy-open cache between cases.
export function resetProxyLogForTest() {
  if (stryMutAct_9fa48("114")) {
    {}
  } else {
    stryCov_9fa48("114");
    if (stryMutAct_9fa48("117") ? logFd !== null || logFd !== false : stryMutAct_9fa48("116") ? false : stryMutAct_9fa48("115") ? true : (stryCov_9fa48("115", "116", "117"), (stryMutAct_9fa48("119") ? logFd === null : stryMutAct_9fa48("118") ? true : (stryCov_9fa48("118", "119"), logFd !== null)) && (stryMutAct_9fa48("121") ? logFd === false : stryMutAct_9fa48("120") ? true : (stryCov_9fa48("120", "121"), logFd !== (stryMutAct_9fa48("122") ? true : (stryCov_9fa48("122"), false)))))) {
      if (stryMutAct_9fa48("123")) {
        {}
      } else {
        stryCov_9fa48("123");
        try {
          if (stryMutAct_9fa48("124")) {
            {}
          } else {
            stryCov_9fa48("124");
            if (stryMutAct_9fa48("125")) {
              ;
            } else {
              stryCov_9fa48("125");
              closeSync(logFd);
            }
          }
        } catch {/* already closed */}
      }
    }
    logFd = null;
    logPath = null;
  }
}
export { proxyLogPath, ensureProxyLogOpen, rotateIfNeeded, writeTee };