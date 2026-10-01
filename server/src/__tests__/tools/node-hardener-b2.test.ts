// SEE-1356 batch-2 hardener — node.ts mutation-face completions (the 6
// survivors + 14 NoCoverage of the 85.40% scoped run). Joins the existing
// node.test.ts face (untouched). Kill classes:
//   A) L4 write-command envelopes: verbatim reply templates + sendCommand
//      name/params literals (revert_hint/saved/save_hint wire contract)
//   B) read-face find: name literals, empty arm, list formatting
//   C) NoCoverage face: the godot_node_read `find` action end-to-end
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockGodot, createToolContext, structuredOf, MockGodotConnection } from '../helpers/mock-godot.js';
import { nodeRead, nodeEdit } from '../../tools/node.js';
import { toInputSchema } from '../../core/schema.js';

const writeResult = (over: Record<string, unknown> = {}) => ({
  path: '/root/New/Turret',
  saved: false,
  save_hint: 'Persist with godot_scene save',
  revert_hint: { op: 'add_node', path: '/root/New/Turret' },
  properties: { script: 'res://x.gd' },
  ...over,
});

describe('nodeEdit L4 write envelopes — hardener survivor kills (batch-2)', () => {
  let mock: MockGodotConnection;
  beforeEach(() => { mock = createMockGodot(); });

  it('add_node: command name + params verbatim; reply template exact (revert_hint JSON included)', async () => {
    // kills: node.ts:196-206 sendCommand name/params ObjectLiteral+StringLiteral
    // mutants and the template-concatenation mutants — the envelope IS the
    // §SPEC-L4-02 wire contract (revert_hint + saved + save guidance).
    mock.mockResponse(writeResult());
    const out = await nodeEdit.execute({
      action: 'add_node', parent_path: '/root/New', node_type: 'Node2D',
      name: 'Turret', index: 2,
    } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.command).toBe('add_node');
    expect(mock.calls.at(-1)!.params).toEqual({
      parent_path: '/root/New', node_type: 'Node2D', name: 'Turret', index: 2,
    });
    expect(out).toBe(
      'Added node at: /root/New/Turret (saved: false). Persist with godot_scene save. Revert hint: {"op":"add_node","path":"/root/New/Turret"}',
    );
  });

  it('attach_script: command + params verbatim; reply carries Properties segment', async () => {
    mock.mockResponse(writeResult({ path: '/root/Test', properties: { script_path: 'res://x.gd', enabled: true } }));
    const out = await nodeEdit.execute({
      action: 'attach_script', node_path: '/root/Test', script_path: 'res://x.gd',
    } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.command).toBe('attach_script');
    expect(mock.calls.at(-1)!.params).toEqual({ node_path: '/root/Test', script_path: 'res://x.gd' });
    expect(out).toBe(
      'Attached res://x.gd to /root/Test (saved: false). Persist with godot_scene save. Revert hint: {"op":"add_node","path":"/root/New/Turret"}. Properties: {"script_path":"res://x.gd","enabled":true}',
    );
  });

  it('per-branch node_path descriptions stay pinned (survivor kill, re-enable round wording)', () => {
    // SEE-1356 re-enable (Owner 2026-10-01): connect_signal rejoined the
    // union, so the merged node_path description names all four branches.
    // The wording stays pinned — agent-facing docs are wire contract.
    const props = (toInputSchema(nodeEdit.schema) as Record<string, unknown>).properties as Record<string, unknown>;
    expect((props.node_path as Record<string, unknown>).description).toBe(
      'for update: Path to the node; for reparent: Path to the node; for attach_script: Path to the node; for connect_signal: Path to the node that owns the signal (required for: update, reparent, attach_script, connect_signal)',
    );
  });

  it('connect_signal is PUBLISHED again (re-enabled, Owner 2026-10-01 终局指示)', () => {
    // Re-enable round: the action rejoined the schema; the DIRECT-write
    // CONNECT_PERSIST form (MCP 写不入 undo 栈) is the published contract.
    const probe = nodeEdit.schema.safeParse({
      action: 'connect_signal', node_path: '/root/Test', signal: 'pressed',
      target_path: '/root/Btn', method: '_on_pressed',
    });
    expect(probe.success).toBe(true);
  });

  it('add_node sends name/index keys even when unset (undefined values, keys present)', async () => {
    // Adversarial self-check: the production code forwards name/index
    // UNCONDITIONALLY (node.ts:204-205) — keys exist with undefined values.
    // An "omit when unset" assumption was tested and REFUTED against the code;
    // pinned here as the actual contract.
    mock.mockResponse(writeResult());
    await nodeEdit.execute({ action: 'add_node', parent_path: '/root', node_type: 'Node' } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.params).toEqual({ parent_path: '/root', node_type: 'Node', name: undefined, index: undefined });
  });

  it('update/reparent survivors: command names + reply templates exact', async () => {
    // kills: node.ts:182/190 name+ObjectLiteral mutants and the reply templates.
    mock.mockResponse({});
    const upd = await nodeEdit.execute({ action: 'update', node_path: '/root/A', properties: { v: 1 } } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.command).toBe('update_node');
    expect(mock.calls.at(-1)!.params).toEqual({ node_path: '/root/A', properties: { v: 1 } });
    expect(upd).toBe('Updated node: /root/A');
    mock.mockResponse({ new_path: '/root/B' });
    const rep = await nodeEdit.execute({ action: 'reparent', node_path: '/root/A', new_parent_path: '/root/B' } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.command).toBe('reparent_node');
    // kills: node.ts:190 ObjectLiteral survivor — an extra/renamed key would
    // change the addon handshake; the params object is pinned EXACTLY.
    expect(mock.calls.at(-1)!.params).toEqual({ node_path: '/root/A', new_parent_path: '/root/B' });
    expect(rep).toBe('Reparented node to: /root/B');
  });
});

describe('nodeRead find face — hardener NoCoverage kills (batch-2)', () => {
  let mock: MockGodotConnection;
  beforeEach(() => { mock = createMockGodot(); });

  it('find forwards command name + the three filters verbatim; empty → exact message', async () => {
    mock.mockResponse({ matches: [], count: 0 });
    const out = await nodeRead.execute({
      action: 'find', name_pattern: '*Spawner*', type: 'Node2D', root_path: '/root',
    } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.command).toBe('find_nodes');
    expect(mock.calls.at(-1)!.params).toEqual({ name_pattern: '*Spawner*', type: 'Node2D', root_path: '/root' });
    expect(out).toBe('No matching nodes found');
  });

  it('find lists matches with the exact "path (type)" line format and count header', async () => {
    mock.mockResponse({
      count: 2,
      matches: [{ path: '/root/Spawner', type: 'Node2D' }, { path: '/root/Spawner2', type: 'Timer' }],
    });
    const out = await nodeRead.execute({ action: 'find', name_pattern: '*Spawn*' } as never, createToolContext(mock));
    expect(out).toBe('Found 2 nodes:\n/root/Spawner (Node2D)\n/root/Spawner2 (Timer)');
  });

  it('find refine: name_pattern and type BOTH absent → rejected with the exact message', async () => {
    // kills: node.ts:54 refine message StringLiteral/ObjectLiteral survivors —
    // the refine itself is exercised by node.test.ts, the MESSAGE text is the
    // machine-readable contract pinned here.
    const none = nodeRead.schema.safeParse({ action: 'find' });
    expect(none.success).toBe(false);
    if (!none.success) {
      expect(none.error.issues[0].message).toBe('find requires name_pattern and/or type');
    }
    expect(nodeRead.schema.safeParse({ action: 'find', name_pattern: 'x' }).success).toBe(true);
    expect(nodeRead.schema.safeParse({ action: 'find', type: 'Node2D' }).success).toBe(true);
  });

  it('get_properties/get_scene_tree command names + structured passthrough', async () => {
    // kills: node.ts:134 name/ObjectLiteral/StringLiteral survivors.
    mock.mockResponse({ properties: { visible: true } });
    await nodeRead.execute({ action: 'get_properties', node_path: '/root/A' } as never, createToolContext(mock));
    expect(mock.calls.at(-1)!.command).toBe('get_node_properties');
    expect(mock.calls.at(-1)!.params).toEqual({ node_path: '/root/A' });
    mock.mockResponse({ tree: { name: 'root' } });
    const tree = await nodeRead.execute({ action: 'get_scene_tree' } as never, createToolContext(mock));
    expect(structuredOf(tree)).toEqual({ name: 'root' });
  });
});
