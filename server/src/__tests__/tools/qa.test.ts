import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMockGodot,
  createToolContext,
  structuredOf,
  MockGodotConnection,
} from '../helpers/mock-godot.js';
import { qa } from '../../tools/qa.js';
import { toInputSchema } from '../../core/schema.js';
import { deriveTimeouts } from '../../connection/timeouts.js';

describe('qa tool', () => {
  let mock: MockGodotConnection;

  beforeEach(() => {
    mock = createMockGodot();
  });

  // ── Schema validation ────────────────────────────────────────────────────

  describe('schema validation', () => {
    it('accepts assert_property with defaults', () => {
      // `expected` is required (nonoptional): an assert without an expectation
      // is meaningless, but null/0/false are legitimate expected values.
      expect(
        qa.schema.safeParse({ action: 'assert_property', path: '/root/G', property: 'wave', expected: 3 }).success
      ).toBe(true);
      expect(
        qa.schema.safeParse({ action: 'assert_property', path: '/root/G', property: 'muted', expected: false }).success
      ).toBe(true);
    });

    it('rejects assert_property without expected', () => {
      expect(qa.schema.safeParse({ action: 'assert_property', path: '/root/G', property: 'wave' }).success).toBe(false);
    });

    it('accepts assert_property with op and tolerance', () => {
      expect(
        qa.schema.safeParse({
          action: 'assert_property',
          path: '/root/Level/Player',
          property: 'speed',
          op: 'gte',
          expected: 300,
          tolerance: 0.5,
        }).success
      ).toBe(true);
    });

    it('rejects assert_property with an unknown op', () => {
      expect(
        qa.schema.safeParse({ action: 'assert_property', path: '/root/G', property: 'wave', op: 'between' }).success
      ).toBe(false);
    });

    it('accepts wait_for_signal with predicate and timeout bounds', () => {
      expect(
        qa.schema.safeParse({
          action: 'wait_for_signal',
          path: '/root/G',
          signal: 'wave_changed',
          predicate: 'value > 10',
          timeout_ms: 8000,
        }).success
      ).toBe(true);
    });

    it('rejects wait_for_signal timeout above the 30s ceiling', () => {
      expect(
        qa.schema.safeParse({ action: 'wait_for_signal', path: '/root/G', signal: 'wave_changed', timeout_ms: 31000 })
          .success
      ).toBe(false);
    });

    it('rejects wait_for_signal timeout below the 100ms floor', () => {
      expect(
        qa.schema.safeParse({ action: 'wait_for_signal', path: '/root/G', signal: 'wave_changed', timeout_ms: 50 })
          .success
      ).toBe(false);
    });

    it('accepts assert_layout with check objects and defaults to none', () => {
      expect(qa.schema.safeParse({ action: 'assert_layout', path: '/root/UI/Panel' }).success).toBe(true);
      expect(
        qa.schema.safeParse({
          action: 'assert_layout',
          path: '/root/UI/Panel',
          checks: [{ type: 'within_parent', tolerance: 2 }, { type: 'min_size', min_w: 100, min_h: 40 }],
        }).success
      ).toBe(true);
    });

    it('rejects assert_layout with an unknown check type', () => {
      expect(
        qa.schema.safeParse({ action: 'assert_layout', path: '/root/UI/Panel', checks: [{ type: 'centered' }] })
          .success
      ).toBe(false);
    });

    it('accepts screenshot_node with optional max_width', () => {
      expect(qa.schema.safeParse({ action: 'screenshot_node', path: '/root/UI/Panel' }).success).toBe(true);
      expect(
        qa.schema.safeParse({ action: 'screenshot_node', path: '/root/UI/Panel', max_width: 320 }).success
      ).toBe(true);
    });

    it('exposes the discriminated actions in the flattened schema', () => {
      const flattened = toInputSchema(qa.schema) as { properties?: Record<string, unknown> };
      expect(flattened.properties?.action).toBeDefined();
    });
  });

  // ── Wire contract ────────────────────────────────────────────────────────

  describe('wire contract', () => {
    it('assert_property forwards path/property/op/expected/tolerance', async () => {
      mock.mockResponse({ path: '/root/G', property: 'wave', op: 'approx', expected: 3, actual: 3, passed: true });
      const result = await qa.execute(
        { action: 'assert_property', path: '/root/G', property: 'wave', expected: 3 } as never,
        createToolContext(mock)
      );
      expect(mock.calls[0].command).toBe('qa_assert_property');
      expect(mock.calls[0].params).toMatchObject({ path: '/root/G', property: 'wave', op: 'approx', expected: 3 });
      expect(structuredOf(result).passed).toBe(true);
    });

    it('wait_for_signal derives the relay cascade from the declared budget', async () => {
      mock.mockResponse({ emitted: true, elapsed_ms: 120, timeout_ms: 5000, rejected: 0, predicate_supplied: false, t_ms: 120, args: '[3]' });
      const result = await qa.execute(
        { action: 'wait_for_signal', path: '/root/G', signal: 'wave_changed' } as never,
        createToolContext(mock)
      );
      expect(mock.calls[0].command).toBe('qa_wait_for_signal');
      // 5000 budget → relay 9000 (+4s margin), server socket 11000.
      expect(mock.calls[0].params.relay_timeout_ms).toBe(9000);
      expect(mock.calls[0].opts?.timeoutMs).toBe(11000);
      expect(structuredOf(result).emitted).toBe(true);
    });

    it('wait_for_signal forwards the predicate when supplied', async () => {
      mock.mockResponse({ emitted: true, elapsed_ms: 10, timeout_ms: 5000, rejected: 2, predicate_supplied: true, t_ms: 10 });
      await qa.execute(
        { action: 'wait_for_signal', path: '/root/G', signal: 'wave_changed', predicate: 'value > 10' } as never,
        createToolContext(mock)
      );
      expect(mock.calls[0].params.predicate).toBe('value > 10');
      expect(mock.calls[0].params.timeout_ms).toBe(5000);
    });

    it('assert_layout forwards checks verbatim (empty array = bridge defaults)', async () => {
      mock.mockResponse({ path: '/root/UI', checks: [], passed: true });
      await qa.execute({ action: 'assert_layout', path: '/root/UI' } as never, createToolContext(mock));
      expect(mock.calls[0].params.checks).toEqual([]);
    });

    it('screenshot_node defaults max_width to 640, pushes the relay cascade, and returns the image', async () => {
      mock.mockResponse({ image_base64: 'aGk=', width: 100, height: 40, path: '/root/UI', clamped: false, frozen: false });
      const result = await qa.execute(
        { action: 'screenshot_node', path: '/root/UI' } as never,
        createToolContext(mock)
      );
      expect(mock.calls[0].params.max_width).toBe(640);
      // F-QA-1 rework: capture awaits frame_post_draw game-side → real cascade.
      expect(mock.calls[0].params.relay_timeout_ms).toBe(deriveTimeouts(5000).relayMs);
      expect(mock.calls[0].opts?.timeoutMs).toBe(deriveTimeouts(5000).serverMs);
      const image = result as { type: string; data: string; mimeType: string };
      expect(image.type).toBe('image');
      expect(image.mimeType).toBe('image/png');
      expect(image.data).toBe('aGk=');
    });

    it('screenshot_node annotates the image when clamped or frozen', async () => {
      mock.mockResponse({ image_base64: 'aGk=', width: 100, height: 40, path: '/root/UI', clamped: true, frozen: true });
      const result = await qa.execute(
        { action: 'screenshot_node', path: '/root/UI' } as never,
        createToolContext(mock)
      );
      const multi = result as Array<{ type: string; text?: string }>;
      expect(Array.isArray(multi)).toBe(true);
      const text = multi.find((part) => part.type === 'text')?.text ?? '';
      expect(text).toContain('on-screen part only');
      expect(text).toContain('frozen');
    });

    it('screenshot_node surfaces typed bridge errors as structured text (no fake image)', async () => {
      mock.mockResponse({ error: 'not_canvas_item: /root/G (Node)' });
      const result = await qa.execute(
        { action: 'screenshot_node', path: '/root/G' } as never,
        createToolContext(mock)
      );
      expect(structuredOf(result).error).toContain('not_canvas_item');
    });

    // ── SEE-1348 补单 A (mutation kill): the survivors from the first stryker
    // run were all conditional/optional arms whose polarity is observable only
    // when BOTH sides differ — pin each with its negative.
    it('assert_property OMITS tolerance when not supplied (spread gate polarity)', async () => {
      mock.mockResponse({ path: '/root/G', property: 'wave', op: 'approx', expected: 3, actual: 3, passed: true });
      await qa.execute({ action: 'assert_property', path: '/root/G', property: 'wave', expected: 3 } as never, createToolContext(mock));
      expect('tolerance' in mock.calls[0].params).toBe(false);
    });

    it('assert_property forwards a SUPPLIED tolerance (spread gate other arm)', async () => {
      mock.mockResponse({ path: '/root/G', property: 'wave', op: 'approx', expected: 3, actual: 3, passed: true });
      await qa.execute({ action: 'assert_property', path: '/root/G', property: 'wave', expected: 3, tolerance: 0.5 } as never, createToolContext(mock));
      expect(mock.calls[0].params.tolerance).toBe(0.5);
    });

    it('wait_for_signal omits predicate when absent; assert_layout forwards a non-empty checks array', async () => {
      mock.mockResponse({ path: '/root/G', signal: 'wave_changed', emitted: false });
      await qa.execute({ action: 'wait_for_signal', path: '/root/G', signal: 'wave_changed' } as never, createToolContext(mock));
      expect('predicate' in mock.calls[0].params).toBe(false);

      mock.mockResponse({ path: '/root/UI', checks: [{ type: 'within' }], passed: true });
      await qa.execute({ action: 'assert_layout', path: '/root/UI', checks: [{ type: 'within' }] } as never, createToolContext(mock));
      expect(mock.calls[1].params.checks).toEqual([{ type: 'within' }]);
    });

    it('screenshot_node: image WITHOUT caveats returns the bare image (meta gate polarity)', async () => {
      mock.mockResponse({ image_base64: 'aGk=', width: 100, height: 40, path: '/root/UI', clamped: false, frozen: false });
      const result = await qa.execute({ action: 'screenshot_node', path: '/root/UI' } as never, createToolContext(mock));
      const image = result as { type: string };
      expect(image.type).toBe('image');
    });

    it('screenshot_node: error WITH a fake image still prefers the structured error (error gate polarity)', async () => {
      mock.mockResponse({ error: 'stale: node gone', image_base64: 'aGk=' });
      const result = await qa.execute({ action: 'screenshot_node', path: '/root/G' } as never, createToolContext(mock));
      expect(structuredOf(result).error).toContain('stale');
    });

    it('wire command names are pinned verbatim (mutation-kill: command string literals)', async () => {
      mock.mockResponse({ path: '/root/UI', checks: [], passed: true });
      await qa.execute({ action: 'assert_layout', path: '/root/UI' } as never, createToolContext(mock));
      expect(mock.calls[0].command).toBe('qa_assert_layout');

      mock.mockResponse({ image_base64: 'aGk=', width: 1, height: 1, path: '/root/UI', clamped: false, frozen: false });
      await qa.execute({ action: 'screenshot_node', path: '/root/UI' } as never, createToolContext(mock));
      expect(mock.calls[1].command).toBe('qa_screenshot_node');
    });

    it('screenshot_node caveat annotation joins with the exact "; " separator (mutation-kill: join literal)', async () => {
      mock.mockResponse({ image_base64: 'aGk=', width: 100, height: 40, path: '/root/UI', clamped: true, frozen: true });
      const result = await qa.execute({ action: 'screenshot_node', path: '/root/UI' } as never, createToolContext(mock));
      const multi = result as Array<{ type: string; text?: string }>;
      const text = multi.find((part) => part.type === 'text')?.text ?? '';
      expect(text).toBe('node rect extended past the viewport — image covers the on-screen part only; captured under a frozen game (godot_game_time)');
    });

    it('screenshot_node: missing image_base64 is the structured-error path too', async () => {
      mock.mockResponse({ path: '/root/G' });
      const result = await qa.execute({ action: 'screenshot_node', path: '/root/G' } as never, createToolContext(mock));
      expect(structuredOf(result).image_base64).toBeUndefined();
    });
  });

  // ── Annotations ──────────────────────────────────────────────────────────

  it('is read-only (all four actions are observations)', () => {
    expect(qa.annotations?.readOnlyHint).toBe(true);
    expect(qa.annotations?.destructiveHint).toBe(false);
  });
});
