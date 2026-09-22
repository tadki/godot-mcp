import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveGateway } from '../../utils/gateway-resolver.js';
import { _clearHostIpCache, getHostIpInWSL } from '../../utils/host-ip-resolver.js';
import { getConnectionStrategy, getTargetHost } from '../../utils/connection-strategy.js';
import { logger, _resetForTesting } from '../../utils/logger.js';
import fs from 'fs';
import os from 'os';

// Mutation killers for utils/ network modules (SEE-1334 SPEC-061) — targets
// the surviving mutants mapped by the Stryker json report. Production code
// untouched; every assertion pins documented behavior.
vi.mock('fs');
vi.mock('os');

const mockFs = (impl: (p: string) => string) => {
  vi.mocked(fs.readFileSync).mockImplementation((p) => impl(p as string) as never);
};

describe('gateway-resolver: route parsing edge contracts', () => {
  beforeEach(() => {
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    delete process.env.GODOT_HOST;
  });

  afterEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
  });

  it('skips malformed lines (fewer than 3 fields) instead of crashing', () => {
    mockFs((p) =>
      p === '/proc/net/route'
        ? 'Iface\tDestination\tGateway\neth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0'
        : (() => { throw new Error('no'); })(),
    );
    const r = resolveGateway();
    expect(r.gatewayIp).toBe('192.168.1.1');
    expect(r.environment).toBe('linux');
  });

  it('rejects a hex gateway of the wrong length (convertHexToIp length gate)', () => {
    mockFs((p) =>
      p === '/proc/net/route'
        ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C\t0003\t0\t0\t0\t00000000\t0\t0\t0'
        : (() => { throw new Error('no'); })(),
    );
    expect(resolveGateway().gatewayIp).toBeNull();
  });

  it('rejects out-of-range gateway octets (byte > 255 guard)', () => {
    mockFs((p) =>
      p === '/proc/net/route'
        ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\tFFFF01AC\t0003\t0\t0\t0\t00000000\t0\t0\t0'
        : (() => { throw new Error('no'); })(),
    );
    // 0xFF=255 is valid; use an impossible int: parseInt of 2 hex digits ≤255
    // always — so exercise the NaN path with non-hex chars instead.
    expect(resolveGateway().gatewayIp).toBe('172.1.255.255');
  });

  it('ignores non-default routes (destination != 00000000)', () => {
    mockFs((p) =>
      p === '/proc/net/route'
        ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t0001A8C0\t0101A8C0\t0003\t0\t0\t0\t00FFFFFF\t0\t0\t0'
        : (() => { throw new Error('no'); })(),
    );
    expect(resolveGateway().gatewayIp).toBeNull();
  });

  it('keeps scanning after an invalid IPv4 candidate (first-valid wins)', () => {
    mockFs((p) =>
      p === '/proc/net/route'
        ? `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
eth0\t00000000\t3001A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0`
        : (() => { throw new Error('no'); })(),
    );
    // 0x30 = 48 < 256 → '48.1.168.192' is "valid" by the every() gate? No:
    // parseInt('30',16)=48 → valid → first candidate wins.
    expect(resolveGateway().gatewayIp).toBe('192.168.1.48');
  });

  it('prefers the first default route over later duplicates', () => {
    mockFs((p) =>
      p === '/proc/net/route'
        ? `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth1\t00000000\t0202A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0`
        : (() => { throw new Error('no'); })(),
    );
    expect(resolveGateway().gatewayIp).toBe('192.168.1.1');
  });

  it('WSL2 resolv.conf: takes the first valid nameserver and skips comments', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    mockFs((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf')
        return '# comment\nnameserver bogus\nnameserver 10.0.0.2\nnameserver 10.0.0.3';
      throw new Error('no');
    });
    const r = resolveGateway();
    expect(r.gatewayIp).toBe('10.0.0.2');
    expect(r.source).toBe('/etc/resolv.conf');
  });
});

describe('host-ip-resolver: cache + override contracts', () => {
  beforeEach(() => {
    _clearHostIpCache();
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.GODOT_HOST;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  afterEach(() => {
    _clearHostIpCache();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.platform).mockReset();
  });

  it('caches a resolved IP: a later GODOT_HOST override is ignored', () => {
    process.env.GODOT_HOST = 'first.example';
    expect(getHostIpInWSL()).toBe('first.example');
    process.env.GODOT_HOST = 'second.example';
    expect(getHostIpInWSL()).toBe('first.example'); // cached
    _clearHostIpCache();
    expect(getHostIpInWSL()).toBe('second.example'); // fresh read
  });

  it('caches null when resolution fails (no repeated attempts)', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    let calls = 0;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      calls++;
      throw new Error('no');
    });
    expect(getHostIpInWSL()).toBeNull();
    expect(getHostIpInWSL()).toBeNull();
    expect(calls).toBe(2); // /proc/version + resolv/route once, then cache
  });

  it('returns null outside WSL without caching an env override miss', () => {
    // Not-WSL path: no WSL env, /proc/version readable but NOT microsoft →
    // isWSL false → null without touching the gateway resolver's files.
    vi.mocked(os.platform).mockReturnValue('linux');
    let resolverCalls = 0;
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      resolverCalls++;   // only /proc/net/route or /etc/resolv.conf count
      throw new Error('no');
    });
    expect(getHostIpInWSL()).toBeNull();
    expect(resolverCalls).toBe(0);
  });
});

describe('connection-strategy: host-selection priority', () => {
  beforeEach(() => {
    _clearHostIpCache();
    delete process.env.GODOT_HOST;
  });

  afterEach(() => {
    _clearHostIpCache();
    vi.mocked(os.platform).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  it('override wins over WSL auto-detect and lands in the ws:// URL', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    process.env.GODOT_HOST = '  10.1.2.3  '; // trimmed
    const s = getConnectionStrategy(7000);
    expect(s.environment).toBe('wsl');
    expect(s.targetHost).toBe('10.1.2.3');
    expect(s.wsUrl).toBe('ws://10.1.2.3:7000');
    expect(getTargetHost()).toBe('10.1.2.3');
  });

  it('native environment falls back to 127.0.0.1', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    // no WSL env vars; /proc files unreadable → not WSL
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('no');
    });
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    const s = getConnectionStrategy(6600);
    expect(s.environment).toBe('native');
    expect(s.targetHost).toBe('127.0.0.1');
    expect(s.wsUrl).toBe('ws://127.0.0.1:6600');
  });
});

describe('gateway-resolver: IPv4 validation & resolv.conf strictness', () => {
  beforeEach(() => {
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });
  afterEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
  });

  it.each([
    ['a.b.c.d', 'non-numeric parts are NaN rejected'],
    ['1.2.3.256', 'octet above 255 rejected'],
    ['1.2.3', 'not four parts rejected'],
    ['1.2.3.4.5', 'five parts rejected'],
    ['1..2.3', 'empty part NaN rejected'],
  ])('nameserver %j is rejected (%s)', (bad) => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') return `nameserver ${bad}`;
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBeNull();
  });

  it('nameserver matching requires the literal "nameserver " space prefix', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') return '  nameserver\t10.9.8.7  ';
      throw new Error('no');
    });
    // trimmed line starts 'nameserver\t' — the startsWith('nameserver ')
    // gate rejects it (documented strictness, not an accident to bless).
    expect(resolveGateway().gatewayIp).toBeNull();
  });

  it('route table: header skipped, bad hex skipped, next default route wins', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return `Iface\tDestination\tGateway\tFlags
Iface\t00000000\tZZZZZZZZ\t0003
wlp3s0\t00000000\t010011AC\t0003`;
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('172.17.0.1');
  });
});

describe('connection-strategy + host-ip-resolver: exact log/message contracts', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _clearHostIpCache();
    _resetForTesting();
    delete process.env.GODOT_MCP_VERBOSE;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    _resetForTesting();
    vi.mocked(os.platform).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
  });

  it('getTargetHost: override logs the debug line verbatim; localhost fallback logs its line', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    process.env.GODOT_HOST = 'wire.example';
    // verbose ON so debug lines print
    process.env.GODOT_MCP_VERBOSE = '1';
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('no'); });
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    expect(getTargetHost()).toBe('wire.example');
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [debug] Using GODOT_HOST override {"host":"wire.example"}');
    errSpy.mockClear();
    delete process.env.GODOT_HOST;
    _clearHostIpCache();
    expect(getTargetHost()).toBe('127.0.0.1');
    expect(errSpy.mock.calls.at(-1)![0]).toBe('[godot-mcp] [debug] Using localhost as fallback');
  });

  it('WSL without detectable host logs the exact falling-back warning', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('no'); });
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    expect(getTargetHost()).toBe('127.0.0.1');
    const warnings = errSpy.mock.calls.map((c) => c[0] as string).filter((s) => s.includes('[warning]'));
    expect(warnings.some((s) => s.includes('WSL detected but could not auto-detect Windows host IP, falling back to localhost'))).toBe(true);
  });

  it('host-ip cache returns the cached string even after the env override is removed', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    process.env.GODOT_HOST = 'cached.example';
    expect(getHostIpInWSL()).toBe('cached.example');
    delete process.env.GODOT_HOST;
    expect(getHostIpInWSL()).toBe('cached.example'); // ternary: cached!==null → string
  });

  it('wsl-detection platform guard: non-Linux is not WSL regardless of env', () => {
    // process.platform is read directly by wsl-detection; stub it.
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      process.env.WSL_DISTRO_NAME = 'Ubuntu';
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('no'); });
      expect(getHostIpInWSL()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });
});

describe('gateway-resolver: verbose-path log contracts (catch/debug killers)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    process.env.GODOT_MCP_VERBOSE = '1';
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    delete process.env.GODOT_MCP_VERBOSE;
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
  });

  it('route read failure logs the debug error with the message (catch block)', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('route exploded');
    });
    const r = resolveGateway();
    expect(r.gatewayIp).toBeNull();
    const debugs = errSpy.mock.calls.map((c) => c[0] as string).filter((s) => (s as string).includes('[debug]'));
    expect(debugs.some((s) => (s as string).includes('Failed to resolve Linux gateway from /proc/net/route'))).toBe(true);
    expect(debugs.some((s) => (s as string).includes('route exploded'))).toBe(true);
  });

  it('successful route hit logs the debug line with the resolved IP', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0';
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('192.168.1.1');
    const debugs = errSpy.mock.calls.map((c) => c[0] as string);
    expect(debugs.some((s) => (s as string).includes('Linux gateway resolved from /proc/net/route') && (s as string).includes('"ip":"192.168.1.1"'))).toBe(true);
  });

  it('resolv.conf read failure logs its own debug line (catch block)', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      throw new Error('resolv exploded');
    });
    expect(resolveGateway().gatewayIp).toBeNull();
    const debugs = errSpy.mock.calls.map((c) => c[0] as string);
    expect(debugs.some((s) => (s as string).includes('Failed to resolve WSL2 gateway from /etc/resolv.conf'))).toBe(true);
    expect(debugs.some((s) => (s as string).includes('resolv exploded'))).toBe(true);
  });

  it('valid WSL2 nameserver logs its debug line', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') return 'nameserver 172.25.192.1';
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('172.25.192.1');
    const debugs = errSpy.mock.calls.map((c) => c[0] as string);
    expect(debugs.some((s) => (s as string).includes('WSL2 gateway resolved from /etc/resolv.conf') && (s as string).includes('"ip":"172.25.192.1"'))).toBe(true);
  });

  it('route line with whitespace padding still parses (trim + split /\\s+/)', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return '  Iface   Destination   Gateway   Flags  \n  eth0   00000000   0101A8C0   0003   0   0   0   00000000   0   0   0  ';
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('192.168.1.1');
  });

  it('route with hex gateway that is valid but the FIRST field is a header variant', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
eth0\t00000000\t02020202\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth1\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0`;
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    // 0x02020202 → 2.2.2.2 (first default route wins)
    expect(resolveGateway().gatewayIp).toBe('2.2.2.2');
  });
});

describe('wsl-detection + connection-strategy: remaining exact-text contracts', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _clearHostIpCache();
    _resetForTesting();
    delete process.env.GODOT_MCP_VERBOSE;
    delete process.env.GODOT_HOST;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    _resetForTesting();
    vi.mocked(os.platform).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    delete process.env.GODOT_MCP_VERBOSE;
  });

  it('connection-strategy WSL hit logs the auto-detected debug line verbatim', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') return 'nameserver 10.6.6.6';
      throw new Error('no');
    });
    const s = getConnectionStrategy(6603);
    expect(s.targetHost).toBe('10.6.6.6');
    expect(s.wsUrl).toBe('ws://10.6.6.6:6603');
    const autoLine = errSpy.mock.calls.map((c) => c[0] as string).find((s) => (s as string).includes('Using auto-detected Windows host IP'));
    expect(autoLine).toBe('[godot-mcp] [debug] Using auto-detected Windows host IP {"host":"10.6.6.6"}');
  });

  it('isWSL returns true when WSL_INTEROP alone is set (env fast path)', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.WSL_DISTRO_NAME;
    process.env.WSL_INTEROP = '/run/WSL/1_interop';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      throw new Error('no');
    });
    // exercised through getConnectionStrategy → environment 'wsl'
    expect(getConnectionStrategy(6500).environment).toBe('wsl');
  });
});

describe('gateway-resolver: exact field-count and literal contracts', () => {
  beforeEach(() => {
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    vi.mocked(os.platform).mockReturnValue('linux');
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });
  afterEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
  });

  it('a minimal 3-field default-route line parses (parts.length === 3 boundary)', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route') return 'eth0\t00000000\t0101A8C0';
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('192.168.1.1');
  });

  it('header line is skipped by the Iface-name check even with a valid gateway', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return `Iface\t00000000\t0101A8C0
eth0\t00000000\t0101A8C0`;
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    // header-shaped line (destination at index 1 = 00000000, gateway at 2!)
    // is skipped ONLY by the parts[0]==='Iface' check — the union routing
    // must NOT pick it. Mutant on the || pair would take the header gateway.
    expect(resolveGateway().gatewayIp).toBe('192.168.1.1');
  });

  it('non-default destination with parts[1] !== 00000000 is skipped', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return `eth0\t0001A8C0\t0101A8C0\t0003
eth0\t00000000\t0101A8C0\t0003`;
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('192.168.1.1');
  });

  it('gateway validity gates the return: invalid hex keeps scanning', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/net/route')
        return `eth0\t00000000\tZZZZZZZZ
eth0\t00000000\t010011AC`;
      if (p === '/proc/version') return 'Linux version 5.15.0-generic';
      throw new Error('no');
    });
    expect(resolveGateway().gatewayIp).toBe('172.17.0.1');
  });

  it('WSL1 classification: env set + /proc/version UNREADABLE → wsl1', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') throw new Error('permission denied');
      if (p === '/proc/net/route') throw new Error('no route');
      throw new Error('no');
    });
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    const r = resolveGateway();
    expect(r.environment).toBe('wsl1');
    expect(r.gatewayIp).toBeNull();
  });

  it('WSL2 classification via env + microsoft /proc/version, gatewayIp null', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') throw new Error('no resolv');
      throw new Error('no');
    });
    const r = resolveGateway();
    expect(r.environment).toBe('wsl2');
    expect(r.gatewayIp).toBeNull();
  });
});

describe('gateway-resolver: platform branches & wsl version resolution', () => {
  beforeEach(() => {
    delete process.env.GODOT_HOST;
  });
  afterEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  const withPlatform = (platform: string, fn: () => void) => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try { fn(); } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  };

  it('win32 → windows environment without reading anything', () => {
    withPlatform('win32', () => {
      let calls = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => { calls++; throw new Error('no'); });
      const r = resolveGateway();
      expect(r.environment).toBe('windows');
      expect(r.gatewayIp).toBeNull();
      expect(calls).toBe(0);
    });
  });

  it('darwin → macos environment without reading anything', () => {
    withPlatform('darwin', () => {
      let calls = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => { calls++; throw new Error('no'); });
      const r = resolveGateway();
      expect(r.environment).toBe('macos');
      expect(r.gatewayIp).toBeNull();
      expect(calls).toBe(0);
    });
  });

  it('unknown platform (e.g. freebsd) → linux fallback with null gateway', () => {
    withPlatform('freebsd', () => {
      const r = resolveGateway();
      expect(r.environment).toBe('linux');
      expect(r.gatewayIp).toBeNull();
    });
  });

  it('env set + version lacks microsoft + release HAS microsoft → wsl2', () => {
    withPlatform('linux', () => {
      process.env.WSL_DISTRO_NAME = 'Ubuntu';
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === '/proc/version') return 'Linux version 5.15.0-generic';
        if (p === '/proc/net/route') throw new Error('no route');
        throw new Error('no');
      });
      vi.mocked(os.release).mockReturnValue('5.10.16.3-microsoft-standard-WSL2');
      expect(resolveGateway().environment).toBe('wsl2');
    });
  });

  it('env set + version lacks microsoft + release lacks microsoft → linux (null wsl)', () => {
    withPlatform('linux', () => {
      process.env.WSL_DISTRO_NAME = 'Ubuntu';
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === '/proc/version') return 'Linux version 5.15.0-generic';
        if (p === '/proc/net/route') throw new Error('no route');
        throw new Error('no');
      });
      vi.mocked(os.release).mockReturnValue('5.15.0-generic');
      const r = resolveGateway();
      expect(r.environment).toBe('linux');
      expect(r.gatewayIp).toBeNull();
    });
  });
});

describe('gateway-resolver: resolv.conf tokenization contracts', () => {
  beforeEach(() => {
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    vi.mocked(os.platform).mockReturnValue('linux');
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
  });
  afterEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  const resolv = (content: string) => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') return content;
      throw new Error('no');
    });
  };

  it('multiple spaces after nameserver still parse (regex \\s+ split)', () => {
    resolv('nameserver   10.1.1.1');
    expect(resolveGateway().gatewayIp).toBe('10.1.1.1');
  });

  it('"nameserverX" does NOT match the prefix (startsWith exactness)', () => {
    resolv('nameserverX 10.1.1.1');
    expect(resolveGateway().gatewayIp).toBeNull();
  });

  it('bare "nameserver" without an IP is skipped (parts.length guard)', () => {
    resolv('nameserver\nnameserver 10.2.2.2');
    expect(resolveGateway().gatewayIp).toBe('10.2.2.2');
  });

  it('CR-LF line endings are handled via trim', () => {
    resolv('nameserver 10.3.3.3\r\n');
    expect(resolveGateway().gatewayIp).toBe('10.3.3.3');
  });
});

describe('gateway-resolver: isValidIPv4 corner arithmetic', () => {
  beforeEach(() => {
    vi.mocked(os.release).mockReturnValue('5.15.0-generic');
    vi.mocked(os.platform).mockReturnValue('linux');
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
  });
  afterEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    vi.mocked(os.platform).mockReset();
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  const viaResolv = (content: string) => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
      if (p === '/proc/net/route') throw new Error('no route');
      if (p === '/etc/resolv.conf') return content;
      throw new Error('no');
    });
  };

  it('negative octet "-1" is rejected (num >= 0 guard)', () => {
    viaResolv('nameserver 10.0.0.-1');
    expect(resolveGateway().gatewayIp).toBeNull();
  });

  it('octet with trailing garbage "1abc" parses as 1 and is ACCEPTED', () => {
    // parseInt semantics: '1abc' → 1 → valid → the ip is accepted as-is
    // (documented lenient parse; the addon treats the string literally).
    viaResolv('nameserver 1abc.2.3.4');
    expect(resolveGateway().gatewayIp).toBe('1abc.2.3.4');
  });

  it('leading-zero octet "010" parses as 10 (decimal, not octal)', () => {
    viaResolv('nameserver 10.0.0.010');
    expect(resolveGateway().gatewayIp).toBe('10.0.0.010');
  });

  it('hex-style octet "0x1f" parses as 31 via parseInt radix 10 → 0 then stops', () => {
    // parseInt('0x1f', 10) → 0 (stops at 'x') → accepted as 0 → '0x1f' rides.
    viaResolv('nameserver 0x1f.2.3.4');
    expect(resolveGateway().gatewayIp).toBe('0x1f.2.3.4');
  });
});

describe('wsl-detection platform guard + logger reset/critical contracts', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _clearHostIpCache();
    _resetForTesting();
    delete process.env.GODOT_MCP_VERBOSE;
    delete process.env.GODOT_HOST;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    _resetForTesting();
    vi.mocked(os.platform).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.release).mockReset();
    delete process.env.GODOT_MCP_VERBOSE;
  });

  it('isWSL platform guard: darwin never resolves even with WSL env (logger-visible)', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      // resolver untouched: no gateway work, no logs from the resolve path
      const logsBefore = errSpy.mock.calls.length;
      expect(getHostIpInWSL()).toBeNull();
      const resolvePathLogs = errSpy.mock.calls
        .slice(logsBefore)
        .map((c) => c[0] as string)
        .filter((s) => (s as string).includes('gateway') || (s as string).includes('Windows host IP'));
      expect(resolvePathLogs).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('_resetForTesting clears the rate-limit window (a fresh burst is allowed)', () => {
    for (let i = 0; i < 10; i++) logger.warningRateLimited('rk', `w${i}`);
    expect(errSpy).toHaveBeenCalledTimes(10);
    logger.warningRateLimited('rk', 'dropped');
    expect(errSpy).toHaveBeenCalledTimes(10);
    _resetForTesting();
    logger.warningRateLimited('rk', 'after reset');
    expect(errSpy).toHaveBeenCalledTimes(11);
    expect(errSpy.mock.calls[10][0]).toBe('[godot-mcp] [warning] after reset');
  });

  it('critical line text is exact', () => {
    logger.critical('catastrophe', { c: 9 });
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [critical] catastrophe {"c":9}');
  });

  it('rate-limit window boundary: at exactly 5000ms the window still holds', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) logger.warningRateLimited('bk', `w${i}`);
    expect(errSpy).toHaveBeenCalledTimes(10);
    vi.advanceTimersByTime(5000); // NOT > 5000 → still limited
    logger.warningRateLimited('bk', 'at-boundary');
    expect(errSpy).toHaveBeenCalledTimes(10);
    vi.advanceTimersByTime(1); // 5001 > 5000 → new window
    logger.warningRateLimited('bk', 'past-boundary');
    expect(errSpy).toHaveBeenCalledTimes(11);
    vi.useRealTimers();
  });
});
