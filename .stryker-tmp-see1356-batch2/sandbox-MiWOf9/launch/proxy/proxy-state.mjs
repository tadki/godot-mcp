// @ts-nocheck
// proxy/proxy-state.mjs — SEE-1356 L5 (§SPEC-L5-01): the proxy state machine
// snapshot, persisted to disk at state TRANSITION points so godot-status /
// doctor can aggregate without a second truth source.
//
//   $GODOT_MCP_HOME/godot-editor/<runtime_id>.proxy-state.json   (slot form)
//   $GODOT_MCP_HOME/godot-editor/godot-editor-<label>.proxy-state.json (legacy)
//
// Naming follows the persistGiveUpStatus dual-form rule (runtime_id 键，port
// 键被否决：rebind 后 port 键会留尸体文件，新 runtime 读到旧快照 — plan 终裁).
// Write discipline: tmp + rename atomic publish, append-only-free (distinct
// from the L6 log tee), best-effort — a write failure is logged and NEVER
// thrown (observability must not break the call path). stderr_tail is
// deliberately NOT part of the snapshot: the evidence chain for stderr lives
// in the L6 proxy log, not here.
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
import { mkdirSync, writeFileSync, renameSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import { GODOT_MCP_HOME, GODOT_PORT, RUNTIME_ID } from './config.mjs';
import { warmupDiagnostic } from './diagnostics.mjs';
import { resolveWorkdirHash } from './workdir-hash.mjs';
import { isSlotRuntimeId, legacyFormName } from './runtime-id.mjs';
import { log } from './log.mjs';
export const PROXY_STATE_SCHEMA = stryMutAct_9fa48("126") ? "" : (stryCov_9fa48("126"), 'see1356-l5-proxy-state/1');
export const SNAPSHOT_MAX_BYTES = stryMutAct_9fa48("127") ? 8 / 1024 : (stryCov_9fa48("127"), 8 * 1024);
export const TRANSITION_HISTORY_MAX = 10;
export const RECENT_CALL_HISTORY_MAX = 10;
// Heartbeat refresh cadence (spec: heartbeat_at 30s 刷新) — decoupled from the
// 2s registry heartbeat so the snapshot write rate stays low.
export const HEARTBEAT_PERSIST_MS = 30000;
const LEGACY_LABEL = legacyFormName();
function proxyStateDir() {
  if (stryMutAct_9fa48("128")) {
    {}
  } else {
    stryCov_9fa48("128");
    return path.join(GODOT_MCP_HOME, stryMutAct_9fa48("129") ? "" : (stryCov_9fa48("129"), 'godot-editor'));
  }
}

// The giveup-file naming rule (SSOT: isSlotRuntimeId / legacyFormName): a real
// slot runtime_id uses the per-slot directory form; -solo / manual runs fall
// back to the legacy flat name so the two families never collide.
export function proxyStatePathFor(runtimeId = RUNTIME_ID) {
  if (stryMutAct_9fa48("130")) {
    {}
  } else {
    stryCov_9fa48("130");
    const dir = proxyStateDir();
    return isSlotRuntimeId(runtimeId) ? path.join(dir, stryMutAct_9fa48("131") ? `` : (stryCov_9fa48("131"), `${runtimeId}.proxy-state.json`)) : path.join(dir, stryMutAct_9fa48("132") ? `` : (stryCov_9fa48("132"), `godot-editor-${LEGACY_LABEL}.proxy-state.json`));
  }
}

// Current coarse state, same vocabulary godot-status/doctor consume.
// SEE-1356 D2 (批 1 QA FAIL 裁定) vocabulary/priority correction:
//   failed_exit = the TERMINAL family — the legacy T4 latch (S.warmupTimedOut)
//   OR an armed give-up (spawn-terminal FAILED_CLEAN, WS-5: S.spawnTerminal /
//   S.giveUpArmedAt > 0). Derived read-side only — the state-machine fields
//   stay the SSOT, no behavior delta at any write site.
//   recovering outranks warm: in the warm+recovering form (T2 warm branch —
//   editor bound but the CLI never connected) the operative warmup state IS
//   RECOVERING; the previous warm-first priority made the doctor
//   (recovering,*) arbitration rows unreachable on real chains.
export function proxyCoarseState() {
  if (stryMutAct_9fa48("133")) {
    {}
  } else {
    stryCov_9fa48("133");
    if (stryMutAct_9fa48("136") ? (S.warmupTimedOut || S.spawnTerminal) && S.giveUpArmedAt > 0 : stryMutAct_9fa48("135") ? false : stryMutAct_9fa48("134") ? true : (stryCov_9fa48("134", "135", "136"), (stryMutAct_9fa48("138") ? S.warmupTimedOut && S.spawnTerminal : stryMutAct_9fa48("137") ? false : (stryCov_9fa48("137", "138"), S.warmupTimedOut || S.spawnTerminal)) || (stryMutAct_9fa48("141") ? S.giveUpArmedAt <= 0 : stryMutAct_9fa48("140") ? S.giveUpArmedAt >= 0 : stryMutAct_9fa48("139") ? false : (stryCov_9fa48("139", "140", "141"), S.giveUpArmedAt > 0)))) return stryMutAct_9fa48("142") ? "" : (stryCov_9fa48("142"), 'failed_exit');
    if (stryMutAct_9fa48("144") ? false : stryMutAct_9fa48("143") ? true : (stryCov_9fa48("143", "144"), S.recovering)) return stryMutAct_9fa48("145") ? "" : (stryCov_9fa48("145"), 'recovering');
    if (stryMutAct_9fa48("147") ? false : stryMutAct_9fa48("146") ? true : (stryCov_9fa48("146", "147"), S.warm)) return stryMutAct_9fa48("148") ? "" : (stryCov_9fa48("148"), 'warm');
    if (stryMutAct_9fa48("151") ? S.spawnTriggered && S.spawnInFlight : stryMutAct_9fa48("150") ? false : stryMutAct_9fa48("149") ? true : (stryCov_9fa48("149", "150", "151"), S.spawnTriggered || S.spawnInFlight)) return stryMutAct_9fa48("152") ? "" : (stryCov_9fa48("152"), 'warming');
    return stryMutAct_9fa48("153") ? "" : (stryCov_9fa48("153"), 'cold_idle');
  }
}

// rememberWorkdirSnapshot(): SEE-1356 L2 (§SPEC-L2-03) — the (runtime_id,
// worktree, workdir_hash) triple is computed ONCE per process at spawn time
// and stamped into every snapshot. The hash comes from the bash SSOT
// (kol_workdir_hash); a resolution failure stores the null + snapshot_absent
// degradation, never a locally-derived hash.
export function rememberWorkdirSnapshot() {
  if (stryMutAct_9fa48("154")) {
    {}
  } else {
    stryCov_9fa48("154");
    if (stryMutAct_9fa48("156") ? false : stryMutAct_9fa48("155") ? true : (stryCov_9fa48("155", "156"), S.workdirSnapshot)) return S.workdirSnapshot;
    const worktree = stryMutAct_9fa48("159") ? (process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE) && '' : stryMutAct_9fa48("158") ? false : stryMutAct_9fa48("157") ? true : (stryCov_9fa48("157", "158", "159"), (stryMutAct_9fa48("161") ? process.env.GODOT_MCP_WORKTREE && process.env.KOL_WORKTREE : stryMutAct_9fa48("160") ? false : (stryCov_9fa48("160", "161"), process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE)) || (stryMutAct_9fa48("162") ? "Stryker was here!" : (stryCov_9fa48("162"), '')));
    const resolved = worktree ? resolveWorkdirHash(worktree) : null;
    S.workdirSnapshot = stryMutAct_9fa48("163") ? {} : (stryCov_9fa48("163"), {
      runtime_id: stryMutAct_9fa48("166") ? RUNTIME_ID && null : stryMutAct_9fa48("165") ? false : stryMutAct_9fa48("164") ? true : (stryCov_9fa48("164", "165", "166"), RUNTIME_ID || null),
      worktree: stryMutAct_9fa48("169") ? worktree && null : stryMutAct_9fa48("168") ? false : stryMutAct_9fa48("167") ? true : (stryCov_9fa48("167", "168", "169"), worktree || null),
      workdir_hash: resolved ? resolved.workdir_hash : null,
      hash_source: resolved ? resolved.hash_source : null
    });
    return S.workdirSnapshot;
  }
}

// recordProxyTransition(trigger, detail): one entry in last_transitions
// (capped) + an immediate snapshot persist — the transition point IS the
// write trigger (T1/T2/T4/spawn_terminal/lease_exit/rearm call sites).
export function recordProxyTransition(trigger, detail = stryMutAct_9fa48("170") ? "Stryker was here!" : (stryCov_9fa48("170"), '')) {
  if (stryMutAct_9fa48("171")) {
    {}
  } else {
    stryCov_9fa48("171");
    // S.lastTransitions is fully initialized by state.mjs — no fallback chain
    // here (SEE-1356 batch-2 cleanup, hardener observation ②: defensive
    // residues under the no-defensive-programming rule).
    const list = S.lastTransitions;
    list.push(stryMutAct_9fa48("173") ? {} : (stryCov_9fa48("173"), {
      at: new Date().toISOString(),
      trigger,
      state: proxyCoarseState(),
      stage: S.stage,
      ...(detail ? stryMutAct_9fa48("174") ? {} : (stryCov_9fa48("174"), {
        detail: stryMutAct_9fa48("175") ? String(detail) : (stryCov_9fa48("175"), String(detail).slice(0, 200))
      }) : {})
    }));
    if (stryMutAct_9fa48("179") ? list.length <= TRANSITION_HISTORY_MAX : stryMutAct_9fa48("178") ? list.length >= TRANSITION_HISTORY_MAX : stryMutAct_9fa48("177") ? false : stryMutAct_9fa48("176") ? true : (stryCov_9fa48("176", "177", "178", "179"), list.length > TRANSITION_HISTORY_MAX)) list.splice(0, stryMutAct_9fa48("181") ? list.length + TRANSITION_HISTORY_MAX : (stryCov_9fa48("181"), list.length - TRANSITION_HISTORY_MAX));
    if (stryMutAct_9fa48("182")) {
      ;
    } else {
      stryCov_9fa48("182");
      persistProxyState(trigger);
    }
  }
}

// noteProxyCallSummary(msg, kind): held/rejected call summaries — tool name +
// argument KEY NAMES + value lengths only; values never enter the snapshot.
export function noteProxyCallSummary(msg, kind) {
  if (stryMutAct_9fa48("183")) {
    {}
  } else {
    stryCov_9fa48("183");
    try {
      if (stryMutAct_9fa48("184")) {
        {}
      } else {
        stryCov_9fa48("184");
        const params = stryMutAct_9fa48("187") ? msg || msg.params : stryMutAct_9fa48("186") ? false : stryMutAct_9fa48("185") ? true : (stryCov_9fa48("185", "186", "187"), msg && msg.params);
        const name = (stryMutAct_9fa48("190") ? typeof (params && params.name) !== 'string' : stryMutAct_9fa48("189") ? false : stryMutAct_9fa48("188") ? true : (stryCov_9fa48("188", "189", "190"), typeof (stryMutAct_9fa48("193") ? params || params.name : stryMutAct_9fa48("192") ? false : stryMutAct_9fa48("191") ? true : (stryCov_9fa48("191", "192", "193"), params && params.name)) === (stryMutAct_9fa48("194") ? "" : (stryCov_9fa48("194"), 'string')))) ? params.name : stryMutAct_9fa48("195") ? "" : (stryCov_9fa48("195"), '<unknown>');
        const args = stryMutAct_9fa48("198") ? params && params.arguments && {} : stryMutAct_9fa48("197") ? false : stryMutAct_9fa48("196") ? true : (stryCov_9fa48("196", "197", "198"), (stryMutAct_9fa48("200") ? params || params.arguments : stryMutAct_9fa48("199") ? false : (stryCov_9fa48("199", "200"), params && params.arguments)) || {});
        const keys = stryMutAct_9fa48("201") ? Object.keys(args) : (stryCov_9fa48("201"), Object.keys(args).slice(0, 12));
        const list = S.recentProxyCalls;
        list.push(stryMutAct_9fa48("203") ? {} : (stryCov_9fa48("203"), {
          at: new Date().toISOString(),
          kind: (stryMutAct_9fa48("206") ? kind !== 'held' : stryMutAct_9fa48("205") ? false : stryMutAct_9fa48("204") ? true : (stryCov_9fa48("204", "205", "206"), kind === (stryMutAct_9fa48("207") ? "" : (stryCov_9fa48("207"), 'held')))) ? stryMutAct_9fa48("208") ? "" : (stryCov_9fa48("208"), 'held') : stryMutAct_9fa48("209") ? "" : (stryCov_9fa48("209"), 'rejected'),
          tool: name,
          arg_keys: keys,
          arg_lens: keys.map(k => {
            if (stryMutAct_9fa48("210")) {
              {}
            } else {
              stryCov_9fa48("210");
              const v = args[k];
              if (stryMutAct_9fa48("213") ? typeof v !== 'string' : stryMutAct_9fa48("212") ? false : stryMutAct_9fa48("211") ? true : (stryCov_9fa48("211", "212", "213"), typeof v === (stryMutAct_9fa48("214") ? "" : (stryCov_9fa48("214"), 'string')))) return v.length;
              if (stryMutAct_9fa48("217") ? v === null && v === undefined : stryMutAct_9fa48("216") ? false : stryMutAct_9fa48("215") ? true : (stryCov_9fa48("215", "216", "217"), (stryMutAct_9fa48("219") ? v !== null : stryMutAct_9fa48("218") ? false : (stryCov_9fa48("218", "219"), v === null)) || (stryMutAct_9fa48("221") ? v !== undefined : stryMutAct_9fa48("220") ? false : (stryCov_9fa48("220", "221"), v === undefined)))) return 0;
              return JSON.stringify(v).length;
            }
          })
        }));
        if (stryMutAct_9fa48("225") ? list.length <= RECENT_CALL_HISTORY_MAX : stryMutAct_9fa48("224") ? list.length >= RECENT_CALL_HISTORY_MAX : stryMutAct_9fa48("223") ? false : stryMutAct_9fa48("222") ? true : (stryCov_9fa48("222", "223", "224", "225"), list.length > RECENT_CALL_HISTORY_MAX)) list.splice(0, stryMutAct_9fa48("227") ? list.length + RECENT_CALL_HISTORY_MAX : (stryCov_9fa48("227"), list.length - RECENT_CALL_HISTORY_MAX));
      }
    } catch {/* summary is best-effort; never surface */}
  }
}

// fitSnapshotWithin(doc, maxBytes): pure size budget — drop order is chosen
// so the evidence value degrades from the least to the most diagnostic:
// stageTimestamps → recent call summaries → warmupDiagnostic → transitions.
// A doc that STILL exceeds the budget after all drops is hard-sliced with an
// explicit truncated marker (never silently under-reported).
export function fitSnapshotWithin(doc, maxBytes = SNAPSHOT_MAX_BYTES) {
  if (stryMutAct_9fa48("228")) {
    {}
  } else {
    stryCov_9fa48("228");
    const dropOrder = stryMutAct_9fa48("229") ? [] : (stryCov_9fa48("229"), [stryMutAct_9fa48("230") ? "" : (stryCov_9fa48("230"), 'stageTimestamps'), stryMutAct_9fa48("231") ? "" : (stryCov_9fa48("231"), 'recent_calls'), stryMutAct_9fa48("232") ? "" : (stryCov_9fa48("232"), 'warmupDiagnostic'), stryMutAct_9fa48("233") ? "" : (stryCov_9fa48("233"), 'last_transitions')]);
    let out = stryMutAct_9fa48("234") ? {} : (stryCov_9fa48("234"), {
      ...doc
    });
    const size = stryMutAct_9fa48("235") ? () => undefined : (stryCov_9fa48("235"), (() => {
      const size = o => Buffer.byteLength(JSON.stringify(o), stryMutAct_9fa48("236") ? "" : (stryCov_9fa48("236"), 'utf8'));
      return size;
    })());
    for (const key of dropOrder) {
      if (stryMutAct_9fa48("237")) {
        {}
      } else {
        stryCov_9fa48("237");
        if (stryMutAct_9fa48("241") ? size(out) > maxBytes : stryMutAct_9fa48("240") ? size(out) < maxBytes : stryMutAct_9fa48("239") ? false : stryMutAct_9fa48("238") ? true : (stryCov_9fa48("238", "239", "240", "241"), size(out) <= maxBytes)) break;
        if (stryMutAct_9fa48("244") ? false : stryMutAct_9fa48("243") ? true : stryMutAct_9fa48("242") ? key in out : (stryCov_9fa48("242", "243", "244"), !(key in out))) continue;
        const rest = stryMutAct_9fa48("245") ? {} : (stryCov_9fa48("245"), {
          ...out
        });
        delete rest[key];
        out = stryMutAct_9fa48("246") ? {} : (stryCov_9fa48("246"), {
          ...rest,
          dropped_fields: stryMutAct_9fa48("247") ? [] : (stryCov_9fa48("247"), [...(stryMutAct_9fa48("250") ? out.dropped_fields && [] : stryMutAct_9fa48("249") ? false : stryMutAct_9fa48("248") ? true : (stryCov_9fa48("248", "249", "250"), out.dropped_fields || (stryMutAct_9fa48("251") ? ["Stryker was here"] : (stryCov_9fa48("251"), [])))), key])
        });
      }
    }
    if (stryMutAct_9fa48("255") ? size(out) > maxBytes : stryMutAct_9fa48("254") ? size(out) < maxBytes : stryMutAct_9fa48("253") ? false : stryMutAct_9fa48("252") ? true : (stryCov_9fa48("252", "253", "254", "255"), size(out) <= maxBytes)) return stryMutAct_9fa48("256") ? {} : (stryCov_9fa48("256"), {
      doc: out,
      truncated: stryMutAct_9fa48("260") ? out.dropped_fields?.length <= 0 : stryMutAct_9fa48("259") ? out.dropped_fields?.length >= 0 : stryMutAct_9fa48("258") ? false : stryMutAct_9fa48("257") ? true : (stryCov_9fa48("257", "258", "259", "260"), (stryMutAct_9fa48("261") ? out.dropped_fields.length : (stryCov_9fa48("261"), out.dropped_fields?.length)) > 0)
    });
    return stryMutAct_9fa48("262") ? {} : (stryCov_9fa48("262"), {
      doc: stryMutAct_9fa48("263") ? {} : (stryCov_9fa48("263"), {
        schema: out.schema,
        runtime_id: out.runtime_id,
        state: out.state,
        truncated: stryMutAct_9fa48("264") ? false : (stryCov_9fa48("264"), true),
        dropped_fields: stryMutAct_9fa48("265") ? [] : (stryCov_9fa48("265"), [...(stryMutAct_9fa48("268") ? out.dropped_fields && [] : stryMutAct_9fa48("267") ? false : stryMutAct_9fa48("266") ? true : (stryCov_9fa48("266", "267", "268"), out.dropped_fields || (stryMutAct_9fa48("269") ? ["Stryker was here"] : (stryCov_9fa48("269"), [])))), stryMutAct_9fa48("270") ? "" : (stryCov_9fa48("270"), 'overflow_hard_slice')])
      }),
      truncated: stryMutAct_9fa48("271") ? false : (stryCov_9fa48("271"), true)
    });
  }
}

// persistProxyState(trigger): build the full snapshot doc and publish it.
// Fire-and-forget by contract: any failure is logged, never thrown.
export function persistProxyState(trigger = stryMutAct_9fa48("272") ? "" : (stryCov_9fa48("272"), 'unspecified')) {
  if (stryMutAct_9fa48("273")) {
    {}
  } else {
    stryCov_9fa48("273");
    try {
      if (stryMutAct_9fa48("274")) {
        {}
      } else {
        stryCov_9fa48("274");
        const now = Date.now();
        const snap = rememberWorkdirSnapshot();
        const doc = stryMutAct_9fa48("275") ? {} : (stryCov_9fa48("275"), {
          schema: PROXY_STATE_SCHEMA,
          updated_at: new Date(now).toISOString(),
          trigger: String(trigger),
          runtime_id: snap.runtime_id,
          worktree: snap.worktree,
          workdir_hash: snap.workdir_hash,
          hash_source: snap.hash_source,
          state: proxyCoarseState(),
          stage: S.stage,
          port: stryMutAct_9fa48("278") ? GODOT_PORT && null : stryMutAct_9fa48("277") ? false : stryMutAct_9fa48("276") ? true : (stryCov_9fa48("276", "277", "278"), GODOT_PORT || null),
          pid: process.pid,
          elapsed_ms: stryMutAct_9fa48("279") ? now + (S.spawnStartedAt || S.startedAt) : (stryCov_9fa48("279"), now - (stryMutAct_9fa48("282") ? S.spawnStartedAt && S.startedAt : stryMutAct_9fa48("281") ? false : stryMutAct_9fa48("280") ? true : (stryCov_9fa48("280", "281", "282"), S.spawnStartedAt || S.startedAt))),
          hold_queue_depth: S.pendingCalls.length,
          spawn_attempts: S.spawnAttempts,
          spawn_failed_streak: S.spawnFailedStreak,
          last_error_bucket: stryMutAct_9fa48("285") ? S.spawnFailedBucket && null : stryMutAct_9fa48("284") ? false : stryMutAct_9fa48("283") ? true : (stryCov_9fa48("283", "284", "285"), S.spawnFailedBucket || null),
          give_up_count: S.giveUpCount,
          warm: stryMutAct_9fa48("288") ? S.warm !== true : stryMutAct_9fa48("287") ? false : stryMutAct_9fa48("286") ? true : (stryCov_9fa48("286", "287", "288"), S.warm === (stryMutAct_9fa48("289") ? false : (stryCov_9fa48("289"), true))),
          warmupDiagnostic: warmupDiagnostic(),
          last_transitions: stryMutAct_9fa48("290") ? [] : (stryCov_9fa48("290"), [...S.lastTransitions]),
          recent_calls: stryMutAct_9fa48("291") ? [] : (stryCov_9fa48("291"), [...S.recentProxyCalls]),
          heartbeat_at: new Date(now).toISOString()
        });
        const {
          doc: fitted
        } = fitSnapshotWithin(doc);
        const file = proxyStatePathFor();
        mkdirSync(path.dirname(file), stryMutAct_9fa48("293") ? {} : (stryCov_9fa48("293"), {
          recursive: stryMutAct_9fa48("294") ? false : (stryCov_9fa48("294"), true)
        }));
        const tmp = stryMutAct_9fa48("295") ? `` : (stryCov_9fa48("295"), `${file}.tmp.${process.pid}`);
        writeFileSync(tmp, JSON.stringify(fitted, null, 2) + (stryMutAct_9fa48("297") ? "" : (stryCov_9fa48("297"), '\n')), stryMutAct_9fa48("298") ? "" : (stryCov_9fa48("298"), 'utf8'));
        if (stryMutAct_9fa48("299")) {
          ;
        } else {
          stryCov_9fa48("299");
          renameSync(tmp, file);
        }
        S.lastProxyStatePersistMs = now;
        return file;
      }
    } catch (err) {
      if (stryMutAct_9fa48("300")) {
        {}
      } else {
        stryCov_9fa48("300");
        log(stryMutAct_9fa48("302") ? `` : (stryCov_9fa48("302"), `WARNING: persistProxyState failed: ${stryMutAct_9fa48("305") ? err || err.message : stryMutAct_9fa48("304") ? false : stryMutAct_9fa48("303") ? true : (stryCov_9fa48("303", "304", "305"), err && err.message)}`));
        return null;
      }
    }
  }
}

// maybePersistProxyHeartbeat(): 30s-throttled heartbeat refresh. Called from
// the steady-state heartbeat interval; the FIRST call persists too, so a
// warming runtime still lands an early snapshot even before its first
// transition-triggered write.
export function maybePersistProxyHeartbeat() {
  if (stryMutAct_9fa48("306")) {
    {}
  } else {
    stryCov_9fa48("306");
    const now = Date.now();
    if (stryMutAct_9fa48("309") ? S.lastProxyStatePersistMs || now - S.lastProxyStatePersistMs < HEARTBEAT_PERSIST_MS : stryMutAct_9fa48("308") ? false : stryMutAct_9fa48("307") ? true : (stryCov_9fa48("307", "308", "309"), S.lastProxyStatePersistMs && (stryMutAct_9fa48("312") ? now - S.lastProxyStatePersistMs >= HEARTBEAT_PERSIST_MS : stryMutAct_9fa48("311") ? now - S.lastProxyStatePersistMs <= HEARTBEAT_PERSIST_MS : stryMutAct_9fa48("310") ? true : (stryCov_9fa48("310", "311", "312"), (stryMutAct_9fa48("313") ? now + S.lastProxyStatePersistMs : (stryCov_9fa48("313"), now - S.lastProxyStatePersistMs)) < HEARTBEAT_PERSIST_MS)))) return;
    persistProxyState(stryMutAct_9fa48("315") ? "" : (stryCov_9fa48("315"), 'heartbeat'));
  }
}

// readProxyStateSnapshot(): reader for the get_info echo (§SPEC-L2-03) and
// tests. Returns the parsed doc, or null when the snapshot is absent or
// unparseable — the CALLER (not this module) turns null into the
// { workdir_hash: null, hash_source: 'snapshot_absent' } wire semantics.
export function readProxyStateSnapshot(runtimeId = RUNTIME_ID) {
  if (stryMutAct_9fa48("316")) {
    {}
  } else {
    stryCov_9fa48("316");
    const file = proxyStatePathFor(runtimeId);
    try {
      if (stryMutAct_9fa48("317")) {
        {}
      } else {
        stryCov_9fa48("317");
        if (stryMutAct_9fa48("318")) {
          ;
        } else {
          stryCov_9fa48("318");
          statSync(file);
        }
      }
    } catch {
      if (stryMutAct_9fa48("319")) {
        {}
      } else {
        stryCov_9fa48("319");
        return null;
      }
    }
    try {
      if (stryMutAct_9fa48("320")) {
        {}
      } else {
        stryCov_9fa48("320");
        return JSON.parse(readFileSync(file, stryMutAct_9fa48("321") ? "" : (stryCov_9fa48("321"), 'utf8')));
      }
    } catch {
      if (stryMutAct_9fa48("322")) {
        {}
      } else {
        stryCov_9fa48("322");
        return null;
      }
    }
  }
}

// get_info echo payload (§SPEC-L2-03): snapshot present → the stored triple;
// absent → workdir_hash null + hash_source 'snapshot_absent' (null = unknown,
// never "no hash").
// LOW1 (Final Review): "present" is the explicit snapshot-schema contract —
// workdir_hash and worktree are both ALWAYS written by persistProxyState, so
// both keys being defined is the presence test. A doc missing either key is
// not a workdir snapshot in any producible form; reading triple fields off it
// would echo fabricated nulls as if they were snapshot evidence.
export function workdirEchoForGetInfo(runtimeId = RUNTIME_ID) {
  if (stryMutAct_9fa48("323")) {
    {}
  } else {
    stryCov_9fa48("323");
    const snap = readProxyStateSnapshot(runtimeId);
    if (stryMutAct_9fa48("326") ? snap && snap.workdir_hash !== undefined || snap.worktree !== undefined : stryMutAct_9fa48("325") ? false : stryMutAct_9fa48("324") ? true : (stryCov_9fa48("324", "325", "326"), (stryMutAct_9fa48("328") ? snap || snap.workdir_hash !== undefined : stryMutAct_9fa48("327") ? true : (stryCov_9fa48("327", "328"), snap && (stryMutAct_9fa48("330") ? snap.workdir_hash === undefined : stryMutAct_9fa48("329") ? true : (stryCov_9fa48("329", "330"), snap.workdir_hash !== undefined)))) && (stryMutAct_9fa48("332") ? snap.worktree === undefined : stryMutAct_9fa48("331") ? true : (stryCov_9fa48("331", "332"), snap.worktree !== undefined)))) {
      if (stryMutAct_9fa48("333")) {
        {}
      } else {
        stryCov_9fa48("333");
        return stryMutAct_9fa48("334") ? {} : (stryCov_9fa48("334"), {
          runtime_id: stryMutAct_9fa48("335") ? snap.runtime_id && null : (stryCov_9fa48("335"), snap.runtime_id ?? null),
          worktree: stryMutAct_9fa48("336") ? snap.worktree && null : (stryCov_9fa48("336"), snap.worktree ?? null),
          workdir_hash: stryMutAct_9fa48("337") ? snap.workdir_hash && null : (stryCov_9fa48("337"), snap.workdir_hash ?? null),
          hash_source: stryMutAct_9fa48("338") ? snap.hash_source && null : (stryCov_9fa48("338"), snap.hash_source ?? null)
        });
      }
    }
    return stryMutAct_9fa48("339") ? {} : (stryCov_9fa48("339"), {
      runtime_id: null,
      worktree: null,
      workdir_hash: null,
      hash_source: stryMutAct_9fa48("340") ? "" : (stryCov_9fa48("340"), 'snapshot_absent')
    });
  }
}