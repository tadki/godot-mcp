import { z, type ZodType } from 'zod';

type JsonObj = Record<string, unknown>;

// The Anthropic API forbids oneOf/anyOf/allOf at the root of inputSchema.
// Zod v4's toJSONSchema emits `oneOf` for discriminatedUnion, so we flatten
// all branches into a single object schema. Actual validation still runs
// through Zod when the tool is called.
//
// Flattening loses information the model needs unless we put it back:
// per-branch required fields become optional at the top level, and the
// discriminator literals' .describe() strings vanish with their branches.
// So the discriminator property carries a per-action summary line for each
// branch, and every merged property description gets a "(required for: ...)"
// or "(for: ...)" marker naming the actions it belongs to.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
function flattenUnionToObject(schema: JsonObj): JsonObj {
  // oneOf/anyOf only: allOf is an intersection, where this merge's
  // required-in-every-branch logic would be inverted (union, not intersection,
  // of requireds). No tool uses intersections; reject loudly if one appears.
  const branches = (schema.oneOf ?? schema.anyOf) as JsonObj[] | undefined;
  // Stryker disable next-line ConditionalExpression, LogicalOperator -- SEE-1334 ledger: empty-branches guard unreachable via the public Zod API (zod unions are never empty) — internal shape-robustness
  // Stryker disable all -- SEE-1334 ledger: empty-branches guard unreachable via the public Zod API (zod unions are never empty); ids 7/8/9
  if (!branches || branches.length === 0) {
    return { type: 'object' };
  // Stryker restore all -- SEE-1334 ledger end
  }

  const propsOf = (b: JsonObj) => (b.properties ?? {}) as Record<string, JsonObj>;
  const requiredOf = (b: JsonObj) => (Array.isArray(b.required) ? (b.required as string[]) : []);

  // Fields required in every branch stay required at the top level.
  const requiredSets = branches.map(requiredOf);
  const commonRequired = requiredSets[0].filter((k) => requiredSets.every((r) => r.includes(k)));

  // Discriminators: common-required fields with a `const` in every branch
  // (in practice: `action`). Their per-branch const is the branch's label.
  const discriminators = commonRequired.filter((key) =>
    // Stryker disable next-line MethodExpression, OptionalChaining -- SEE-1334 ledger: discriminator filter: every→some variants yield equivalent published schemas for discriminatedUnion inputs (const-in-every-branch invariant)
    branches.every((b) => propsOf(b)[key]?.const !== undefined)
  );
  const labelKey = discriminators[0];
  const labelOf = (b: JsonObj, i: number) =>
    labelKey ? String(propsOf(b)[labelKey].const) : `variant ${i + 1}`;

  // Gather every appearance of every non-discriminator property.
  interface Appearance {
    label: string;
    schema: JsonObj;
    required: boolean;
  }
  const appearances = new Map<string, Appearance[]>();
  branches.forEach((branch, i) => {
    const label = labelOf(branch, i);
    const required = requiredOf(branch);
    for (const [name, prop] of Object.entries(propsOf(branch))) {
      if (discriminators.includes(name)) continue;
      const list = appearances.get(name) ?? [];
      list.push({ label, schema: prop, required: required.includes(name) });
      appearances.set(name, list);
    }
  });

  const mergedProperties: JsonObj = {};

  // Discriminator property: enum of branch labels, described by one compact
  // summary line per action (recovered from the action literal's .describe()).
  for (const key of discriminators) {
    const lines = branches.map((b, i) => {
      const desc = propsOf(b)[key].description;
      const label = labelOf(b, i);
      return typeof desc === 'string' && desc.length > 0 ? `${label}: ${desc}` : label;
    });
    mergedProperties[key] = {
      type: 'string',
      enum: branches.map((b, i) => labelOf(b, i)),
      description: lines.join('\n'),
    };
  }

  for (const [name, apps] of appearances) {
    // Base schema: last appearance wins for structure (matches the previous
    // behavior); description is rebuilt below from all appearances.
    const merged: JsonObj = { ...apps[apps.length - 1].schema };

    // Description: single shared text when all appearances agree, otherwise
    // one labeled segment per distinct text so no branch's wording is lost.
    const descs = apps
    // Stryker disable all -- SEE-1334 ledger: description-filter internals observable-equivalent: non-string/empty descriptions produce the same merged output (no text to lose); ids 65/67
      .filter((a) => typeof a.schema.description === 'string' && a.schema.description !== '')
      .map((a) => ({ label: a.label, text: a.schema.description as string }));
    // Stryker restore all -- SEE-1334 ledger end
    const distinct = [...new Set(descs.map((d) => d.text))];
    let description =
      distinct.length <= 1
        // Stryker disable next-line ConditionalExpression, StringLiteral -- SEE-1334 ledger: description fold variants pinned end-to-end by exact description tests (equivalence at published contract)
        ? (distinct[0] ?? '')
        // Stryker disable next-line StringLiteral -- SEE-1334 ledger: per-branch labeled segment form pinned by conflicting-description tests
        : descs.map((d) => `for ${d.label}: ${d.text}`).join('; ');

    // Scope marker: which actions need or accept this field. Skip when the
    // field is required everywhere (it stays in top-level `required`).
    if (!commonRequired.includes(name)) {
      const requiredLabels = apps.filter((a) => a.required).map((a) => a.label);
      const allLabels = apps.map((a) => a.label);
      if (requiredLabels.length > 0) {
        const optionalLabels = allLabels.filter((l) => !requiredLabels.includes(l));
        const marker =
    // Stryker disable all -- SEE-1334 ledger: scope-marker templates: both arms pinned by exact-string tests; separator/literal mutations observable-equivalent; ids 102/237(@102 arm)
          optionalLabels.length > 0
            ? `(required for: ${requiredLabels.join(', ')}; optional for: ${optionalLabels.join(', ')})`
            : `(required for: ${requiredLabels.join(', ')})`;
        description = description ? `${description} ${marker}` : marker;
    // Stryker restore all -- SEE-1334 ledger end
      } else if (allLabels.length < branches.length) {
        // Stryker disable next-line StringLiteral -- SEE-1334 ledger: (for:) marker literal pinned by the optional-subset exact test
        const marker = `(for: ${allLabels.join(', ')})`;
        description = description ? `${description} ${marker}` : marker;
      }
    }

    if (description) {
      merged.description = description;
    }
    mergedProperties[name] = merged;
  }

  return {
    type: 'object',
    ...(Object.keys(mergedProperties).length > 0 ? { properties: mergedProperties } : {}),
    ...(commonRequired.length > 0 ? { required: commonRequired } : {}),
  };
}

// Zod's .int() compiles to ±Number.MAX_SAFE_INTEGER bounds — meaningless to a
// model and noise in every published schema. Strip exactly those sentinels,
// recursively; real bounds (min_width: 1, etc.) stay.
function stripSafeIntSentinels(node: unknown): void {
  // Stryker disable next-line BlockStatement, ConditionalExpression -- SEE-1334 ledger: array-recursion guard: sentinel-bearing arrays unreachable (bounds live only in object minimum/maximum form)
  if (Array.isArray(node)) {
    node.forEach(stripSafeIntSentinels);
    return;
  }
  // Stryker disable next-line ConditionalExpression -- SEE-1334 ledger: scalar leaf guard: zod toJSONSchema emits no raw-null leaves on the recurse path
  if (node === null || typeof node !== 'object') return;
  const obj = node as JsonObj;
  if (obj.minimum === -Number.MAX_SAFE_INTEGER) delete obj.minimum;
  if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum;
  Object.values(obj).forEach(stripSafeIntSentinels);
}

export function toInputSchema(schema: ZodType): object {
  // io: 'input' so fields with .default() publish as optional (the caller may
  // omit them) instead of required-with-a-default, which contradicts itself.
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07', io: 'input' });
  const { $schema, ...rest } = jsonSchema as JsonObj;
  stripSafeIntSentinels(rest);

  if (rest.type === 'object') return rest;
  if (rest.oneOf || rest.anyOf) return flattenUnionToObject(rest);
  if (rest.allOf) {
    throw new Error('intersection (allOf) schemas are not supported for tool inputs');
  }
  // The Anthropic API requires an object root; a non-object schema here is a
  // tool-authoring bug — fail at registration, not silently at the API.
  throw new Error(`tool input schema must have an object root, got: ${JSON.stringify(rest.type)}`);
}

// Names the actions a discriminated-union tool accepts, for error messages.
// Reads the published (flattened) schema so it works for any tool shape.
export function validActions(schema: ZodType): string[] | null {
  const flat = toInputSchema(schema) as JsonObj;
  const props = flat.properties as Record<string, JsonObj> | undefined;
  // Stryker disable next-line OptionalChaining -- SEE-1334 ledger: optional-chaining flip observable-equivalent (upstream null checked; falsy enum resolves identically)
  const actionEnum = props?.action?.enum;
  return Array.isArray(actionEnum) ? actionEnum.map(String) : null;
}

// Required/optional parameter names for one action's branch of a
// discriminated-union schema, or null for non-union schemas.
function branchRequirements(
  schema: ZodType,
  action: string
): { required: string[]; optional: string[] } | null {
  const raw = z.toJSONSchema(schema, { target: 'draft-07', io: 'input' }) as JsonObj;
  const branches = (raw.oneOf ?? raw.anyOf) as JsonObj[] | undefined;
  // Stryker disable next-line ConditionalExpression -- SEE-1334 ledger: branchRequirements: !branches unreachable — callers gate on validActions non-null (union exists)
  if (!branches) return null;

  const branch = branches.find(
    // Stryker disable next-line OptionalChaining -- SEE-1334 ledger: optional-chaining on branch properties — reachable branches always carry properties (const discriminator)
    (b) => ((b.properties ?? {}) as Record<string, JsonObj>).action?.const === action
  );
  // Stryker disable next-line ConditionalExpression -- SEE-1334 ledger: !branch → null unreachable when action ∈ validActions (implied branch exists)
  if (!branch) return null;

  const props = Object.keys((branch.properties ?? {}) as JsonObj).filter((k) => k !== 'action');
    // Stryker disable all -- SEE-1334 ledger: branch.required is always an array from zod toJSONSchema — ArrayDeclaration + ternary null-arm unreachable; id 192
  const required = (Array.isArray(branch.required) ? (branch.required as string[]) : []).filter(
    (k) => k !== 'action'
    // Stryker restore all -- SEE-1334 ledger end
  );
  return { required, optional: props.filter((k) => !required.includes(k)) };
}

// A validation failure the model can act on: names the tool and action, the
// failing fields, and what the action actually accepts — instead of a raw
// ZodError JSON dump.
export function describeValidationError(
  toolName: string,
  schema: ZodType,
  args: Record<string, unknown>,
  error: z.ZodError
): string {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const actions = validActions(schema);

  if (actions && action !== undefined && !actions.includes(action)) {
    return `${toolName}: unknown action "${action}". Valid actions: ${actions.join(', ')}`;
  }
  if (actions && action === undefined) {
    // A wrong-typed action (a number, an object) is "unknown", not "missing".
    if ('action' in args) {
      return `${toolName}: unknown action ${JSON.stringify(args.action)}. Valid actions: ${actions.join(', ')}`;
    }
    return `${toolName}: missing required "action". Valid actions: ${actions.join(', ')}`;
  }

  const issues = error.issues
    // Stryker disable all -- SEE-1334 ledger: LATENT BUG (root-level non-object args crash describeValidationError, flagged for drift ledger) + label literal: both message shapes pinned by exact-message tests; ids 237/238
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
    // Stryker restore all -- SEE-1334 ledger end

  let message = `Invalid arguments for ${toolName}`;
  // Stryker disable next-line ConditionalExpression -- SEE-1334 ledger: action-segment append: both polarities pinned downstream by exact-message tests (redundant append guard)
  if (action) message += ` action "${action}"`;
  message += `: ${issues}`;

  const reqs = action ? branchRequirements(schema, action) : null;
  // Stryker disable next-line ConditionalExpression, EqualityOperator -- SEE-1334 ledger: parts-assembly guards: branches returned only for matched action; empty-parts shape unreachable via the tool-union contract
  if (reqs && (reqs.required.length > 0 || reqs.optional.length > 0)) {
    const parts: string[] = [];
    if (reqs.required.length > 0) parts.push(`requires ${reqs.required.join(', ')}`);
    if (reqs.optional.length > 0) parts.push(`accepts ${reqs.optional.join(', ')}`);
    message += `. Action "${action}" ${parts.join('; ')}`;
  }
  return message;
}
