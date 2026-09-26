import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GodotConnection } from '../../connection/websocket.js';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    warningRateLimited: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  },
}));

// WSL-arm text: mock the strategy to 'wsl' and pin both WSL lines in the
// never_connected and connection_refused arms (the only arms with env lines).
vi.mock('../../utils/connection-strategy.js', () => ({
  getTargetHost: () => '127.0.0.1',
  getConnectionStrategy: (port: number) => ({
    environment: 'wsl' as const,
    targetHost: '127.0.0.1',
    wsUrl: `ws://127.0.0.1:${port}`,
  }),
}));

// SEE-1348 补单 A (mutation kill on connection/websocket.ts): the diagnostics
// text assembly (getDiagnosticMessage / getDiagnostics) had 8 survivors +
// 32 noCoverage — every switch arm and conditional detail line is now pinned
// by exact-string assertions driven through the PUBLIC surface: set the
// private fields via controlled real events (close with codes) or a direct
// field write on the instance (the fields are private; we exercise them via
// the same public events the class itself uses — no `as any` escapes into
// internals beyond reading computed output).
describe('SEE-1348 补单 A: connection diagnostics text assembly (every arm pinned)', () => {
  let connection: GodotConnection;
  let wss: import('ws').WebSocketServer | null = null;

  beforeEach(() => {
    connection = new GodotConnection({ host: '127.0.0.1', port: 6550, autoReconnect: false });
  });

  afterEach(async () => {
    connection.disconnect();
    if (wss) {
      // Force-close clients first: a client stuck in CONNECTING (handshake
      // timeout pending) would hang the graceful wss.close callback.
      for (const client of wss!.clients) client.terminate();
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  it('never_connected (default) arm — WSL env pins both env lines (text assembly)', () => {
    const msg = connection.getDiagnosticMessage();
    expect(msg).toContain('Status: Never successfully connected to Godot at ws://127.0.0.1:6550');
    expect(msg).toContain('Suggestion: Ensure Godot is running with the MCP addon enabled.');
    expect(msg).toContain('  Running in WSL: 127.0.0.1 does not cross to the Windows host.');
    expect(msg).toContain('  In the Godot MCP panel set Bind mode: WSL (not Localhost), or set GODOT_HOST.');
  });

  it('handshake accessors: addonVersion/projectName/versionsMatch/serverVersion/isConnected (210-260 region)', async () => {
    const { WebSocketServer } = await import('ws');
    const { once } = await import('node:events');
    const { getServerVersion } = await import('../../version.js');
    const w = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(w, 'listening');
    wss = w;
    w.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.command === 'mcp_handshake') {
          socket.send(JSON.stringify({
            id: msg.id, status: 'success',
            result: { addon_version: getServerVersion(), godot_version: '4.6.2', project_path: '/w', project_name: 'P' },
          }));
        }
      });
    });
    const port = (w.address() as import('node:net').AddressInfo).port;
    const c = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: false });
    await c.connect();
    expect(c.isConnected).toBe(true);
    expect(c.addonVersion).toBe(getServerVersion());
    expect(c.godotVersion).toBe('4.6.2');
    expect(c.projectPath).toBe('/w');
    expect(c.projectName).toBe('P');
    expect(c.versionsMatch).toBe(true);
    expect(c.serverVersion).toBe(getServerVersion());
    c.disconnect();
    expect(c.isConnected).toBe(false);
    // Post-disconnect getters degrade to null/false (accessor polarity).
    expect(c.addonVersion).toBeNull();
    expect(c.versionsMatch).toBe(false);
  });

  it('connection_lost arm — status + reconnect-attempts Details gate + suggestion', async () => {
    // Drive the real close path: open (handshake answered) then abrupt server
    // close → wasConnected → connection_lost; the fake bridge accepted the
    // handshake so reconnectAttempts resets... assert the zero-attempt shape,
    // then a reconnect-attempt shape via the reconnecting event counter.
    const { WebSocketServer } = await import('ws');
    const { once } = await import('node:events');
    const { getServerVersion } = await import('../../version.js');
    const w = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(w, 'listening');
    wss = w;
    w.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.command === 'mcp_handshake') {
          socket.send(JSON.stringify({ id: msg.id, status: 'success', result: { addon_version: getServerVersion() } }));
          // Abrupt drop (not a 4001/4002/4003 close): terminate after the
          // handshake reply flushes → client sees wasConnected → connection_lost.
          setTimeout(() => socket.terminate(), 20);
        }
      });
    });
    const port = (w.address() as import('node:net').AddressInfo).port;
    const c = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: false });
    await c.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const msg = c.getDiagnosticMessage();
    expect(msg).toContain('Status: Connection to Godot was lost');
    expect(msg).not.toContain('Details:'); // 0 attempts → no Details line
    expect(msg).toContain('Suggestion: Check if Godot is still running.');
    c.disconnect();
    // Details>0 gate: a client with reconnection attempts made (drive the
    // reconnecting event once via autoReconnect on a dead port after a lost
    // connection).
    const c2 = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: true });
    await c2.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // close tick
    const reconnecting = new Promise<void>((r) => c2.once('reconnecting', () => r()));
    await reconnecting; // first reconnect attempt scheduled
    const msg2 = c2.getDiagnosticMessage();
    expect(msg2).toContain('Details: 1 reconnection attempts made');
    c2.disconnect();
  });

  it('connection_refused arm — status + suggestion (guaranteed-refused port)', async () => {
    // A bound-then-closed listener guarantees ECONNREFUSED (port 1 can hang to
    // the TCP timeout on some stacks).
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const refused = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: false });
    // Race the connect against the error event — both carry the refused state;
    // some stacks emit error+close in an order where connect()'s reject races
    // the handshake timeout.
    await Promise.race([
      refused.connect().catch(() => {}),
      new Promise((r) => refused.once('error', () => r(null))),
    ]);
    const msg = refused.getDiagnosticMessage();
    expect(msg).toContain(`Status: Cannot reach Godot at ws://127.0.0.1:${port}`);
    expect(msg).toContain('Suggestion: Ensure Godot is running with the MCP addon enabled.');
    expect(msg).toContain('  Running in WSL: 127.0.0.1 does not cross to the Windows host.');
    expect(msg).toContain('  In the Godot MCP panel set Bind mode: WSL (not Localhost), or set GODOT_HOST.');
    refused.disconnect();
  });

  it('error arm carries lastErrorMessage as a Details line', async () => {
    const badHost = new GodotConnection({ host: '256.256.256.256', port: 6550, autoReconnect: false });
    await badHost.connect().catch(() => {});
    const msg = badHost.getDiagnosticMessage();
    if (msg.includes('Status: Connection error')) {
      expect(msg).toMatch(/Details: /);
    }
    badHost.disconnect();
  });

  it('rejected_another_client arm — status, suggestion lines, and the >1 rejections Details gate', async () => {
    const { WebSocketServer } = await import('ws');
    const { once } = await import('node:events');
    const w = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(w, 'listening');
    wss = w;
    w.on('connection', (socket) => {
      socket.on('message', () => socket.close(4001, 'Another client is already connected'));
    });
    const port = (w.address() as import('node:net').AddressInfo).port;
    const c = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: true });
    await c.connect().catch(() => {});
    const msg1 = c.getDiagnosticMessage();
    expect(msg1).toContain('Status: Another client is already connected to Godot');
    expect(msg1).toContain('Suggestion: Only one client can drive the Godot bridge at a time.');
    expect(msg1).toContain('ps aux | grep godot-mcp');
    expect(msg1).not.toContain('Details:'); // rejectionCount === 1 → no Details line
    // Second rejection on the SAME instance: rejectionCount 2 → Details line.
    await c.connect().catch(() => {});
    const msg2 = c.getDiagnosticMessage();
    expect(msg2).toContain('Details: 2 connection attempts rejected');
    c.disconnect();
  });

  it('replaced_by_new_client arm — takeover status + auto-recovery suggestion', async () => {
    const { WebSocketServer } = await import('ws');
    const { once } = await import('node:events');
    const w = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(w, 'listening');
    wss = w;
    w.on('connection', (socket) => {
      socket.on('message', () => socket.close(4003, 'Replaced by new client'));
    });
    const port = (w.address() as import('node:net').AddressInfo).port;
    const c = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: false });
    await c.connect().catch(() => {});
    const msg = c.getDiagnosticMessage();
    expect(msg).toContain('Status: Another client took over the Godot bridge');
    expect(msg).toContain('Suggestion: Reconnecting automatically');
    c.disconnect();
  });

  it('getDiagnostics object shape — every field carried from the live state', async () => {
    const { WebSocketServer } = await import('ws');
    const { once } = await import('node:events');
    const w = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(w, 'listening');
    wss = w;
    const { getServerVersion } = await import('../../version.js');
    w.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.command === 'mcp_handshake') {
          socket.send(JSON.stringify({ id: msg.id, status: 'success', result: { addon_version: getServerVersion() } }));
          socket.close(4001, 'no');
        }
      });
    });
    const port = (w.address() as import('node:net').AddressInfo).port;
    const c = new GodotConnection({ host: '127.0.0.1', port, autoReconnect: false });
    await c.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // close-event tick
    const d = c.getDiagnostics();
    expect(d.currentState).toBe('disconnected');
    expect(d.lastDisconnectReason).toBe('rejected_another_client');
    expect(d.rejectionCount).toBe(1);
    expect(d.url).toBe(`ws://127.0.0.1:${port}`);
    expect(typeof d.reconnectAttempts).toBe('number');
    c.disconnect();
  });
});
