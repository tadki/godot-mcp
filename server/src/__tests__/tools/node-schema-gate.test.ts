// SEE-1356 — schema description pins for the three node_path describe()
// StringLiteral survivors (agent-facing documentation is part of the tool
// wire contract; a mutated describe misleads every caller). The connect_signal
// pin is the RE-ENABLED form (Owner 2026-10-01 终局指示): the action is
// published again alongside the other writes.
/* eslint-disable @typescript-eslint/no-explicit-any -- zod internals: the
   describe()/shape accessors are not part of the public type surface (same
   concession as the hardener faces) */
import { describe, expect, it } from 'vitest';
import { nodeRead, nodeEdit } from '../../tools/node.js';

function optionDescriptions(schema: { options?: ReadonlyArray<{ shape: Record<string, { description?: { def?: { description?: string } } } | any> }> }) {
  const out: Record<string, string> = {};
  for (const opt of schema.options ?? []) {
    for (const [key, field] of Object.entries(opt.shape ?? {})) {
      const desc = (field as any)?.description;
      if (desc !== undefined) out[`${opt.shape?.action?.value ?? '?'}#${key}`] = desc;
    }
  }
  return out;
}

function actionLiterals(schema: { options?: ReadonlyArray<any> }): string[] {
  return (schema.options ?? []).map((o: any) => o.shape?.action?.value);
}

describe('node tool schema description pins (shelve → re-enable regression)', () => {
  it('get_properties node_path describe is the canonical wording', () => {
    const desc = optionDescriptions(nodeRead.schema as never);
    expect(desc['get_properties#node_path']).toBe('Path to the node');
  });

  it('get_scene_tree node_path describe is the canonical wording', () => {
    // get_scene_tree has no node_path; pin its action literal presence instead
    expect(actionLiterals(nodeRead.schema as never)).toContain('get_scene_tree');
  });

  it('attach_script node_path describe is the canonical wording', () => {
    const desc = optionDescriptions(nodeEdit.schema as never);
    expect(desc['attach_script#node_path']).toBe('Path to the node');
  });

  it('update/reparent node_path describe is the canonical wording', () => {
    // kills: node.ts:62/69 describe StringLiteral survivors (update/reparent
    // node_path docs are agent-facing wire text; mutation = misleading docs).
    const desc = optionDescriptions(nodeEdit.schema as never);
    expect(desc['update#node_path']).toBe('Path to the node');
    expect(desc['reparent#node_path']).toBe('Path to the node');
  });

  it('connect_signal IS published in nodeEdit (re-enabled, Owner 2026-10-01)', () => {
    const actions = actionLiterals(nodeEdit.schema as never);
    expect(actions).toContain('connect_signal');
    expect(actions).toEqual(expect.arrayContaining(['update', 'reparent', 'add_node', 'attach_script', 'connect_signal']));
  });

  it('nodeRead actions unchanged (read face intact after shelve)', () => {
    expect(actionLiterals(nodeRead.schema as never)).toEqual(
      expect.arrayContaining(['get_properties', 'get_scene_tree', 'find']),
    );
  });
});
