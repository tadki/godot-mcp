import { describe, it, expect } from 'vitest';
import { toInputSchema } from '../../core/schema.js';
import { nodeRead, nodeEdit } from '../../tools/node.js';
import { animationRead } from '../../tools/animation.js';
import { editorEdit } from '../../tools/editor.js';

type JsonSchema = Record<string, unknown>;

const schemaOf = (tool: { schema: Parameters<typeof toInputSchema>[0] }): JsonSchema =>
  toInputSchema(tool.schema) as JsonSchema;

const actionEnumOf = (schema: JsonSchema): string[] =>
  ((schema.properties as JsonSchema).action as JsonSchema).enum as string[];

describe('discriminated-union tool schemas', () => {
  it('serialize to a flat object schema with an action enum', () => {
    const schema = schemaOf(nodeRead);
    expect(schema.type).toBe('object');
    const actions = actionEnumOf(schema);
    expect(Array.isArray(actions)).toBe(true);
    expect(actions).toEqual(['get_properties', 'get_scene_tree', 'find']);
  });

  it('keep fields required by every branch as top-level required', () => {
    const schema = schemaOf(nodeEdit);
    // SEE-1356 L4 (§SPEC-L4-03): add_node / attach_script / connect_signal
    // (re-enabled, Owner 2026-10-01 终局指示) all joined the union, so no
    // field beyond `action` is common to every branch anymore — node_path
    // dropped out of the top-level required set and each write branch's
    // required fields surface as optionals with scope markers.
    expect(schema.required).toEqual(['action']);
    const props = schema.properties as JsonSchema;
    expect(props).toHaveProperty('new_parent_path');
    expect(props).toHaveProperty('properties');
    expect(props).toHaveProperty('parent_path');
    expect(props).toHaveProperty('node_type');
    expect(props).toHaveProperty('script_path');
    expect(props).toHaveProperty('signal'); // connect_signal re-enabled
    expect(props).toHaveProperty('method');
    expect((props.new_parent_path as JsonSchema).description).toContain('(required for: reparent)');
  });

  it('keep residual constraints the union cannot express on its own', () => {
    // node find requires name_pattern and/or type
    expect(nodeRead.schema.safeParse({ action: 'find' }).success).toBe(false);
    expect(nodeRead.schema.safeParse({ action: 'find', type: 'Area2D' }).success).toBe(true);
    // editor set_viewport_2d requires at least one of center_x / center_y / zoom
    expect(editorEdit.schema.safeParse({ action: 'set_viewport_2d' }).success).toBe(false);
    expect(editorEdit.schema.safeParse({ action: 'set_viewport_2d', zoom: 2 }).success).toBe(true);
  });

  it('reject unknown actions', () => {
    expect(animationRead.schema.safeParse({ action: 'not_a_real_action' }).success).toBe(false);
  });
});
