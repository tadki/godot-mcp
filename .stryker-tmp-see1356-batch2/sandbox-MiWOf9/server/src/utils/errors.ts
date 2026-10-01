// @ts-nocheck
export class GodotConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GodotConnectionError';
  }
}

// Raised when the websocket closes while commands are still in flight.
// Extends GodotConnectionError so existing consumers keep treating it as a
// connection failure, but callers can now branch on the code instead of
// string-matching the message (SEE-1326 M5 onclose-reject-all).
export class GodotConnectionClosedError extends GodotConnectionError {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GodotConnectionClosedError';
    this.code = code;
  }
}

export class GodotCommandError extends Error {
  public readonly code: string;
  // SEE-1356 batch-2: the addon's optional failure classification (protocol.ts
  // ErrorResponseSchema keeps it now instead of stripping). Absent for every
  // pre-batch-2 code path.
  public readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'GodotCommandError';
    this.code = code;
    this.detail = detail;
  }
}

export class GodotTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`Command '${command}' timed out after ${timeoutMs}ms`);
    this.name = 'GodotTimeoutError';
  }
}

export function formatError(error: unknown): string {
  if (error instanceof GodotCommandError) {
    // Detail renders only when present — the no-detail form stays
    // byte-identical to the pre-batch-2 surface.
    return error.detail !== undefined
      ? `[${error.code}] ${error.message} [detail: ${error.detail}]`
      : `[${error.code}] ${error.message}`;
  }
  if (error instanceof GodotConnectionClosedError) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof GodotTimeoutError) {
    return `[TIMEOUT] ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
