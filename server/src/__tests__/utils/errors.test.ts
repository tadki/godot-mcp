import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatError, GodotCommandError, GodotConnectionClosedError, GodotConnectionError, GodotTimeoutError } from '../../utils/errors.js';

// SEE-1348 F-QA-5: GodotConnectionClosedError's code must reach the MCP
// client's error surface. registry.executeTool re-throws the typed error
// as-is (tool layer needs instanceof), so index.ts renders the user-visible
// message via formatError — the [CODE] prefix is the contract under test.
describe('F-QA-5 user-facing error surface', () => {
  it('formatError prefixes the close code for GodotConnectionClosedError', () => {
    const e = new GodotConnectionClosedError('CONNECTION_LOST', 'Connection closed');
    expect(formatError(e)).toBe('[CONNECTION_LOST] Connection closed');
  });

  it('index.ts renders tool-call errors through formatError (wiring)', () => {
    const idx = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts');
    const src = readFileSync(idx, 'utf8');
    expect(src).toMatch(/const message = formatError\(error\)/);
    // The old inline branch only special-cased GodotCommandError, which let
    // GodotConnectionClosedError fall through to a bare .message.
    expect(src).not.toMatch(/error instanceof GodotCommandError/);
  });

  it('non-typed errors keep their plain message through the same surface', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
  });

  // SEE-1348 补单 A (mutation kill): every formatError branch pinned exactly —
  // GodotCommandError code prefix, GodotTimeoutError [TIMEOUT] prefix, and the
  // non-Error fallback (String(error)). The branch-order mutants (survived in
  // the first stryker run: swapping instanceof arms is observable only when
  // the payload differs per type — e.g. a closed error whose message is its
  // exact code would render identically under the wrong arm) are killed by
  // distinct payloads per class.
  it('formatError pins every branch with distinct payloads (kill-arm contract)', () => {
    expect(formatError(new GodotCommandError('E_TEST', 'cmd failed'))).toBe('[E_TEST] cmd failed');
    expect(formatError(new GodotTimeoutError('get_state', 1234)))
      .toBe('[TIMEOUT] Command \'get_state\' timed out after 1234ms');
    expect(formatError('plain-string')).toBe('plain-string');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
    // ClosedError message intentionally distinct from its code so a swap of
    // the GodotCommandError/GodotConnectionClosedError arms is observable.
    expect(formatError(new GodotConnectionClosedError('STALE_CLOSED_BY_SERVER', 'Connection closed')))
      .toBe('[STALE_CLOSED_BY_SERVER] Connection closed');
    // instanceof-chain order: GodotConnectionClosedError IS-A
    // GodotConnectionError, not a GodotCommandError — both arms must keep
    // their own payload.
    expect(formatError(new GodotConnectionError('conn lost'))).toBe('conn lost');
  });
});
