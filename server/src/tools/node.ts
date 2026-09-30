import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { structured } from '../core/structured.js';
import type { AnyToolDefinition } from '../core/types.js';

const NodeReadSchema = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('get_properties').describe('Get a node\'s properties'),
      node_path: z.string().describe('Path to the node'),
    }),
    z.object({
      action: z
        .literal('get_scene_tree')
        .describe(
          'Full hierarchy of the open scene as the editor sees it, including children inside instanced sub-scenes (a .tscn file read cannot show those). Deep or wide scenes can be large — cap the result with max_depth and/or max_children; any node whose children are cut off carries "truncated_children": <count of omitted direct children> instead of (or alongside) "children".'
        ),
      max_depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap recursion depth (root = depth 1). Omit for the full tree.'),
      max_children: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap how many children are listed per node. Omit to list every child.'),
    }),
    z.object({
      action: z
        .literal('find')
        .describe(
          'Find nodes by name and/or type. Searches the RUNNING game\'s live tree when a game is playing (spawned entities included); otherwise searches the scene open in the editor.'
        ),
      name_pattern: z
        .string()
        .optional()
        .describe('Glob pattern to match node names, e.g. "*Spawner*", "Turret?"'),
      type: z
        .string()
        .optional()
        .describe('Filter by node type, e.g. "CharacterBody2D", "Area2D"'),
      root_path: z
        .string()
        .optional()
        .describe('Path to start search from (defaults to scene root)'),
    }),
  ])
  // Constraints a discriminated union can't express on its own, so they live here:
  .refine(
    (data) => (data.action === 'find' ? !!data.name_pattern || !!data.type : true),
    { message: 'find requires name_pattern and/or type' }
  );

type NodeReadArgs = z.infer<typeof NodeReadSchema>;

const NodeEditSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update').describe('Update a node\'s properties'),
    node_path: z.string().describe('Path to the node'),
    // Required: the addon rejects an empty update, so publishing this as
    // optional would invite a guaranteed-failure call shape.
    properties: z.record(z.string(), z.unknown()).describe('Properties to set on the node'),
  }),
  z.object({
    action: z.literal('reparent').describe('Move a node to a new parent'),
    node_path: z.string().describe('Path to the node'),
    new_parent_path: z.string().describe('Path to the new parent node'),
  }),
  z.object({
    action: z
      .literal('add_node')
      .describe(
        'Add a new node to the open scene: instantiated from an engine class or a global class_name script, owned by the scene root (an unset owner makes the node silently vanish from the saved .tscn), and inserted at `index` (default: append). Unknown types return a structured UNKNOWN_TYPE error; writes into an instanced sub-scene are rejected (INSTANCED_SCENE). The edit joins the editor undo history and lands in memory — save with godot_scene save to persist.'
      ),
    parent_path: z.string().describe('Path to the parent node (the scene root path or "/" adds a root-level child)'),
    node_type: z.string().describe('Engine class name ("Node2D", "Label", "CharacterBody2D", ...) or a project class_name script class'),
    name: z.string().optional().describe('Node name (must not contain . : @ / or ")'),
    index: z.number().int().min(0).optional().describe('Insert position among the parent\'s children (0 = first). Default: append.'),
  }),
  z.object({
    action: z
      .literal('attach_script')
      .describe(
        'Attach an EXISTING script to a node (set_script) and return the post-attach property snapshot. Script creation/generation is not supported — write the .gd first, then attach it. Joins the editor undo history; lands in memory until godot_scene save.'
      ),
    node_path: z.string().describe('Path to the node'),
    script_path: z.string().describe('Path of an existing script file (res:// or uid://)'),
  }),
  z.object({
    action: z
      .literal('connect_signal')
      .describe(
        'Connect a signal to a target method through the editor undo history (the same commit path the ConnectionsDock uses). Both endpoints must belong to the edited scene — instanced sub-scene nodes are rejected. Lands in memory until godot_scene save.'
      ),
    node_path: z.string().describe('Path to the node that owns the signal'),
    signal: z.string().describe('Signal name on the source node (e.g. "pressed")'),
    target_path: z.string().describe('Path to the node that owns the handler method'),
    method: z.string().describe('Method name on the target node'),
  }),
]);

type NodeEditArgs = z.infer<typeof NodeEditSchema>;

export const nodeRead = defineTool({
  name: 'godot_node_read',
  annotations: {
    title: 'Node (read)',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  description:
    'Inspect scene nodes: read a node\'s effective properties (including class defaults a .tscn read cannot show), view the full scene tree as the editor sees it (including children inside instanced sub-scenes), and find nodes by name or type — find searches the RUNNING game\'s live tree (spawned entities included) while a game is playing, otherwise the scene open in the editor. Use it to discover node paths and verify live state. It cannot modify anything; to update properties or reparent a node, use godot_node_edit.',
  schema: NodeReadSchema,
  async execute(args: NodeReadArgs, { godot }) {
    switch (args.action) {
      case 'get_properties': {
        const result = await godot.sendCommand<{
          properties: Record<string, unknown>;
        }>('get_node_properties', { node_path: args.node_path });
        return structured(result.properties);
      }

      case 'get_scene_tree': {
        const result = await godot.sendCommand<{ tree: unknown }>('get_scene_tree', {
          max_depth: args.max_depth,
          max_children: args.max_children,
        });
        return structured(result.tree as Record<string, unknown>);
      }

      case 'find': {
        const result = await godot.sendCommand<{
          matches: Array<{ path: string; type: string }>;
          count: number;
        }>('find_nodes', {
          name_pattern: args.name_pattern,
          type: args.type,
          root_path: args.root_path,
        });
        if (result.count === 0) {
          return 'No matching nodes found';
        }
        const lines = result.matches.map((m) => `${m.path} (${m.type})`);
        return `Found ${result.count} nodes:\n${lines.join('\n')}`;
      }
    }
  },
});

export const nodeEdit = defineTool({
  name: 'godot_node_edit',
  annotations: {
    title: 'Node (edit)',
    readOnlyHint: false,
    destructiveHint: false,
    // add_node / attach_script / connect_signal are not repeatable without
    // changing state, so the tool-level idempotent hint no longer holds.
    idempotentHint: false,
    openWorldHint: false,
  },
  description:
    'Modify scene nodes in the editor: update a node\'s properties, reparent it, add a new node (add_node), attach an existing script (attach_script), or connect a signal (connect_signal) — structure edits go through the editor\'s own serialization on save, so load_steps/UID/ext_resource stay consistent without hand-editing .tscn. Every write lands in editor memory, joins the undo history, and returns a revert_hint plus a save hint; persist with godot_scene save. Writes targeting an instanced sub-scene node are rejected with a clear error (those nodes are owned by their sub-scene). To inspect properties, the scene tree, or search for nodes, use godot_node_read.',
  schema: NodeEditSchema,
  async execute(args: NodeEditArgs, { godot }) {
    switch (args.action) {
      case 'update': {
        await godot.sendCommand('update_node', {
          node_path: args.node_path,
          properties: args.properties,
        });
        return `Updated node: ${args.node_path}`;
      }

      case 'reparent': {
        const result = await godot.sendCommand<{ new_path: string }>('reparent_node', {
          node_path: args.node_path,
          new_parent_path: args.new_parent_path,
        });
        return `Reparented node to: ${result.new_path}`;
      }

      case 'add_node': {
        // The addon response carries the write contract (revert_hint + saved +
        // save guidance, §SPEC-L4-02) — surface it verbatim so the caller can
        // verify or revert without a second round-trip.
        const result = await godot.sendCommand<{
          path: string;
          saved: boolean;
          save_hint: string;
          revert_hint: Record<string, unknown>;
        }>('add_node', {
          parent_path: args.parent_path,
          node_type: args.node_type,
          name: args.name,
          index: args.index,
        });
        return `Added node at: ${result.path} (saved: ${result.saved}). ${result.save_hint}. Revert hint: ${JSON.stringify(result.revert_hint)}`;
      }

      case 'attach_script': {
        const result = await godot.sendCommand<{
          path: string;
          saved: boolean;
          save_hint: string;
          revert_hint: Record<string, unknown>;
          properties: Record<string, unknown>;
        }>('attach_script', {
          node_path: args.node_path,
          script_path: args.script_path,
        });
        return `Attached ${args.script_path} to ${result.path} (saved: ${result.saved}). ${result.save_hint}. Revert hint: ${JSON.stringify(result.revert_hint)}. Properties: ${JSON.stringify(result.properties)}`;
      }

      case 'connect_signal': {
        const result = await godot.sendCommand<{
          path: string;
          saved: boolean;
          save_hint: string;
          revert_hint: Record<string, unknown>;
        }>('connect_signal', {
          node_path: args.node_path,
          signal: args.signal,
          target_path: args.target_path,
          method: args.method,
        });
        return `Connected ${args.signal} -> ${args.target_path}.${args.method} (saved: ${result.saved}). ${result.save_hint}. Revert hint: ${JSON.stringify(result.revert_hint)}`;
      }
    }
  },
});

export const nodeTools = [nodeRead, nodeEdit] as AnyToolDefinition[];
