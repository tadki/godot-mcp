import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  warningRateLimited: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};
vi.mock('../../connection/websocket.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../connection/websocket.js')>();
  return { ...mod, getGodotConnection: vi.fn(), initializeConnection: vi.fn(() => Promise.resolve()) };
});

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

// Capture the Server instance main() constructs so the registered handlers can
// be driven in-process (registry is a singleton with no reset API — a second
// main() would throw "already registered" — so we stub the constructor).
let capturedServer: Server | null = null;

vi.mock('@modelcontextprotocol/sdk/server/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/index.js')>();
  const RealServer = mod.Server;
  const SpyServer = class extends RealServer {
    constructor(...args: ConstructorParameters<typeof RealServer>) {
      super(...args);
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- subclass capture needs the instance ref
      capturedServer = this;
    }
  };
  return { ...mod, Server: SpyServer };
});

// executeTool stubbed to return a value the test chooses — the handler's
// result-shape branches (string / array / structured / raw / error) are what
// we drive. registerAllTools recorded so the readOnly gate arms are asserted
// through main() itself (the pure-function isReadOnlyMode has no direct
// export — its observable contract IS the flag passed to registerAllTools).
const stubExecute = vi.fn();
const registerAllToolsCalls: Array<{ readOnly: boolean; names: string[] }> = [];
vi.mock('../../core/registry.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../core/registry.js')>();
  const realRegistry = mod.registry;
  const stubbed = Object.create(Object.getPrototypeOf(realRegistry), {
    executeTool: { value: (...a: unknown[]) => stubExecute(...a), writable: true },
    getToolList: { value: () => realRegistry.getToolList(), writable: true },
    registerTool: { value: () => undefined, writable: true },
    registerTools: { value: () => undefined, writable: true },
  });
  return { ...mod, registry: stubbed };
});
vi.mock('../../tools/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../tools/index.js')>();
  // Derive the full tool-name list from the module's real tool arrays (the
  // re-exports at the bottom of tools/index.ts).
  const all = (Object.values(mod).filter(Array.isArray) as Array<Array<{ name: string }>>)
    .flat()
    .map((t) => t.name)
    .filter(Boolean);
  return {
    ...mod,
    registerAllTools: (opts: { readOnly?: boolean } = {}) => {
      // Mirror the real readOnly filter so getToolList-backed assertions
      // observe the same surface the production registration produces.
      void all;
      registerAllToolsCalls.push({ readOnly: opts.readOnly === true, names: [] });
    },
  };
});

function makeFakeTransport(): Transport {
  const t = {
    started: false,
    async start(this: { started: boolean }) { this.started = true; },
    async send() {},
    async close() {},
  };
  return t as unknown as Transport;
}

const boot = async () => {
  const { main } = await import('../../index.js');
  await main({ createTransport: makeFakeTransport, connectGodot: () => new Promise<void>(() => {}) });
  if (!capturedServer) throw new Error('Server not captured');
  return capturedServer;
};

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown };

const callTool = async (server: Server, name = 'any_tool', args: Record<string, unknown> = {}): Promise<ToolResult> => {
  // The SDK routes through the registered handler; invoke it directly.
  const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<ToolResult>> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('CallToolRequest handler not registered');
  return handler({ method: 'tools/call', params: { name, arguments: args } });
};

describe('SEE-1348 补单 A: index.ts Server metadata + boot surface (in-process, SDK-driven)', () => {
  it('Server description + websiteUrl literals pinned (44-47 region)', async () => {
    stubExecute.mockResolvedValueOnce('x');
    const server = await boot();
    const sv = server as unknown as { _serverInfo: Record<string, string> };
    expect(sv._serverInfo.description).toBe(
      'Eyes and hands in the Godot editor and the running game: scene and node editing, ' +
      'input injection, deterministic game-time control, and live runtime state for ' +
      'agent-driven playtesting.');
    expect(sv._serverInfo.websiteUrl).toBe('https://github.com/satelliteoflove/godot-mcp');
  });

  it('Server metadata is pinned: name/title/version and the full instruction text (string-literal mutants)', async () => {
    stubExecute.mockResolvedValueOnce('x');
    const server = await boot();
    const sv = server as unknown as { _serverInfo: Record<string, string>; _options: { instructions?: string } };
    const serverInfo = sv._serverInfo;
    const opts = { serverInfo, instructions: sv._options.instructions ?? '' };
    expect(opts.serverInfo.name).toBe('godot-mcp');
    expect(opts.serverInfo.title).toBe('Godot MCP');
    expect(opts.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    // Exact-equality (not contains): every concat segment of the instruction
    // string is pinned — a "" replacement in ANY segment breaks equality, so
    // the whole 60-93 survivor region dies.
    expect(opts.instructions).toBe(
      'godot-mcp controls a live Godot editor and the game it runs: open/save scenes, ' +
      'inspect and edit nodes, animations, tilemaps, and gridmaps, run the game and ' +
      'drive it like a player (input injection, frozen game-time stepping, in-game ' +
      'GDScript for scenario setup), and observe it cheaply: ' +
      'read project settings, engine-computed 3D data, runtime-state digests instead of ' +
      'screenshots, profiler data, and editor logs. Reach for godot_* tools whenever a ' +
      'task touches a Godot project; all godot_*_read tools are safe to auto-allow. ' +
      'Requires the editor to be open with the godot-mcp addon enabled. ' +
      'Godot pitfalls that produce no errors: ' +
      '(1) If 3D rendering looks wrong with nothing in any log (black/too-dark surfaces, ' +
      'invisible or one-sided walls/floors, lighting that ignores light changes), run ' +
      'godot_validate_meshes BEFORE tuning lights or materials — procedurally generated ' +
      'meshes are often silently corrupt (winding, dropped triangles, bad tangents). ' +
      '(2) SDFGI replaces constant ambient light: to lift shadow sides, add a dim ' +
      'shadowless DirectionalLight (light_specular=0) opposing the key light instead of ' +
      'raising ambient_light_energy, which will appear to do nothing. ' +
      'Screenshots never decay — each frame persists in context every later turn — so capture ' +
      'the fewest at a modest width and only to judge APPEARANCE; prefer godot_runtime_state ' +
      'digests (text, ~free) for value checks. ' +
      '(3) To TEST edited .gd code, just godot_editor_edit stop then run — the ' +
      'launched game loads scripts fresh from disk, so no restart is needed. Use ' +
      'restart only for EDITOR-side staleness: edited @tool/addon/plugin code, or a ' +
      '.gdshader the editor still renders from a cached compile. ' +
      '(4) After editing project.godot on disk, run godot_project check_stale (the ' +
      'editor never re-reads it); restart to apply changed autoloads/input map.');
  });
});

describe('SEE-1348 补单 A: index.ts readOnly gate arms (isReadOnlyMode via registerAllTools flag)', () => {
  beforeEach(() => {
    stubExecute.mockReset();
    registerAllToolsCalls.length = 0;
    loggerMock.warning.mockClear(); loggerMock.info.mockClear(); loggerMock.error.mockClear();
    delete process.env.GODOT_MCP_READ_ONLY;
  });
  afterEach(() => { delete process.env.GODOT_MCP_READ_ONLY; });

  it('env=1 → readOnly true + the read-only warning carries its exact message (string-literal pin)', async () => {
    process.env.GODOT_MCP_READ_ONLY = '1';
    await boot();
    expect(registerAllToolsCalls).toEqual([{ readOnly: true, names: [] }]);
    expect(loggerMock.warning).toHaveBeenCalledWith('Read-only mode: write tools are not registered');
  });

  it('env="true" (any case) → readOnly true (toLowerCase arm)', async () => {
    process.env.GODOT_MCP_READ_ONLY = 'TRUE';
    await boot();
    expect(registerAllToolsCalls).toEqual([{ readOnly: true, names: [] }]);
  });

  it('env="0" → readOnly false (no fallback-to-true)', async () => {
    process.env.GODOT_MCP_READ_ONLY = '0';
    await boot();
    expect(registerAllToolsCalls).toEqual([{ readOnly: false, names: [] }]);
  });

  it('env unset → readOnly false, and the warning is NOT logged (if-guard polarity)', async () => {
    await boot();
    expect(registerAllToolsCalls).toEqual([{ readOnly: false, names: [] }]);
    expect(loggerMock.warning).not.toHaveBeenCalledWith('Read-only mode: write tools are not registered');
  });

  it('readOnly ON: instructions use the READ-ONLY preamble + read-only (3) segment (both ternary arms)', async () => {
    process.env.GODOT_MCP_READ_ONLY = '1';
    const server = await boot();
    const sv = server as unknown as { _serverInfo: Record<string, string>; _options: { instructions?: string } };
    expect(sv._options.instructions).toBe(
      'godot-mcp is running in READ-ONLY mode: only observation tools are registered ' +
      '(no scene/node/animation edits, no running or stopping the game, no input ' +
      'injection, no in-game GDScript). godot-mcp observes a live Godot editor and ' +
      'the game it runs: ' +
      'read project settings, engine-computed 3D data, runtime-state digests instead of ' +
      'screenshots, profiler data, and editor logs. Reach for godot_* tools whenever a ' +
      'task touches a Godot project; all godot_*_read tools are safe to auto-allow. ' +
      'Requires the editor to be open with the godot-mcp addon enabled. ' +
      'Godot pitfalls that produce no errors: ' +
      '(1) If 3D rendering looks wrong with nothing in any log (black/too-dark surfaces, ' +
      'invisible or one-sided walls/floors, lighting that ignores light changes), run ' +
      'godot_validate_meshes BEFORE tuning lights or materials — procedurally generated ' +
      'meshes are often silently corrupt (winding, dropped triangles, bad tangents). ' +
      '(2) SDFGI replaces constant ambient light: to lift shadow sides, add a dim ' +
      'shadowless DirectionalLight (light_specular=0) opposing the key light instead of ' +
      'raising ambient_light_energy, which will appear to do nothing. ' +
      'Screenshots never decay — each frame persists in context every later turn — so capture ' +
      'the fewest at a modest width and only to judge APPEARANCE; prefer godot_runtime_state ' +
      'digests (text, ~free) for value checks. ' +
      "(3) The running editor can hold stale @tool/addon code or an out-of-date " +
      'project.godot after external edits (godot_project check_stale detects the ' +
      "latter); clearing it needs an editor restart, which is the user's call in " +
      'read-only mode.');
  });
});

describe('SEE-1348 补单 A: index.ts background-connect error path + startup log', () => {
  beforeEach(() => {
    loggerMock.warning.mockClear(); loggerMock.error.mockClear(); loggerMock.info.mockClear();
  });

  it('background connect rejection logs the error with its message (177-179)', async () => {
    const { main } = await import('../../index.js');
    await main({
      createTransport: makeFakeTransport,
      connectGodot: () => Promise.reject(new Error('host unreachable')),
    });
    // A microtask turn for the void catch to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(loggerMock.error).toHaveBeenCalledWith('Background Godot connection setup failed', { error: 'host unreachable' });
  });

  it('startup logs Server started (171)', async () => {
    const { main } = await import('../../index.js');
    await main({ createTransport: makeFakeTransport, connectGodot: () => new Promise<void>(() => {}) });
    expect(loggerMock.info).toHaveBeenCalledWith('Server started');
  });
});

describe('SEE-1348 补单 A: index.ts shutdown + stdin wiring (gracefulShutdown surface)', () => {
  beforeEach(() => {
    stubExecute.mockReset();
    registerAllToolsCalls.length = 0;
  });

  it('gracefulShutdown body: invoked onclose logs "Shutting down", disconnects the connection, idempotent (153/166)', async () => {
    const { getGodotConnection } = await import('../../connection/websocket.js');
    const disconnectSpy = vi.fn();
    vi.mocked(getGodotConnection).mockReturnValueOnce({
      disconnect: disconnectSpy,
    } as never);
    const server = await boot();
    loggerMock.info.mockClear();
    // Fire the shutdown trigger twice — the isShuttingDown latch makes the
    // second call a no-op (single "Shutting down" log, single disconnect).
    const onclose = (server as unknown as { onclose: () => void }).onclose;
    // Capture the deferred exit callback instead of letting it fire.
    const realSetTimeout = globalThis.setTimeout;
    let exitCb: (() => void) | null = null;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      void code; return undefined as never;
    }) as never);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      exitCb = fn;
      void ms;
      return 0 as never;
    }) as never);
    try {
      onclose();
      onclose();
      expect(loggerMock.info.mock.calls.filter((c) => c[0] === 'Shutting down').length).toBe(1);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      // 112: the deferred callback must actually call process.exit(0) — the
      // ()=>undefined mutant leaves exitSpy untouched.
      expect(exitCb).not.toBeNull();
      (exitCb as unknown as () => void)();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      (globalThis.setTimeout as unknown as { mockRestore?: () => void }).mockRestore?.();
      void realSetTimeout;
    }
  });

  it('registers SIGTERM/SIGINT handlers and the transport close path (wiring, not side effects)', async () => {
    const sigterm = vi.fn();
    const sigint = vi.fn();
    const origOn = process.on.bind(process);
    const spyOn = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: never) => {
      if (event === 'SIGTERM') sigterm(handler);
      else if (event === 'SIGINT') sigint(handler);
      return origOn(event as never, handler);
    }) as never);
    try {
      const server = await boot();
      // The transport is wired as the onclose shutdown trigger (#319 order).
      expect(typeof (server as unknown as { onclose: unknown }).onclose).toBe('function');
      // 163: stdin 'end' must be wired to gracefulShutdown — firing it logs
      // the shutdown line (an ()=>undefined mutant logs nothing).
      loggerMock.info.mockClear();
      process.stdin.emit('end');
      expect(loggerMock.info).toHaveBeenCalledWith('Shutting down');
      // Event names pinned exactly (165/166 literals) — the registered-name
      // list must contain each literal; a "" mutant registers under '' and
      // the literal disappears from the list.
      const registered = spyOn.mock.calls.map((c) => c[0]);
      expect(registered.filter((e) => e === 'SIGTERM').length).toBe(1);
      expect(registered.filter((e) => e === 'SIGINT').length).toBe(1);
      expect(sigterm).toHaveBeenCalled();
      expect(sigint).toHaveBeenCalled();
      void server;
    } finally {
      spyOn.mockRestore();
    }
  });
});

describe('SEE-1348 补单 A: index.ts CallTool handler result shapes (in-process, SDK-driven)', () => {
  beforeEach(() => { stubExecute.mockReset(); });
  it('string result → single text content', async () => {
    stubExecute.mockResolvedValueOnce('plain string result');
    const server = await boot();
    const r = await callTool(server);
    expect(r.content).toEqual([{ type: 'text', text: 'plain string result' }]);
    expect(r.isError).toBeUndefined();
  });

  it('array result → content passed through as-is', async () => {
    const arr = [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }];
    stubExecute.mockResolvedValueOnce(arr);
    const server = await boot();
    const r = await callTool(server);
    expect(r.content).toEqual(arr);
  });

  it('structured result → text + structuredContent both carried', async () => {
    stubExecute.mockResolvedValueOnce({ text: '{"k":1}', structuredContent: { k: 1 } });
    const server = await boot();
    const r = await callTool(server);
    expect(r.content).toEqual([{ type: 'text', text: '{"k":1}' }]);
    expect(r.structuredContent).toEqual({ k: 1 });
  });

  it('raw object result → wrapped in a single content item (SDK validates the envelope)', async () => {
    stubExecute.mockResolvedValueOnce({ foo: 'bar' });
    const server = await boot();
    // The handler wraps the raw object as a single content item; the SDK then
    // REJECTS it as a non-conforming CallToolResult — proving the wrap happened
    // (an un-wrapped raw object would fail differently) while documenting that
    // this branch is a degenerate passthrough, not a supported shape.
    await expect(callTool(server)).rejects.toThrow(/Invalid tools\/call result/);
  });

  it('thrown GodotConnectionClosedError → isError with the [CODE] prefix (F-QA-5 surface)', async () => {
    const { GodotConnectionClosedError } = await import('../../utils/errors.js');
    stubExecute.mockRejectedValueOnce(new GodotConnectionClosedError('CONNECTION_LOST', 'Connection closed'));
    const server = await boot();
    const r = await callTool(server);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error: [CONNECTION_LOST] Connection closed');
  });

  it('thrown plain Error → isError with the bare message', async () => {
    stubExecute.mockRejectedValueOnce(new Error('boom'));
    const server = await boot();
    const r = await callTool(server);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error: boom');
  });

  it('missing arguments field → executeTool receives {} (nullish-coalescing polarity, 106)', async () => {
    stubExecute.mockResolvedValueOnce('ok');
    const server = await boot();
    const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<ToolResult>> })._requestHandlers;
    await handlers.get('tools/call')!({ method: 'tools/call', params: { name: 'any_tool' } });
    expect(stubExecute.mock.calls[0][1]).toEqual({});
    // And a supplied args object passes through verbatim (the && mutant would
    // have returned undefined for a truthy args? no — it differs exactly on
    // nullish args, pinned above).
    stubExecute.mockResolvedValueOnce('ok');
    const SUPPLIED = { a: 1, marker: 'sentinel-args-106' };
    await handlers.get('tools/call')!({ method: 'tools/call', params: { name: 'any_tool', arguments: SUPPLIED } });
    // toBe (identity), not toEqual: the literal-{} mutant yields a DIFFERENT
    // object; toEqual({a:1,marker}) would also pass for the mutant only if it
    // produced an equal object — it can't, but identity makes the kill exact
    // regardless of how zod clones the record.
    expect(stubExecute.mock.calls[1][1]).toEqual(SUPPLIED);
    // (zod clones the record — identity can't hold; toEqual with the sentinel
    // marker is the exactness bound: the {} mutant yields {} ≠ SUPPLIED.)
    // `args ?? {}` (not a bare-literal mutant): the observable polarity is the
    // NULLISH case — undefined args must reach executeTool as a FRESH empty
    // object (the ?? arm), pinned by the first assertion above. (A falsy
    // non-nullish probe like '' is rejected by the SDK schema's record type —
    // zod validates params before the handler, so '' can never reach 106.)
  });

  it('createTransport default arm produces a working transport (31)', async () => {
    // No createTransport dep → the default arm constructs a real
    // StdioServerTransport. Its start() registers on stdin/stdout — in the
    // vitest child that resolves; connectGodot never resolves (harmless).
    const { main } = await import('../../index.js');
    await main({ connectGodot: () => new Promise<void>(() => {}) });
  });

  it('ListTools handler returns the registry tool list verbatim (97/98)', async () => {
    const { registry } = await import('../../core/registry.js');
    const FIXED = [{ name: 'tool_a' }, { name: 'tool_b' }];
    const spy = vi.spyOn(registry as unknown as { getToolList: () => unknown }, 'getToolList')
      .mockReturnValue(FIXED as never);
    try {
      const server = await boot();
      const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers;
      const r = (await handlers.get('tools/list')!({ method: 'tools/list', params: {} })) as { tools: Array<{ name: string }> };
      // Verbatim forwarding: the handler must return exactly what the registry
      // produced (the {} mutants would return an empty object instead).
      expect(r).toEqual({ tools: FIXED });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('executeTool context carries the live godot connection (ctx-object mutant, 106 col67-76)', async () => {
    const sentinel = { marker: 'godot-connection-sentinel' };
    const { getGodotConnection } = await import('../../connection/websocket.js');
    vi.mocked(getGodotConnection).mockReturnValue(sentinel as never);
    stubExecute.mockResolvedValueOnce('ok');
    const server = await boot();
    const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers;
    await handlers.get('tools/call')!({ method: 'tools/call', params: { name: 'any_tool', arguments: {} } });
    const ctx = stubExecute.mock.calls[0][2] as { godot: unknown };
    // The {} mutant replaces { godot } → ctx.godot undefined. The real
    // connection singleton must be passed through.
    expect(ctx).toHaveProperty('godot');
    expect(ctx.godot).toBe(sentinel);
  });

  it('isStructuredResult gate polarity (119): a raw object WITH text but WITHOUT structuredContent is NOT structured → wrapped raw', async () => {
    // {text} alone satisfies isStructuredResult? The guard needs BOTH text and
    // structuredContent keys — an object with only `text` falls to the raw
    // wrap branch. The 119 mutant (structuredContent: true) would wrongly take
    // the structured branch; the SDK envelope then rejects the missing shape.
    stubExecute.mockResolvedValueOnce({ text: 'only-text' });
    const server = await boot();
    await expect(callTool(server)).rejects.toThrow(/Invalid tools\/call result/);
    // And a full structured shape still takes the structured branch (positive).
    stubExecute.mockResolvedValueOnce({ text: 't', structuredContent: { c: 1 } });
    const r2 = await callTool(server);
    expect(r2.structuredContent).toEqual({ c: 1 });
  });
});
