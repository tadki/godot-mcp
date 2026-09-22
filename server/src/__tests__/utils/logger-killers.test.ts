import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { logger, _resetForTesting } from '../../utils/logger.js';

// Mutation killers for utils/logger.ts (SEE-1334 SPEC-061) — verbose gate,
// rate limit window, and level-routing contracts. Production code untouched.

describe('logger: verbose gate + rate limit contracts', () => {
  let errSpy: MockInstance;

  beforeEach(() => {
    _resetForTesting();
    delete process.env.GODOT_MCP_VERBOSE;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    delete process.env.GODOT_MCP_VERBOSE;
    _resetForTesting();
  });

  it('suppresses debug/info/notice unless GODOT_MCP_VERBOSE is on', () => {
    logger.debug('d');
    logger.info('i');
    logger.notice('n');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('prints verbose levels when GODOT_MCP_VERBOSE=1 (case-insensitive true too)', () => {
    process.env.GODOT_MCP_VERBOSE = '1';
    logger.debug('d1', { k: 1 });
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toContain('[debug]');
    expect(errSpy.mock.calls[0][0]).toContain('"k":1');
  });

  it('always prints warning and error regardless of verbose', () => {
    logger.warning('w');
    logger.error('e');
    logger.critical('c');
    expect(errSpy).toHaveBeenCalledTimes(3);
  });

  it('rate-limits repeated warnings by key: first 10 pass, 11th within window is dropped', () => {
    for (let i = 0; i < 10; i++) logger.warningRateLimited('dup-key', `w${i}`);
    expect(errSpy).toHaveBeenCalledTimes(10);
    logger.warningRateLimited('dup-key', 'w11');
    expect(errSpy).toHaveBeenCalledTimes(10); // 11th dropped
    // a different key is a fresh window
    logger.warningRateLimited('other-key', 'other');
    expect(errSpy).toHaveBeenCalledTimes(11);
  });

  it('window expiry resets the count (clock advanced past 5s)', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) logger.warningRateLimited('k', `w${i}`);
    expect(errSpy).toHaveBeenCalledTimes(10);
    vi.advanceTimersByTime(5001); // > RATE_LIMIT_WINDOW_MS
    logger.warningRateLimited('k', 'post-window');
    expect(errSpy).toHaveBeenCalledTimes(11);
    vi.useRealTimers();
  });

  it('omits the JSON suffix when no data is passed', () => {
    logger.error('plain');
    expect(errSpy.mock.calls[0][0]).not.toContain('{');
  });
});

describe('logger: exact stderr text contracts (mutation killers)', () => {
  let errSpy: MockInstance;
  beforeEach(() => {
    _resetForTesting();
    delete process.env.GODOT_MCP_VERBOSE;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    delete process.env.GODOT_MCP_VERBOSE;
    _resetForTesting();
  });

  it('error line carries the godot-mcp logger name and level verbatim', () => {
    logger.error('boom happened', { code: 7 });
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [error] boom happened {"code":7}');
  });

  it('verbose notice line shape (case-insensitive TRUE accepted)', () => {
    process.env.GODOT_MCP_VERBOSE = 'TRUE';
    logger.notice('nascent');
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [notice] nascent');
  });

  it('rate-limited warning routes through the warning level with data suffix', () => {
    logger.warningRateLimited('rlk', 'rate message', { n: 2 });
    expect(errSpy.mock.calls[0][0]).toBe('[godot-mcp] [warning] rate message {"n":2}');
  });
});
