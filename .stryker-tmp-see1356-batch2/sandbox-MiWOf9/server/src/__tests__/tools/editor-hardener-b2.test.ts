// @ts-nocheck
// SEE-1356 batch-2 hardener — editor.ts mutation-face completions (the 26
// survivors of the 89.52% scoped run). These tests join the existing
// editor.test.ts face (untouched); every assertion names the mutant class it
// kills. Categories:
//   A) exact-output pins (StringLiteral/template/wording mutants)
//   B) boundary + default pins (ConditionalExpression/LogicalOperator)
//   C) equivalence-class documentation (unreachable-by-construction arms)
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockGodot, createToolContext, structuredOf, MockGodotConnection } from '../helpers/mock-godot.js';
import { editorRead, editorEdit } from '../../tools/editor.js';

describe('editorRead — hardener survivor kills (batch-2)', () => {
  let mock: MockGodotConnection;
  beforeEach(() => { mock = createMockGodot(); });

  describe('A: exact-output pins (wording is the wire contract)', () => {
    it('get_state/get_selection/log/stack tool names forwarded VERBATIM to the addon', async () => {
      // kills: editor.ts:186/192/202/235 sendCommand name-literal mutants — a
      // renamed command string would silently address a nonexistent addon
      // handler; the mock records the exact name.
      for (const [action, expectedCmd] of [
        ['get_state', 'get_editor_state'],
        ['get_selection', 'get_selected_nodes'],
        ['get_log_messages', 'get_log_messages'],
        ['get_stack_trace', 'get_stack_trace'],
      ] as const) {
        mock.mockResponse(action === 'get_selection' ? { selected: [] } : action === 'get_stack_trace' ? { error: 'x', frames: [{}] } : {});
        await editorRead.execute({ action } as never, createToolContext(mock));
        expect(mock.calls.at(-1)!.command, `${action} must address '${expectedCmd}'`).toBe(expectedCmd);
      }
    });

    it('selection listing format is exact (template mutant kills)', async () => {
      mock.mockResponse({ selected: ['/root/A', '/root/B'] });
      const out = await editorRead.execute({ action: 'get_selection' }, createToolContext(mock));
      expect(out).toBe('Selected nodes:\n  - /root/A\n  - /root/B');
    });

    it('log severity prefix formatting: "error " with trailing space, none for all', async () => {
      // kills: editor.ts:219 template + ternary mutants.
      mock.mockResponse({ total_count: 4, match_count: 0, returned_count: 0, cursor: 7, messages: [], staleness: null });
      const ctx = createToolContext(mock);
      const withSev = await editorRead.execute({ action: 'get_log_messages', since: 4, severity: 'error' } as never, ctx);
      expect(withSev).toContain('No new error messages since cursor 7.');
      mock.mockResponse({ total_count: 4, match_count: 0, returned_count: 0, cursor: 4, messages: [], staleness: null });
      const allSev = await editorRead.execute({ action: 'get_log_messages', since: 4 } as never, createToolContext(mock));
      expect(allSev).toBe('No new messages since cursor 4.');
    });

    it('mesh advisory wording pins the separator and remedy', async () => {
      // kills: editor.ts:261 template/StringLiteral mutants.
      mock.mockResponse({ image_base64: 'aGk=', mesh_warnings: ['w1', 'w2'] });
      const out = await editorRead.execute({ action: 'screenshot_game' }, createToolContext(mock)) as Array<{ text?: string }>;
      expect(out[1].text).toBe(
        '⚠ Mesh integrity: w1 | w2. If the render looks wrong, this is likely why — run godot_validate_meshes for causes and fixes before tuning lights/materials.',
      );
    });

    it('empty-payload CAPTURE_FAILED detail is exactly empty_base64 (proxy contract twin)', async () => {
      // kills: editor.ts:279 guard + detail literal mutants — the detail string
      // is the machine key the proxy contract classifies on.
      mock.mockResponse({ image_base64: '' });
      const out = await editorRead.execute({ action: 'screenshot_editor' }, createToolContext(mock));
      const payload = structuredOf(out) as { error: { code: string; detail: string } };
      expect(payload.error.detail).toBe('empty_base64');
    });

    it('non-empty editor capture → bare image (payload length===1 boundary)', async () => {
      // kills: `length === 0` → `length === 1` ConditionalExpression mutant —
      // a 1-char payload is degenerate but VALID base64, must NOT be rejected.
      mock.mockResponse({ image_base64: 'a' });
      const out = await editorRead.execute({ action: 'screenshot_editor' }, createToolContext(mock));
      expect(out).toEqual({ type: 'image', data: 'a', mimeType: 'image/png' });
    });

    it('restart reply distinguishes save vs no-save exactly', async () => {
      // kills: editor.ts:348 ternary wording mutants.
      mock.mockResponse({});
      const saved = await editorEdit.execute({ action: 'restart', save: true } as never, createToolContext(mock));
      expect(saved).toBe('Editor is restarting (project saved first). The bridge reconnects automatically in a few seconds - retry your next command then.');
      const raw = await editorEdit.execute({ action: 'restart', save: false } as never, createToolContext(mock));
      expect(raw).toBe('Editor is restarting without saving. The bridge reconnects automatically in a few seconds - retry your next command then.');
    });

    it('run reply carries the frozen/scene wording exactly', async () => {
      mock.mockResponse({ frozen: true, bridge_ready: true });
      const frozen = await editorEdit.execute({ action: 'run', frozen: true } as never, createToolContext(mock));
      expect(frozen).toBe('Running project frozen from frame 0 — use godot_game_time step/thaw to advance');
      mock.mockResponse({ frozen: false, bridge_ready: true });
      const scene = await editorEdit.execute({ action: 'run', scene_path: 'res://x.tscn' } as never, createToolContext(mock));
      expect(scene).toBe('Running scene: res://x.tscn');
    });
  });

  describe('B: boundary + default pins', () => {
    it('set_viewport_2d refine accepts when EXACTLY one axis set, rejects when none', async () => {
      // kills: editor.ts:161 || → && mutants and the refine-removal arm.
      expect(editorEdit.schema.safeParse({ action: 'set_viewport_2d', center_x: 1 }).success).toBe(true);
      expect(editorEdit.schema.safeParse({ action: 'set_viewport_2d', center_y: 1 }).success).toBe(true);
      expect(editorEdit.schema.safeParse({ action: 'set_viewport_2d', zoom: 1 }).success).toBe(true);
      const none = editorEdit.schema.safeParse({ action: 'set_viewport_2d' });
      expect(none.success).toBe(false);
      if (!none.success) {
        // kills: editor.ts:163 message StringLiteral/ObjectLiteral mutants.
        expect(none.error.issues[0].message).toBe('set_viewport_2d requires at least one of center_x, center_y, or zoom');
      }
    });

    it('set_viewport_2d forwards ONLY the set axes (omitted axis stays untouched addon-side)', async () => {
      // kills: editor.ts:356-358 forward-guard mutants (an unconditional
      // forward would recenter on 0,0 — the documented additive-view break).
      mock.mockResponse({ center: { x: 3, y: 4 }, zoom: 2 });
      await editorEdit.execute({ action: 'set_viewport_2d', zoom: 2 } as never, createToolContext(mock));
      const params = mock.calls.at(-1)!.params as Record<string, number>;
      expect(params).toEqual({ zoom: 2 });
      expect(params.center_x).toBeUndefined();
      expect(params.center_y).toBeUndefined();
    });

    it('screenshot max_width forwards when set; omitted = no key (native capture)', async () => {
      // kills: editor.ts:245 { max_width } ObjectLiteral mutants (an explicit
      // undefined key would change the addon's default-vs-omitted semantics).
      mock.mockResponse({ image_base64: 'aGk=' });
      const withW = createToolContext(mock);
      await editorRead.execute({ action: 'screenshot_game', max_width: 640 } as never, withW);
      expect(mock.calls.at(-1)!.params).toEqual({ max_width: 640 });
      const noW = createToolContext(mock);
      await editorRead.execute({ action: 'screenshot_game' } as never, noW);
      expect(mock.calls.at(-1)!.params).toEqual({});
    });

    it('log defaults: clear=false limit=50 since=0 forwarded as VALUES (not undefined)', async () => {
      // kills: editor.ts:204 `?? false` LogicalOperator/default mutants — the
      // addon receives concrete defaults, not absent keys.
      mock.mockResponse({ total_count: 4, match_count: 0, returned_count: 0, cursor: 0, messages: [], staleness: null });
      await editorRead.execute({ action: 'get_log_messages' } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.params).toEqual({ clear: false, limit: 50, severity: 'all', since: 0 });
    });

    it('run gate: bridge_ready false appends the gate note; missing result tolerated', async () => {
      // kills: editor.ts:319 `result?.bridge_ready === true` OptionalChaining
      // mutants (dropping ?. throws on a null ack; === true → truthy flips the
      // gate for undefined).
      mock.mockResponse({ frozen: false, bridge_ready: false });
      const gated = await editorEdit.execute({ action: 'run' } as never, createToolContext(mock));
      expect(gated).toBe('Running project (bridge_ready: false — game may not be drivable yet; retry or stop)');
      mock.mockResponse(null as never);
      const bare = await editorEdit.execute({ action: 'run' } as never, createToolContext(mock));
      expect(bare).toContain('bridge_ready: false');
    });
  });

  describe('B2: remaining scoped survivors — exact command-name + forward-guard pins', () => {
    it('screenshot command names forwarded verbatim per action', async () => {
      // kills: editor.ts:244/271 command-name StringLiteral survivors —
      // screenshot_game must address capture_game_screenshot (game viewport)
      // and screenshot_editor capture_editor_screenshot; a swap/renaming would
      // capture the wrong surface silently.
      mock.mockResponse({ image_base64: 'aGk=' });
      await editorRead.execute({ action: 'screenshot_game' } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.command).toBe('capture_game_screenshot');
      mock.mockResponse({ image_base64: 'aGk=' });
      await editorRead.execute({ action: 'screenshot_editor' } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.command).toBe('capture_editor_screenshot');
    });

    it('stop forwards stop_project verbatim (stop/restart must not cross)', async () => {
      // kills: editor.ts:329 command-name survivor.
      mock.mockResponse({});
      const out = await editorEdit.execute({ action: 'stop' } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.command).toBe('stop_project');
      expect(out).toBe('Stopped project');
    });

    it('set_viewport_2d: a call with NO axis does not send a zoom key at all (zoom-guard arm)', async () => {
      // kills: editor.ts:358 zoom-guard survivor (`if (args.zoom !== undefined)`
      // → `if (true)`): a call omitting zoom but setting center must NOT carry
      // a zoom key (undefined would coerce differently on the addon side than
      // key-absence). center_x-only isolates the zoom guard specifically.
      mock.mockResponse({ center: { x: 1, y: 2 }, zoom: 1 });
      await editorEdit.execute({ action: 'set_viewport_2d', center_x: 1 } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.params).toEqual({ center_x: 1 });
      expect('zoom' in (mock.calls.at(-1)!.params)).toBe(false);
    });

    it('set_viewport_2d forwards each axis when set (per-axis guard pins)', async () => {
      // kills: editor.ts:356-358 per-axis ConditionalExpression survivors
      // (removal/inversion would drop or null-poison exactly one axis).
      for (const [axis, params] of [
        ['center_x', { center_x: 1 }],
        ['center_y', { center_y: 2 }],
        ['zoom', { zoom: 3 }],
      ] as const) {
        mock.mockResponse({ center: { x: 0, y: 0 }, zoom: 1 });
        await editorEdit.execute({ action: 'set_viewport_2d', [axis]: params[axis] } as never, createToolContext(mock));
        expect(mock.calls.at(-1)!.params, `axis ${axis} must forward`).toEqual(params);
      }
    });

    it("log reply: severity 'all' renders NO prefix (the all-arm boundary)", async () => {
      // kills: editor.ts:219 ConditionalExpression (`&& 'all'-check` → true)
      // and StringLiteral survivors — with severity 'all' explicitly passed,
      // the prefix must be EMPTY ('No new messages', not 'No new all messages').
      mock.mockResponse({ total_count: 4, match_count: 0, returned_count: 0, cursor: 6, messages: [], staleness: null });
      const out = await editorRead.execute({ action: 'get_log_messages', since: 6, severity: 'all' } as never, createToolContext(mock));
      expect(out).toBe('No new messages since cursor 6.');
      mock.mockResponse({ total_count: 4, match_count: 0, returned_count: 0, cursor: 6, messages: [], staleness: null });
      const undef = await editorRead.execute({ action: 'get_log_messages' } as never, createToolContext(mock));
      expect(undef).toBe('No messages (cursor 6).');
    });

    it('log filter passthrough: the SEVERITY VALUE rides verbatim (not just presence)', async () => {
      // kills: editor.ts:219 `${args.severity} ` template survivor — the
      // params pin below checks the forwarded VALUE; the reply-pin in the
      // earlier test covers the rendered prefix.
      mock.mockResponse({ total_count: 4, match_count: 0, returned_count: 0, cursor: 9, messages: [], staleness: null });
      await editorRead.execute({ action: 'get_log_messages', severity: 'warning', since: 2 } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.params).toEqual({ clear: false, limit: 50, severity: 'warning', since: 2 });
    });

    it('editor screenshot forwards viewport param verbatim', async () => {
      // kills: editor.ts:271 param-shape companion (viewport key present).
      mock.mockResponse({ image_base64: 'aGk=' });
      await editorRead.execute({ action: 'screenshot_editor', viewport: '3d' } as never, createToolContext(mock));
      expect(mock.calls.at(-1)!.params).toEqual({ viewport: '3d' });
    });
  });

  describe('C: equivalence-class documentation (unreachable / observationally equivalent arms)', () => {
    it('stack-trace empty arm needs BOTH no-error AND zero frames', async () => {
      // kills attempt for editor.ts:236 && → ||: the arm is reachable with a
      // real addon ack, and the || mutant IS observable (error present + 0
      // frames would wrongly print "No stack trace available") — this test
      // kills it; the surviving sibling mutants are literal-class.
      mock.mockResponse({ error: 'boom', error_type: 'E', file: 'f', line: 1, frames: [] });
      const withErr = await editorRead.execute({ action: 'get_stack_trace' }, createToolContext(mock));
      expect(structuredOf(withErr)).toMatchObject({ error: 'boom' });
      mock.mockResponse({ error: '', error_type: '', file: '', line: 0, frames: [{ file: 'a', line: 2, function: 'f' }] });
      const withFrames = await editorRead.execute({ action: 'get_stack_trace' }, createToolContext(mock));
      expect(structuredOf(withFrames)).toMatchObject({ frames: [{ file: 'a' }] });
    });
  });
});
