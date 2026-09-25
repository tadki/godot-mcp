import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatError, GodotConnectionClosedError } from '../../utils/errors.js';

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
});
