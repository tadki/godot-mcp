import { describe, it, expect, beforeEach } from 'vitest';
import { createMockGodot, createToolContext, MockGodotConnection, structuredOf } from '../helpers/mock-godot.js';
import { nodeRead, nodeEdit } from '../../tools/node.js';

describe('node read tool', () => {
  let mock: MockGodotConnection;

  beforeEach(() => {
    mock = createMockGodot();
  });

  describe('schema validation', () => {
    it('requires node_path for get_properties', () => {
      expect(nodeRead.schema.safeParse({ action: 'get_properties' }).success).toBe(false);
      expect(nodeRead.schema.safeParse({
        action: 'get_properties',
        node_path: '/root/Test',
      }).success).toBe(true);
    });

    it('get_scene_tree accepts optional max_depth / max_children caps', () => {
      expect(nodeRead.schema.safeParse({ action: 'get_scene_tree' }).success).toBe(true);
      expect(nodeRead.schema.safeParse({ action: 'get_scene_tree', max_depth: 3 }).success).toBe(true);
      expect(nodeRead.schema.safeParse({ action: 'get_scene_tree', max_children: 10 }).success).toBe(true);
      // Caps must be positive integers, not zero or fractional.
      expect(nodeRead.schema.safeParse({ action: 'get_scene_tree', max_depth: 0 }).success).toBe(false);
      expect(nodeRead.schema.safeParse({ action: 'get_scene_tree', max_depth: 1.5 }).success).toBe(false);
    });

    it('find requires name_pattern and/or type', () => {
      expect(nodeRead.schema.safeParse({ action: 'find' }).success).toBe(false);
      expect(nodeRead.schema.safeParse({ action: 'find', name_pattern: '*Spawner*' }).success).toBe(true);
      expect(nodeRead.schema.safeParse({ action: 'find', type: 'Area2D' }).success).toBe(true);
    });

    it('rejects the removed create/delete/script/signal actions', () => {
      expect(nodeRead.schema.safeParse({
        action: 'create',
        parent_path: '/root',
        node_type: 'Node2D',
        node_name: 'Test',
      }).success).toBe(false);
      expect(nodeRead.schema.safeParse({
        action: 'delete',
        node_path: '/root/Obsolete',
      }).success).toBe(false);
      expect(nodeRead.schema.safeParse({
        action: 'attach_script',
        node_path: '/root/Test',
        script_path: 'res://test.gd',
      }).success).toBe(false);
      expect(nodeRead.schema.safeParse({
        action: 'connect_signal',
        node_path: '/root/Button',
        signal_name: 'pressed',
        target_path: '/root/Main',
        method_name: '_on_pressed',
      }).success).toBe(false);
    });

    it('rejects edit actions belonging to godot_node_edit', () => {
      expect(nodeRead.schema.safeParse({
        action: 'update',
        node_path: '/root/Test',
        properties: { visible: false },
      }).success).toBe(false);
      expect(nodeRead.schema.safeParse({
        action: 'reparent',
        node_path: '/root/Test',
        new_parent_path: '/root/New',
      }).success).toBe(false);
    });
  });

  describe('get_properties', () => {
    it('returns formatted JSON properties', async () => {
      const properties = { position: { x: 100, y: 200 }, visible: true };
      mock.mockResponse({ properties });
      const ctx = createToolContext(mock);

      const result = await nodeRead.execute({ action: 'get_properties', node_path: '/root/Player' }, ctx);
      expect(structuredOf(result)).toEqual(properties);
    });
  });

  describe('get_scene_tree', () => {
    it('returns the full tree from the editor', async () => {
      const tree = {
        name: 'Main',
        type: 'Node2D',
        children: [{ name: 'Player', type: 'CharacterBody2D' }],
      };
      mock.mockResponse({ tree });
      const ctx = createToolContext(mock);

      const result = await nodeRead.execute({ action: 'get_scene_tree' }, ctx);
      expect(structuredOf(result)).toEqual(tree);
      expect(mock.calls[0].command).toBe('get_scene_tree');
    });

    it('forwards max_depth / max_children caps to the addon', async () => {
      mock.mockResponse({ tree: { name: 'Main', type: 'Node2D', truncated_children: 5 } });
      const ctx = createToolContext(mock);

      await nodeRead.execute({ action: 'get_scene_tree', max_depth: 2, max_children: 10 }, ctx);

      expect(mock.calls[0].command).toBe('get_scene_tree');
      expect(mock.calls[0].params.max_depth).toBe(2);
      expect(mock.calls[0].params.max_children).toBe(10);
    });
  });
});

describe('node edit tool', () => {
  let mock: MockGodotConnection;

  beforeEach(() => {
    mock = createMockGodot();
  });

  describe('schema validation', () => {
    it('requires node_path and properties for update', () => {
      expect(nodeEdit.schema.safeParse({ action: 'update' }).success).toBe(false);
      // properties is required: the addon rejects an empty update outright
      expect(nodeEdit.schema.safeParse({
        action: 'update',
        node_path: '/root/Test',
      }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({
        action: 'update',
        node_path: '/root/Test',
        properties: { visible: false },
      }).success).toBe(true);
    });

    it('requires new_parent_path for reparent', () => {
      expect(nodeEdit.schema.safeParse({
        action: 'reparent',
        node_path: '/root/Test',
      }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({
        action: 'reparent',
        node_path: '/root/Test',
        new_parent_path: '/root/New',
      }).success).toBe(true);
    });

    it('rejects read actions belonging to godot_node_read', () => {
      expect(nodeEdit.schema.safeParse({
        action: 'get_properties',
        node_path: '/root/Test',
      }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'get_scene_tree' }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({
        action: 'find',
        name_pattern: '*Spawner*',
      }).success).toBe(false);
    });

    it('add_node requires parent_path and node_type; index must be a non-negative int', () => {
      expect(nodeEdit.schema.safeParse({ action: 'add_node', parent_path: '/root' }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'add_node', node_type: 'Node2D' }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'add_node', parent_path: '/root', node_type: 'Node2D' }).success).toBe(true);
      expect(nodeEdit.schema.safeParse({ action: 'add_node', parent_path: '/root', node_type: 'Node2D', name: 'Turret', index: 2 }).success).toBe(true);
      expect(nodeEdit.schema.safeParse({ action: 'add_node', parent_path: '/root', node_type: 'Node2D', index: -1 }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'add_node', parent_path: '/root', node_type: 'Node2D', index: 1.5 }).success).toBe(false);
    });

    it('attach_script requires node_path and script_path', () => {
      expect(nodeEdit.schema.safeParse({ action: 'attach_script', node_path: '/root/Test' }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'attach_script', script_path: 'res://x.gd' }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'attach_script', node_path: '/root/Test', script_path: 'res://x.gd' }).success).toBe(true);
    });

    it('connect_signal requires the full quadruple (re-enabled, Owner 2026-10-01)', () => {
      // Partial shapes must still fail validation.
      expect(nodeEdit.schema.safeParse({ action: 'connect_signal', node_path: '/root/B', signal: 'pressed', target_path: '/root/M' }).success).toBe(false);
      expect(nodeEdit.schema.safeParse({ action: 'connect_signal', node_path: '/root/B', signal: 'pressed', target_path: '/root/M', method: '_on_pressed' }).success).toBe(true);
    });
  });

  describe('update/reparent', () => {
    it('returns appropriate confirmations', async () => {
      const ctx = createToolContext(mock);

      mock.mockResponse({});
      expect(await nodeEdit.execute({
        action: 'update',
        node_path: '/root/Player',
        properties: { health: 100 },
      }, ctx)).toBe('Updated node: /root/Player');

      mock.mockResponse({ new_path: '/root/New/Node' });
      expect(await nodeEdit.execute({
        action: 'reparent',
        node_path: '/root/Old/Node',
        new_parent_path: '/root/New',
      }, ctx)).toBe('Reparented node to: /root/New/Node');
    });
  });

  describe('add_node / attach_script / connect_signal (SEE-1356 L4)', () => {
    it('forwards add_node params and surfaces the write contract (revert_hint + saved + save hint)', async () => {
      mock.mockResponse({
        path: '/root/Main/Turret',
        saved: false,
        save_hint: 'Write landed in the editor\'s memory only — call save_scene to persist it',
        revert_hint: { command: 'add_node', node_path: '/root/Main/Turret' },
      });
      const ctx = createToolContext(mock);

      const text = await nodeEdit.execute({
        action: 'add_node',
        parent_path: '/root/Main',
        node_type: 'Node2D',
        name: 'Turret',
        index: 1,
      }, ctx);

      expect(mock.calls[0].command).toBe('add_node');
      expect(mock.calls[0].params).toEqual({ parent_path: '/root/Main', node_type: 'Node2D', name: 'Turret', index: 1 });
      expect(text).toContain('/root/Main/Turret');
      expect(text).toContain('saved: false');
      expect(text).toContain('save_scene');
      expect(text).toContain('add_node');
    });

    it('forwards attach_script and returns the property snapshot', async () => {
      mock.mockResponse({
        path: '/root/Player',
        saved: false,
        save_hint: 'save hint',
        revert_hint: { command: 'attach_script', node_path: '/root/Player', previous_script: '' },
        properties: { speed: 300.0 },
      });
      const ctx = createToolContext(mock);

      const text = await nodeEdit.execute({
        action: 'attach_script',
        node_path: '/root/Player',
        script_path: 'res://player.gd',
      }, ctx);

      expect(mock.calls[0].command).toBe('attach_script');
      expect(mock.calls[0].params).toEqual({ node_path: '/root/Player', script_path: 'res://player.gd' });
      expect(text).toContain('res://player.gd');
      expect(text).toContain('"speed":300');
    });


    it('the description no longer routes structure edits to hand-editing .tscn (§SPEC-L4-03)', () => {
      expect(nodeEdit.description).not.toContain('edit the .tscn file directly');
      expect(nodeEdit.description).toContain('add_node');
      expect(nodeEdit.description).toContain('attach_script');
      // connect_signal re-enabled (Owner 2026-10-01 终局指示): the description
      // documents its direct-write contract; editor_undo/editor_redo (方案A)
      // expose the shared history stack.
      expect(nodeEdit.description).toContain('connect_signal');
      expect(nodeEdit.description).toContain('editor_undo');
      expect(nodeEdit.description).toContain('editor_redo');
      expect(nodeEdit.description).toContain('undoable');
      // The instanced sub-scene rejection is named in the add_node action
      // schema; the tool description states the behavior.
      expect(nodeEdit.description).toContain('instanced sub-scene');
      expect(nodeEdit.description).toContain('instanced sub-scene node are rejected');
    });

    it('forwards connect_signal as the connection quadruple (re-enabled)', async () => {
      mock.mockResponse({
        path: '/root/Button',
        saved: false,
        save_hint: 'save hint',
        revert_hint: { command: 'connect_signal', node_path: '/root/Button', signal: 'pressed', target_path: '/root/Main', method: '_on_pressed' },
      });
      const ctx = createToolContext(mock);

      const text = await nodeEdit.execute({
        action: 'connect_signal',
        node_path: '/root/Button',
        signal: 'pressed',
        target_path: '/root/Main',
        method: '_on_pressed',
      }, ctx);

      expect(mock.calls[0].command).toBe('connect_signal');
      expect(mock.calls[0].params).toEqual({ node_path: '/root/Button', signal: 'pressed', target_path: '/root/Main', method: '_on_pressed' });
      expect(text).toContain('pressed -> /root/Main._on_pressed');
      expect(text).toContain('saved: false');
    });

    it('forwards editor_undo/editor_redo and surfaces the history-cursor signals (方案A)', async () => {
      const ctx = createToolContext(mock);

      mock.mockResponse({ op: 'undo', has_undo: true, has_redo: true, next_action: 'MCP add_node' });
      const undoText = await nodeEdit.execute({ action: 'editor_undo' }, ctx);
      expect(mock.calls[0].command).toBe('editor_undo');
      expect(mock.calls[0].params).toEqual({});
      expect(undoText).toBe('Undid one action (next: MCP add_node; has_undo: true, has_redo: true)');

      mock.mockResponse({ op: 'redo', has_undo: true, has_redo: false, next_action: '' });
      const redoText = await nodeEdit.execute({ action: 'editor_redo' }, ctx);
      expect(mock.calls[1].command).toBe('editor_redo');
      expect(redoText).toBe('Redid one action (next: <none>; has_undo: true, has_redo: false)');
    });

    it('accepts the editor_undo/editor_redo actions in the schema (方案A)', () => {
      expect(nodeEdit.schema.safeParse({ action: 'editor_undo' }).success).toBe(true);
      expect(nodeEdit.schema.safeParse({ action: 'editor_redo' }).success).toBe(true);
    });
  });
});
