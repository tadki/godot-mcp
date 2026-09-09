// SEE-1240 WS-6 (C11 一期) — exec constraint SSOT: one declarative list feeding
// all three consumption surfaces so they can never drift apart:
//   1. tool description — godot_exec's tools/list description gains the live
//      list via a string-anchored patch (see EXEC_DESCRIPTION_PATCH).
//   2. 报错预检 — the proxy pre-checks every godot_exec run source BEFORE
//      forwarding (precheckExecSource); a violating call is answered in-band
//      naming the violated entries, and never reaches the fork/addon.
//   3. exec_help — {name:'godot_exec', arguments:{action:'help'}} is answered
//      in-band by the proxy with the full constraint digest (the fork schema
//      has no help action; the proxy intercepts before fork-side validation).
//
// The authoritative ENFORCEMENT remains the vendored addon's
// MCPExecGuard (addons/godot_mcp/game_bridge/mcp_exec_guard.gd) — this module
// MIRRORS its DENYLIST + SYNC_ONLY(await) semantics, and
// test_see1240_exec_constraints asserts list parity against the .gd source so
// the two can never drift silently.
//
// The pre-check's lexer is a faithful port of MCPExecGuard._lex (comment
// removal, string-CONTENT removal with quotes kept, escape handling, the
// known raw-string miss) so the proxy never blocks a source the addon would
// accept on the common paths; where they diverge the addon stays the final
// word (a proxy MISS still gets caught in-band by the addon's DENIED_TOKEN,
// which the response path annotates with the digest).

// Mirrors MCPExecGuard.DENYLIST (vendored addon). Category groups are
// presentational (help/description rendering) — matching is per-token.
export const EXEC_CONSTRAINTS = [
    { token: 'OS.execute', category: 'process', summary: 'spawn a process' },
    { token: 'OS.execute_with_pipe', category: 'process', summary: 'spawn a process with pipes' },
    { token: 'OS.create_process', category: 'process', summary: 'create a process' },
    { token: 'OS.create_instance', category: 'process', summary: 'launch an instance of the project' },
    { token: 'OS.kill', category: 'process', summary: 'kill a process by PID' },
    { token: 'OS.shell_open', category: 'process', summary: 'open a URL/path via the OS shell' },
    { token: 'OS.shell_show_in_file_manager', category: 'process', summary: 'reveal a path in the file manager' },
    { token: 'OS.move_to_trash', category: 'filesystem', summary: 'move a path to the trash' },
    { token: 'DirAccess', category: 'filesystem', summary: 'directory mutations (whole class)' },
    { token: 'FileAccess.WRITE', category: 'filesystem', summary: 'open a file for writing' },
    { token: 'FileAccess.READ_WRITE', category: 'filesystem', summary: 'open a file for read+write' },
    { token: 'FileAccess.WRITE_READ', category: 'filesystem', summary: 'open a file for write+read' },
    { token: 'ResourceSaver', category: 'filesystem', summary: 'save resources to res:// or user://' },
    { token: 'ProjectSettings.save', category: 'persistence', summary: 'persist project settings to project.godot' },
    { token: 'ProjectSettings.save_custom', category: 'persistence', summary: 'persist project settings to a custom path' },
    { token: 'EditorInterface', category: 'editor', summary: 'editor-side access (belt-and-suspenders)' },
];

// SYNC_ONLY (C11 一期: await stays hard-banned; restricted await is 二期,
// separately scoped per the SEE-1239 consensus).
export const EXEC_SYNC_ONLY = {
    banned: 'await',
    advice: 'For waiting on game state, compose with godot_game_time step/step_until; for sustained behavior, attach a node under `holder`.',
};

export const EXEC_GUARD_NOTE = 'An accident guard against process/file-write escape from the game process — NOT a security boundary. Exec is for mutating the RUNNING game\'s state, not the system around it.';

// ---------- lexer (port of MCPExecGuard._lex — scan-target extraction only) --

// One lexical pass: remove # comments (outside strings) and string CONTENTS
// (quotes kept so string positions remain visible), preserving line structure.
// Escape handling mirrors the addon: an escaped char never ends the string; an
// escaped NEWLINE still advances the line counter. Known accepted miss (same
// as addon): r"..." raw strings treat backslash as an escape here.
function lexStrip(source) {
    let stripped = '';
    let quote = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
        const c = source[i];
        if (quote !== '') {
            if (c === '\n') {
                stripped += '\n';
                i += 1;
            } else if (c === '\\') {
                if (i + 1 < n && source[i + 1] === '\n') stripped += '\n';
                i += 2;
            } else if (source.startsWith(quote, i)) {
                stripped += quote;
                i += quote.length;
                quote = '';
            } else {
                i += 1;
            }
            continue;
        }
        if (c === '#') {
            while (i < n && source[i] !== '\n') i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
            stripped += quote;
            i += quote.length;
            continue;
        }
        stripped += c;
        i += 1;
    }
    return stripped;
}

// Word-boundary token regex, dots escaped. JS \b has the same _-is-word-char
// semantics as the addon's RegEx: 'OS.execute' does not match inside
// 'OS.execute_with_pipe' or 'MyOS.executed'.
function tokenRe(token) {
    return new RegExp(`\\b${token.replace(/\./g, '\\.')}\\b`);
}

function normalize(source) {
    return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ---------- surfaces ---------------------------------------------------------

// The pre-check: mirror of MCPExecGuard.scan_source. Returns
//   { ok: true }
//   { ok: false, kind: 'NO_CODE' | 'SYNC_ONLY' | 'DENIED_TOKEN',
//     violations: string[], message }
// violations lists the violated constraint tokens in EXEC_CONSTRAINTS order
// (DENIED_TOKEN) or the banned await (SYNC_ONLY) — the "提示违反条目" contract.
export function precheckExecSource(source) {
    if (typeof source !== 'string' || source.length === 0) {
        return { ok: false, kind: 'NO_CODE', violations: [], message: 'exec source must be a non-empty string' };
    }
    let stripped = lexStrip(normalize(source));
    if (stripped.trim().length === 0) {
        return {
            ok: false,
            kind: 'NO_CODE',
            violations: [],
            message: 'NO_CODE: exec source contains no executable code (comments only or empty)',
        };
    }
    // Same scanner normalizations as the addon: line continuations then
    // whitespace around dots collapse, so formatter-plausible token splits
    // ('OS . execute', 'OS.\\\nexecute') still match. Over-matching only
    // over-blocks — the safe direction for an accident guard.
    stripped = stripped.replace(/\\\n/g, '').replace(/\s*\.\s*/g, '.');
    if (tokenRe(EXEC_SYNC_ONLY.banned).test(stripped)) {
        return {
            ok: false,
            kind: 'SYNC_ONLY',
            violations: [EXEC_SYNC_ONLY.banned],
            message: `SYNC_ONLY: exec source is synchronous-only; '${EXEC_SYNC_ONLY.banned}' is not allowed. ${EXEC_SYNC_ONLY.advice}`,
        };
    }
    const violations = [];
    for (const c of EXEC_CONSTRAINTS) {
        if (tokenRe(c.token).test(stripped)) violations.push(c.token);
    }
    if (violations.length > 0) {
        return {
            ok: false,
            kind: 'DENIED_TOKEN',
            violations,
            message: `DENIED_TOKEN: source violates the exec constraint list: ${violations.join(', ')}. ${EXEC_GUARD_NOTE}`,
        };
    }
    return { ok: true, violations: [] };
}

// One-line-per-constraint digest — the exec_help body and the augmented
// error annotation. Every surface renders from EXEC_CONSTRAINTS, so the three
// outputs stay consistent by construction.
export function execConstraintDigest() {
    const lines = EXEC_CONSTRAINTS.map((c) => `  - ${c.token}  (${c.category}: ${c.summary})`);
    return [
        'godot_exec constraints (SEE-1240 WS-6 SSOT — enforced by the vendored addon denylist + proxy pre-check):',
        `  SYNC ONLY: '${EXEC_SYNC_ONLY.banned}' is banned. ${EXEC_SYNC_ONLY.advice}`,
        '  DENYLIST (word-boundary match, comments/strings stripped before scan):',
        ...lines,
        `  ${EXEC_GUARD_NOTE}`,
        '  Usage: {action:"run", source:"<GDScript function body>", budget_ms?}; {action:"help"} returns this digest; list/remove/clear manage holder children.',
    ].join('\n');
}

// The fork anchor (dist/tools/exec.js 4.1.11): the abbreviated denylist
// sentence. Replaced by the SSOT-rendered truth; a future fork that ships the
// list natively changes the anchor and this patch skips silently
// (forward-compat, same contract as WS-3's DESCRIPTION_PATCHES).
export const EXEC_DESCRIPTION_ANCHOR =
    'A static denylist rejects accidental process/file-write escape ' +
    '(OS.execute, DirAccess, write-mode FileAccess, ResourceSaver, ProjectSettings.save, ...) and ' +
    'names the offending token — an accident guard, NOT a security boundary.';

export function execDescriptionReplacement() {
    return `Constraints (SSOT, enforced by the addon denylist + proxy pre-check): SYNC ONLY ('await' banned); denylist: ` +
        `${EXEC_CONSTRAINTS.map((c) => c.token).join(', ')} — violating sources are rejected in-band naming the entries. ` +
        `action:'help' (proxy-provided) returns the full digest. ${EXEC_GUARD_NOTE}`;
}
