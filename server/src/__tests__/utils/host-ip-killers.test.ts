import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { _clearHostIpCache, getHostIpInWSL } from '../../utils/host-ip-resolver.js';
import { _resetForTesting } from '../../utils/logger.js';

vi.mock('../../utils/gateway-resolver.js', () => ({
  resolveGateway: vi.fn(),
}));
import { resolveGateway } from '../../utils/gateway-resolver.js';

const mockedResolve = vi.mocked(resolveGateway);

describe('host-ip-resolver: gateway-path contracts (mocked resolver)', () => {
  let errSpy: MockInstance;

  beforeEach(() => {
    _clearHostIpCache();
    _resetForTesting();
    delete process.env.GODOT_HOST;
    delete process.env.GODOT_MCP_VERBOSE;
    mockedResolve.mockReset();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    _resetForTesting();
  });

  it('WSL + gateway hit returns the IP and logs the debug line verbatim', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    mockedResolve.mockReturnValue({ environment: 'wsl2', gatewayIp: '10.0.0.9' });
    expect(getHostIpInWSL()).toBe('10.0.0.9');
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [debug] Auto-detected Windows host IP from gateway {"ip":"10.0.0.9"}');
  });

  it('resolver throwing logs the warning with the error message; null is cached', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    mockedResolve.mockImplementation(() => { throw new Error('gateway exploded'); });
    expect(getHostIpInWSL()).toBeNull();
    const warnings = errSpy.mock.calls.map((c) => c[0] as string).filter((s) => (s as string).includes('[warning]'));
    expect(warnings.some((s) => (s as string).includes('Failed to auto-detect Windows host IP'))).toBe(true);
    expect(warnings.some((s) => (s as string).includes('gateway exploded'))).toBe(true);
    const callsBefore = mockedResolve.mock.calls.length;
    expect(getHostIpInWSL()).toBeNull();
    expect(mockedResolve.mock.calls.length).toBe(callsBefore);
  });

  it('WSL + null gateway → null without any warning', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    mockedResolve.mockReturnValue({ environment: 'wsl2', gatewayIp: null });
    expect(getHostIpInWSL()).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('GODOT_HOST override logs the env-var debug line verbatim', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    process.env.GODOT_HOST = 'override.example';
    expect(getHostIpInWSL()).toBe('override.example');
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [debug] Using GODOT_HOST env var for host IP {"ip":"override.example"}');
  });
});
