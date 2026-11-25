/**
 * How the WSL hook inbox and its MCP relay report a failure they catch.
 *
 * Both run in main, but both are also bundled into the pty host and the SSH
 * helper: every agent adapter imports the inbox through `kangentic-mcp-server.ts`,
 * and those two processes bundle the adapters. So neither file may import a
 * reporter, which would pull Sentry into a process that cannot load it
 * (`tests/unit/pty-host-boundary.test.ts`). They report through this slot
 * instead, and main fills it once: `status-file-reader.ts`, which only main
 * loads, hands it `sessionManagerReporter` when the session layer loads.
 *
 * In the pty host and the helper the slot stays empty and a report does
 * nothing. Neither process ever builds an inbox or relays an MCP message.
 *
 * Pure: imports nothing, so it is safe in every bundle.
 */

/** The part of a chokepoint reporter a caller here uses. */
export interface WslTransportFailureSink {
  report(error: unknown, options?: { tags?: Record<string, string> }): boolean;
}

let failureSink: WslTransportFailureSink | null = null;

/** Main's reporter, or null to empty the slot (a test). */
export function setWslTransportFailureSink(sink: WslTransportFailureSink | null): void {
  failureSink = sink;
}

/** Reports through main's reporter when one is set. False when none is, or it skipped the error. */
export const wslTransportReporter: WslTransportFailureSink = {
  report: (error, options) => failureSink?.report(error, options) ?? false,
};
