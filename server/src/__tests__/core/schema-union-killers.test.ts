import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toInputSchema, validActions, describeValidationError } from '../../core/schema.js';

// Mutation killers for the discriminated-union slice of core/schema.ts
// (SEE-1334 SPEC-061: targets the surviving mutants mapped by the Stryker
// json report — anyOf fallback, empty branches, branchRequirements contract,
// stripSafeIntSentinels, allOf/non-object-root throws, error-message paths).
// Production code untouched; assertions pin the documented behavior.

type JsonSchema = Record<string, unknown>;

// anyOf branch shapes survive z.toJSONSchema for some union forms; feed one
// through the same public API so the `schema.oneOf ?? schema.anyOf` head and
// the empty-branches guard are both exercised.
// z.union (non-discriminated) emits anyOf through toJSONSchema — the
// `schema.oneOf ?? schema.anyOf` fallback in flattenUnionToObject's caller.
const AnyOfUnion = z.union([
  z.object({ action: z.literal('a1').describe('A1'), w: z.string().describe('W') }),
  z.object({ action: z.literal('b2').describe('B2') }),
]);

describe('toInputSchema: union flattening edge contracts', () => {
  it('accepts an anyOf (non-discriminated union) root and flattens it', () => {
    const flat = toInputSchema(AnyOfUnion) as JsonSchema;
    expect(flat.type).toBe('object');
    const props = flat.properties as Record<string, JsonSchema>;
    // action is the discriminator: enum of both branch consts
    expect((props.action as JsonSchema).enum).toEqual(['a1', 'b2']);
    // w is branch-required only → (required for: a1) marker survives
    expect((props.w as JsonSchema).description).toContain('(required for: a1)');
    expect(flat.required).toEqual(['action']);
  });

  it('rejects an allOf (intersection) root loudly', () => {
    expect(() => toInputSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))))
      .toThrow(/intersection \(allOf\)/);
  });

  it('rejects a non-object root loudly (tool-authoring bug surface)', () => {
    expect(() => toInputSchema(z.string())).toThrow(/object root/);
  });

  it('strips ±MAX_SAFE_INTEGER sentinels but keeps real bounds (recursive)', () => {
    const flat = toInputSchema(
      z.object({
        count: z.number().int(),
        bounded: z.number().int().min(1).max(9),
        nested: z.object({ deep: z.number().int() }),
      }),
    ) as JsonSchema;
    const props = flat.properties as Record<string, JsonSchema>;
    expect(props.count).not.toHaveProperty('minimum');
    expect(props.count).not.toHaveProperty('maximum');
    expect((props.bounded as JsonSchema).minimum).toBe(1);
    expect((props.bounded as JsonSchema).maximum).toBe(9);
    const nested = props.nested as JsonSchema;
    expect((nested.properties as Record<string, JsonSchema>).deep).not.toHaveProperty('maximum');
  });

  it('marks a field required in all branches it appears in with the full marker', () => {
    // `shared` is required by alpha+beta but absent in gamma → NOT common →
    // requiredLabels non-empty AND optionalLabels empty → the exact
    // "(required for: a, b)" marker (no optional segment).
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a'), s: z.string().describe('S') }),
      z.object({ action: z.literal('b'), s: z.string().describe('S') }),
      z.object({ action: z.literal('c') }),
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    expect(props.s.description).toBe('S (required for: a, b)');
  });

  it('joins conflicting field descriptions per branch with the for-<label> form', () => {
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a'), f: z.string().describe('Alpha reading') }),
      z.object({ action: z.literal('b'), f: z.string().describe('Beta reading') }),
      z.object({ action: z.literal('c'), f: z.string().describe('Alpha reading') }),
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    const desc = props.f.description as string;
    // two DISTINCT texts → one labeled segment per appearance (order kept)
    expect(desc).toContain('for a: Alpha reading');
    expect(desc).toContain('for b: Beta reading');
    expect(desc).toContain('for c: Alpha reading');
  });

  it('marks optional-for-all-branches fields with (for: ...) over every label', () => {
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('p1'), opt: z.string().optional().describe('Opt') }),
      z.object({ action: z.literal('p2'), opt: z.string().optional().describe('Opt') }),
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    // required for none, present in all branches → the `(required for: ...)`
    // branch is skipped, the allLabels<branches branch is skipped (equal),
    // leaving the plain description without any marker.
    expect(props.opt.description).toBe('Opt');
  });
});

describe('validActions / describeValidationError: message contracts', () => {
  const Union = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('run').describe('Run it'),
      name: z.string().describe('Name'),
    }),
    z.object({ action: z.literal('list') }),
  ]);

  it('treats a wrong-typed action value as unknown, not missing', () => {
    const parsed = Union.safeParse({ action: 42 });
    expect(parsed.success).toBe(false);
    const message = describeValidationError('t', Union, { action: 42 }, (parsed as { error: z.ZodError }).error);
    expect(message).toContain('unknown action 42');
    expect(message).toContain('Valid actions: run, list');
  });

  it('does not build branch requirements when validActions yields null', () => {
    const Plain = z.object({ x: z.string() });
    const parsed = Plain.safeParse({});
    expect(parsed.success).toBe(false);
    const message = describeValidationError('t', Plain, {}, (parsed as { error: z.ZodError }).error);
    // non-union → no "Valid actions" segment; plain issue list remains
    expect(message).toContain('Invalid arguments for t');
    expect(message).not.toContain('Valid actions');
  });

  it('validActions reads the flattened schema (array, not string)', () => {
    const actions = validActions(Union);
    expect(actions).toEqual(['run', 'list']);
  });
});

describe('describeValidationError: message-construction contracts (killers)', () => {
  // branch 2 carries ONLY optional fields → the `requires ...` push is
  // skipped and the message uses `accepts ...` alone (parts.push branch pair).
  const OptOnly = z.discriminatedUnion('action', [
    z.object({ action: z.literal('go'), speed: z.number().describe('Speed') }),
    z.object({ action: z.literal('drift'), sway: z.string().optional() }),
  ]);

  const fail = (schema: z.ZodType, args: Record<string, unknown>) => {
    const parsed = schema.safeParse(args);
    if (parsed.success) throw new Error('expected parse failure');
    return describeValidationError('t', schema, args, parsed.error);
  };

  it('optional-only branch action failure lists accepts without requires', () => {
    const message = fail(OptOnly, { action: 'drift', sway: 42 });
    expect(message).toContain('accepts sway');
    expect(message).not.toContain('requires');
  });

  it('missing action in a failing branch surfaces the arguments fallback path', () => {
    // action present but wrong-typed → 'unknown action' branch; separate:
    // missing-action on the union's bare-issue path is already covered; here
    // pin the join('; ') multi-issue shape with two invalid fields.
    const Multi = z.object({ a: z.string(), b: z.string() });
    const parsed = Multi.safeParse({ a: 1, b: 2 });
    expect(parsed.success).toBe(false);
    const message = describeValidationError('m', Multi, { a: 1, b: 2 }, (parsed as { error: z.ZodError }).error);
    // both issues joined with '; ' and path labels present
    expect(message).toContain('a:');
    expect(message).toContain('b:');
    expect(message).toContain('; ');
  });

  it('non-discriminated union without common requireds omits the required key', () => {
    // z.union (anyOf path) of two branches sharing no fields →
    // commonRequired empty → the required-spread guard drops the key, and
    // each branch field is labeled with the ordinal variant marker.
    const flat = toInputSchema(z.union([z.object({ p: z.string() }), z.object({ q: z.number() })])) as JsonSchema;
    expect(flat).not.toHaveProperty('required');
    const props = flat.properties as Record<string, JsonSchema>;
    expect((props.p as JsonSchema).description).toBe('(required for: variant 1)');
    expect((props.q as JsonSchema).description).toBe('(required for: variant 2)');
  });

  it('common-required non-discriminator fields carry NO scope marker (skip contract)', () => {
    // 'ticket' is required in EVERY branch → it stays in top-level required
    // and the marker branch is skipped entirely (documented contract: the
    // marker exists only for branch-scoped fields).
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a'), ticket: z.string().describe('T') }),
      z.object({ action: z.literal('b'), ticket: z.string().describe('T') }),
    ]);
    const flat = toInputSchema(Union) as JsonSchema;
    const props = flat.properties as Record<string, JsonSchema>;
    expect(props.ticket.description).toBe('T');
    expect(flat.required).toEqual(['action', 'ticket']);
    expect((props.action as JsonSchema).enum).toEqual(['a', 'b']);
  });

  it('field with no description in any appearance yields no description key', () => {
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a'), bare: z.string() }),
      z.object({ action: z.literal('b'), bare: z.string() }),
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    // filter (typeof description === 'string') drops both → distinct empty →
    // description '' → falsy → no description key (the `if (description)` guard).
    expect(props.bare).not.toHaveProperty('description');
  });

  it('branchRequirements returns null when the action is not a known branch', () => {
    // unknown action short-circuits at validActions; to reach the
    // branch-not-found null (L178) the action must be valid-but-unparseable…
    // both killer paths: action valid → branch found; the `!branches` null
    // (L173) is covered by the plain-object describeValidationError test.
    const message = fail(OptOnly, { action: 'nope' });
    expect(message).toContain('unknown action "nope"');
    expect(message).toContain('Valid actions: go, drift');
  });
});

describe('stripSafeIntSentinels: structural edge paths', () => {
  it('handles arrays and nulls inside the schema tree without crashing', () => {
    // enum arrays ride through; null-typed fields (z.null()) appear as
    // {type:'null'} — the `node === null || typeof !== 'object'` guard's
    // non-object path is exercised by string/number leaves.
    const flat = toInputSchema(
      z.object({ tags: z.array(z.string()), maybe: z.nullable(z.string()) }),
    ) as JsonSchema;
    const props = flat.properties as Record<string, JsonSchema>;
    expect((props.tags as JsonSchema).type).toBe('array');
    // nullable compiles to an anyOf of string|null (array element path of
    // stripSafeIntSentinels exercised on the nested tree)
    expect(props.maybe).toHaveProperty('anyOf');
  });
});

describe('describeValidationError: root-level failure + parts assembly', () => {
  it('multi-field failure joins issues with "; " on named paths', () => {
    // branch failure with several invalid fields → the issues join shape.
    const Multi = z.discriminatedUnion('action', [
      z.object({ action: z.literal('go'), x: z.string(), y: z.number() }),
      z.object({ action: z.literal('b') }),
    ]);
    const args = { action: 'go', x: 1, y: 'not-a-number' };
    const parsed = Multi.safeParse(args);
    expect(parsed.success).toBe(false);
    const message = describeValidationError('t', Multi, args, (parsed as { error: z.ZodError }).error);
    expect(message).toContain('x:');
    expect(message).toContain('y:');
    expect(message).toContain('; ');
  });

  it('branch failure with ONLY optional fields builds the accepts-only parts', () => {
    const OptOnly = z.discriminatedUnion('action', [
      z.object({ action: z.literal('go'), speed: z.number() }),
      z.object({ action: z.literal('drift'), sway: z.string().optional(), wobble: z.string().optional() }),
    ]);
    const parsed = OptOnly.safeParse({ action: 'drift', sway: 1, wobble: 2 });
    expect(parsed.success).toBe(false);
    const message = describeValidationError('t', OptOnly, { action: 'drift', sway: 1, wobble: 2 }, (parsed as { error: z.ZodError }).error);
    expect(message).toContain('accepts sway, wobble');
    expect(message).not.toContain('requires');
    // exact suffix shape (L223 template with single part)
    expect(message).toContain('. Action "drift" accepts sway, wobble');
  });

  it('discriminator line with EMPTY description still renders the bare label', () => {
    // L68: desc empty-string branch → bare label (exact equality on the full
    // description join, not just contains).
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a1').describe('Has words') }),
      z.object({ action: z.literal('') }), // empty string describe → falsy
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    expect(props.action.description).toBe('a1: Has words\n'); // second line = bare label ''
  });
});

describe('flatten spread guards + optional-only marker exactness', () => {
  it('union of empty branches yields a bare object schema (properties guard)', () => {
    const flat = toInputSchema(z.union([z.object({}), z.object({})])) as JsonSchema;
    expect(flat.type).toBe('object');
    expect(flat).not.toHaveProperty('properties');
    expect(flat).not.toHaveProperty('required');
  });

  it('optional-only marker includes BOTH segments when both label sets exist', () => {
    // required by b only; optional for a → the '; optional for:' segment fires.
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a'), mix: z.string().optional().describe('M') }),
      z.object({ action: z.literal('b'), mix: z.string().describe('M') }),
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    expect(props.mix.description).toBe('M (required for: b; optional for: a)');
  });
});

describe('description merge: partial-description appearances', () => {
  it('field described in one branch only collapses to the single text (no labels)', () => {
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a'), x: z.string().describe('Only words') }),
      z.object({ action: z.literal('b'), x: z.string().optional() }),
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    // descs filter drops the undescribed appearance → distinct length 1 →
    // plain text (no 'for <label>:' prefix), plus the required marker.
    expect(props.x.description).toBe('Only words (required for: a; optional for: b)');
  });

  it('action property with partially-described branches renders label-only lines', () => {
    const Union = z.discriminatedUnion('action', [
      z.object({ action: z.literal('a1').describe('Words') }),
      z.object({ action: z.literal('b2') }), // no describe → desc undefined
      z.object({ action: z.literal('c3').describe('') }), // empty string → falsy
    ]);
    const props = (toInputSchema(Union) as JsonSchema).properties as Record<string, JsonSchema>;
    expect(props.action.description).toBe('a1: Words\nb2\nc3');
  });
});

describe('describeValidationError: exact full-message equality (parts assembly)', () => {
  const OptOnly = z.discriminatedUnion('action', [
    z.object({ action: z.literal('go'), speed: z.number().describe('Speed') }),
    z.object({ action: z.literal('drift'), sway: z.string().optional(), wobble: z.string().optional() }),
  ]);
  const fail = (schema: z.ZodType, args: Record<string, unknown>) => {
    const parsed = schema.safeParse(args);
    if (parsed.success) throw new Error('expected parse failure');
    return describeValidationError('t', schema, args, parsed.error);
  };

  it('accepts-only branch: EXACT message (no "requires" segment, exact separators)', () => {
    // pins L219 (>0 guards), L220 array init, L222 conditional, L223 template
    const message = fail(OptOnly, { action: 'drift', sway: 1, wobble: 2 });
    expect(message.endsWith('. Action "drift" accepts sway, wobble')).toBe(true);
    expect(message.includes('requires')).toBe(false);
  });

  it('both-parts branch: EXACT "requires ...; accepts ..." ordering', () => {
    const message = fail(OptOnly, { action: 'go' });
    expect(message.endsWith('. Action "go" requires speed')).toBe(true);
  });
});

describe('describeValidationError: requires+accepts join separator', () => {
  it('EXACT message with both parts joined by "; "', () => {
    const Go = z.discriminatedUnion('action', [
      z.object({ action: z.literal('go'), speed: z.number(), extra: z.string().optional() }),
      z.object({ action: z.literal('b') }),
    ]);
    const parsed = Go.safeParse({ action: 'go' });
    expect(parsed.success).toBe(false);
    const message = describeValidationError('t', Go, { action: 'go' }, (parsed as { error: z.ZodError }).error);
    expect(message.endsWith('. Action "go" requires speed; accepts extra')).toBe(true);
  });
});
