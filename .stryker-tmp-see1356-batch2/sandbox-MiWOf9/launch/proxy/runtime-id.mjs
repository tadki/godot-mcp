// @ts-nocheck
// proxy/runtime-id.mjs — the slot-form runtime_id predicate, single source of
// truth (SEE-1356 batch-2 cleanup, hardener observation ③: the dual-form
// naming rule was hand-copied as the same regex in giveup/log/proxy-state).
//
// A real slot runtime_id looks like `<label>-<8..12 hex>` (the
// mcp_runtime_id_regex family); the '*' wildcard, -solo/manual runs and empty
// values fall back to the legacy flat name so the two file families never
// collide (SEE-1240 WS-5 / L5 / L6 all share this rule).
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
import process from 'node:process';
export const SLOT_RUNTIME_ID_RE = stryMutAct_9fa48("347") ? /^[A-Za-z][A-Za-z0-9_-]*-[^0-9a-f]{8,12}$/ : stryMutAct_9fa48("346") ? /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]$/ : stryMutAct_9fa48("345") ? /^[A-Za-z][^A-Za-z0-9_-]*-[0-9a-f]{8,12}$/ : stryMutAct_9fa48("344") ? /^[A-Za-z][A-Za-z0-9_-]-[0-9a-f]{8,12}$/ : stryMutAct_9fa48("343") ? /^[^A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/ : stryMutAct_9fa48("342") ? /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}/ : stryMutAct_9fa48("341") ? /[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/ : (stryCov_9fa48("341", "342", "343", "344", "345", "346", "347"), /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/);
export function isSlotRuntimeId(runtimeId) {
  if (stryMutAct_9fa48("348")) {
    {}
  } else {
    stryCov_9fa48("348");
    return stryMutAct_9fa48("351") ? Boolean(runtimeId) && runtimeId !== '*' && !runtimeId.endsWith('-solo') || SLOT_RUNTIME_ID_RE.test(runtimeId) : stryMutAct_9fa48("350") ? false : stryMutAct_9fa48("349") ? true : (stryCov_9fa48("349", "350", "351"), (stryMutAct_9fa48("353") ? Boolean(runtimeId) && runtimeId !== '*' || !runtimeId.endsWith('-solo') : stryMutAct_9fa48("352") ? true : (stryCov_9fa48("352", "353"), (stryMutAct_9fa48("355") ? Boolean(runtimeId) || runtimeId !== '*' : stryMutAct_9fa48("354") ? true : (stryCov_9fa48("354", "355"), Boolean(runtimeId) && (stryMutAct_9fa48("357") ? runtimeId === '*' : stryMutAct_9fa48("356") ? true : (stryCov_9fa48("356", "357"), runtimeId !== (stryMutAct_9fa48("358") ? "" : (stryCov_9fa48("358"), '*')))))) && (stryMutAct_9fa48("359") ? runtimeId.endsWith('-solo') : (stryCov_9fa48("359"), !(stryMutAct_9fa48("360") ? runtimeId.startsWith('-solo') : (stryCov_9fa48("360"), runtimeId.endsWith(stryMutAct_9fa48("361") ? "" : (stryCov_9fa48("361"), '-solo')))))))) && SLOT_RUNTIME_ID_RE.test(runtimeId));
  }
}

// legacyFormName(): the flat-name side of the same dual-form rule — the
// env-derived, lowercased label used by giveup/proxy-log/proxy-state legacy
// files. log.mjs / proxy-state.mjs stamp it at module load; spawn.mjs giveup
// reads it at call time — each site keeps its original read timing.
export function legacyFormName() {
  if (stryMutAct_9fa48("362")) {
    {}
  } else {
    stryCov_9fa48("362");
    return stryMutAct_9fa48("363") ? (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || 'unknown').toUpperCase() : (stryCov_9fa48("363"), (stryMutAct_9fa48("366") ? (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME) && 'unknown' : stryMutAct_9fa48("365") ? false : stryMutAct_9fa48("364") ? true : (stryCov_9fa48("364", "365", "366"), (stryMutAct_9fa48("368") ? process.env.GODOT_MCP_AGENT_NAME && process.env.KOL_AGENT_NAME : stryMutAct_9fa48("367") ? false : (stryCov_9fa48("367", "368"), process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME)) || (stryMutAct_9fa48("369") ? "" : (stryCov_9fa48("369"), 'unknown')))).toLowerCase());
  }
}