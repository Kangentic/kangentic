/**
 * Why the MCP server did not start this run, as its error said, or null when
 * it started (or has not been asked to). Startup logs the failure and runs on
 * without the server; the MCP connection check reports this text as its error,
 * since there is no server to ask.
 */
let startFailure: string | null = null;

export function recordMcpServerStartFailure(error: unknown): void {
  startFailure = error instanceof Error ? error.message : String(error);
}

export function mcpServerStartFailure(): string | null {
  return startFailure;
}
