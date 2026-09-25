import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { structured } from '../core/structured.js';
import type { AnyToolDefinition, ImageContent, ToolContext, ToolExecuteResult } from '../core/types.js';

// ── Godot response shapes ────────────────────────────────────────────────────

interface QaAssertPropertyResponse {
  path: string;
  property: string;
  op: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  tolerance?: number;
  error?: string;
}

interface QaLayoutCheck {
  type: string;
  passed: boolean;
  actual?: unknown;
  rect?: { x: number; y: number; w: number; h: number };
  parent_rect?: { x: number; y: number; w: number; h: number };
  tolerance?: number;
  error?: string;
}

interface QaAssertLayoutResponse {
  path: string;
  checks: QaLayoutCheck[];
  passed: boolean;
  error?: string;
}

interface QaWaitResponse {
  emitted: boolean;
  elapsed_ms: number;
  timeout_ms: number;
  rejected: number;
  predicate_supplied: boolean;
  predicate_failed?: boolean;
  t_ms?: number;
  args?: string;
  error?: string;
}

interface QaScreenshotNodeResponse {
  image_base64?: string;
  width?: number;
  height?: number;
  path?: string;
  rect?: { x: number; y: number; w: number; h: number };
  clamped?: boolean;
  frozen?: boolean;
  error?: string;
}

// ── Schema ───────────────────────────────────────────────────────────────────

// Comparison ops shared by assert_property. `approx` (default) tolerates float
// noise: |a-b| <= tolerance for numbers and vectors, exact == otherwise.
const COMPARE_OPS = ['approx', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;

const QaSchema = z.discriminatedUnion('action', [
  z.object({
    action: z
      .literal('assert_property')
      .describe(
        'Assert a node property against an expected value in the RUNNING game. Numeric and Vector2/3 ' +
        'comparisons support tolerance (default 0.01); the result always carries `actual` (stringified ' +
        'for non-primitives), so a failed assert still tells you what the game held. Read-only oracle — ' +
        'pairs with godot_runtime_state digest for discovery and godot_input for actuation. NOT a GUT ' +
        'replacement: godot_qa drives the RUNNING game (the live-game oracle), GUT owns repo test suites.'
      ),
    path: z
      .string()
      .min(1)
      .describe('Full node path (e.g. "/root/Level/Player"). Absolute /root/... paths reach autoloads.'),
    property: z.string().min(1).describe('Property name to read (e.g. "speed", "heart_count", "global_position")'),
    op: z
      .enum(COMPARE_OPS)
      .optional()
      .describe(
        'Comparison: "approx" (default) = |a-b| <= tolerance for numbers/vectors, exact == otherwise; ' +
        '"eq"/"ne" exact; "gt"/"gte"/"lt"/"lte" numeric order (false, not an error, for non-numeric operands)'
      ),
    expected: z
      .unknown()
      .nonoptional()
      .describe('Expected value (number, string, bool, or [x, y] / [x, y, z] for vectors)'),
    tolerance: z.number().min(0).optional().describe('Tolerance for "approx" (default 0.01)'),
  }),
  z.object({
    action: z
      .literal('wait_for_signal')
      .describe(
        'Wait for ONE emission of a signal on a node in the RUNNING game, with an optional predicate over ' +
        'the signal\'s DECLARED argument names (e.g. "value > 10" for `signal value_changed(value)`). An ' +
        'emission that fails the predicate keeps the wait running (counted in `rejected`). Resolves ' +
        'emitted:true with stringified args and t_ms, or emitted:false on timeout — a clean negative, ' +
        'never an error. FREEZE SEMANTICS: gameplay signals cannot fire under a godot_game_time freeze; a ' +
        'frozen wait resolves emitted:false at the wall-clock timeout (the documented negative case) — ' +
        'step or thaw first. One wait at a time (a second concurrent wait is an error). Read-only: the ' +
        'connection is torn down on every exit path (hit, timeout, restart, scene exit).'
      ),
    path: z
      .string()
      .min(1)
      .describe('Emitter node path (e.g. "/root/G" for an autoload singleton)'),
    signal: z.string().min(1).describe('Signal name on that node — script or built-in (e.g. "body_entered")'),
    predicate: z
      .string()
      .optional()
      .describe(
        'Optional Expression over the signal\'s declared argument names (arity 1-5); e.g. "value > 10", ' +
        '"node == player". Malformed predicates are rejected up front; a runtime predicate failure counts ' +
        'the emission as rejected and reports predicate_failed.'
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(30000)
      .optional()
      .describe('Wall-clock budget before resolving emitted:false (default 5000, max 30000)'),
  }),
  z.object({
    action: z
      .literal('assert_layout')
      .describe(
        'Assert layout geometry of a visual node in the RUNNING game (cheap text — no screenshot needed). ' +
        'Checks: "visible" (is_visible_in_tree), "onscreen" (rect intersects the viewport), "within_parent" ' +
        '(rect enclosed by the parent Control, optional tolerance), "min_size" (Control size floors). ' +
        'Defaults to [visible, onscreen] when no checks are given; result always carries the measured rects.'
      ),
    path: z.string().min(1).describe('Full node path of the visual node (Control preferred)'),
    checks: z
      .array(
        z.object({
          type: z.enum(['visible', 'onscreen', 'within_parent', 'min_size']).describe('Layout check to run'),
          tolerance: z.number().optional().describe('Grow tolerance for "within_parent" (default 0)'),
          min_w: z.number().optional().describe('Width floor for "min_size" (default 0)'),
          min_h: z.number().optional().describe('Height floor for "min_size" (default 0)'),
        })
      )
      .optional()
      .describe('Checks to run (default: visible + onscreen)'),
  }),
  z.object({
    action: z
      .literal('screenshot_node')
      .describe(
        'Capture a lossless PNG cropped to ONE visual node\'s rect in the RUNNING game — an appearance ' +
        'check for a specific element without the full-frame token cost. Frozen-safe: captures under a ' +
        'game-layer pause and a godot_game_time freeze like screenshot_game. Supports Controls and Node2D ' +
        'items with a get_rect; the result carries the crop rect and a `clamped` flag when the node was ' +
        'partially off-screen. For structure/state prefer godot_node_read / godot_runtime_state (free).'
      ),
    path: z.string().min(1).describe('Full node path of the visual node to capture'),
    max_width: z
      .number()
      .int()
      .optional()
      .describe(
        'Max width in px for the cropped image (default 640). Cost scales with resolution (~1 visual token per 28x28px patch); drop toward 640 to halve per-frame cost, raise only when fine detail is unreadable.'
      ),
  }),
]);

type QaArgs = z.infer<typeof QaSchema>;

// ── Tool definition ──────────────────────────────────────────────────────────

function toImageContent(base64: string): ImageContent {
  return {
    type: 'image',
    data: base64,
    mimeType: 'image/png',
  };
}

export const qa = defineTool({
  name: 'godot_qa',
  annotations: {
    title: 'QA Assertions',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  description:
    'Live-game QA assertion primitives for the RUNNING game — the act/observe/verify loop with real-machine ' +
    'oracles: assert_property (node property vs expected, tolerance-aware), wait_for_signal (one-shot signal ' +
    'listen with an optional predicate over declared args; timeout is a clean emitted:false, never an error), ' +
    'assert_layout (visible/onscreen/within_parent/min_size geometry checks as cheap text), and screenshot_node ' +
    '(lossless PNG cropped to one node). All read-only. NOT a GUT replacement: GUT owns repo test suites; ' +
    'godot_qa drives the running game, freeze included (freeze note: gameplay signals do not fire under ' +
    'godot_game_time freeze — waits resolve emitted:false there).',
  schema: QaSchema,
  // The 4-action switch is the same dispatch shape as runtime-state (cc 31);
  // the plain-`complexity` warning is absorbed by the --max-warnings ratchet,
  // which new-code additions must buy down elsewhere.
  async execute(args: QaArgs, { godot }) {
    switch (args.action) {
      case 'assert_property': {
        const result = await godot.sendCommand<QaAssertPropertyResponse>('qa_assert_property', {
          path: args.path,
          property: args.property,
          op: args.op ?? 'approx',
          expected: args.expected,
          ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}),
        });
        return structured(result);
      }

      case 'wait_for_signal': {
        return waitForSignal(args, godot);
      }

      case 'assert_layout': {
        const result = await godot.sendCommand<QaAssertLayoutResponse>('qa_assert_layout', {
          path: args.path,
          checks: args.checks ?? [],
        });
        return structured(result);
      }

      case 'screenshot_node': {
        const result = await godot.sendCommand<QaScreenshotNodeResponse>('qa_screenshot_node', {
          path: args.path,
          max_width: args.max_width ?? 640,
        });
        return screenshotNodeResult(result);
      }
    }
  },
});

// Same cascade class as game_time (no bridge-ready wait): the relay waits the
// declared budget (+margin) before declaring the wait hung; the bridge resolves
// earlier via the sampler's wall-clock timeout.
async function waitForSignal(
  args: Extract<QaArgs, { action: 'wait_for_signal' }>,
  godot: ToolContext['godot']
): Promise<ToolExecuteResult> {
  const budgetMs = args.timeout_ms ?? 5000;
  const relayMs = budgetMs + 4000;
  const result = await godot.sendCommand<QaWaitResponse>(
    'qa_wait_for_signal',
    {
      path: args.path,
      signal: args.signal,
      ...(args.predicate !== undefined ? { predicate: args.predicate } : {}),
      timeout_ms: budgetMs,
      relay_timeout_ms: relayMs,
    },
    { timeoutMs: relayMs + 2000 }
  );
  return structured(result);
}

// Render a screenshot_node capture: an error/missing-image payload is the
// structured error object; success is the image plus a one-line text
// annotation when the capture carries caveats (clipped to the viewport, or
// taken under a frozen game). No caveats → the bare image, like screenshot_game.
function screenshotNodeResult(result: QaScreenshotNodeResponse): ToolExecuteResult {
  if (result.error || !result.image_base64) {
    return structured(result);
  }
  const image: ImageContent = toImageContent(result.image_base64!);
  const meta: string[] = [];
  if (result.clamped) meta.push('node rect extended past the viewport — image covers the on-screen part only');
  if (result.frozen) meta.push('captured under a frozen game (godot_game_time)');
  return meta.length > 0
    ? [image, { type: 'text', text: meta.join('; ') }]
    : image;
}

export const qaTools = [qa] as AnyToolDefinition[];
