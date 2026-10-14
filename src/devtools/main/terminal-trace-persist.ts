import * as path from 'node:path';
import { queueAppendWithRotation } from '../../main/diagnostics/async-file-queue';
import type { TerminalTraceEvent, TerminalTraceListener } from '../../main/pty/terminal-trace';

/**
 * Persists the terminal lifecycle trace (`src/main/pty/terminal-trace.ts`) so a
 * restart does not erase it.
 *
 * The in-memory ring was the only record of the resizes, settles and focus
 * changes around a stuck terminal, and the usual first move with a stuck
 * terminal is to restart the app. One incident left two task-window terminals
 * whose agents drew for the bottom panel's grid, and the restart that cleared
 * them took every trace entry with it.
 *
 * One JSON line per kept entry, appended off the main thread through the
 * shared async queue and capped by rotation (`<file>.1` holds the previous
 * slice). Never truncated on a session start: a resume after a restart is the
 * moment the old lines matter most.
 */

export const TERMINAL_TRACE_FILE_NAME = 'terminal-trace.jsonl';

/** At most twice this on disk, the primary plus one rotated copy. A busy day of
 *  window switches writes a few MB, so this holds several days. */
export const TERMINAL_TRACE_MAX_BYTES = 8 * 1024 * 1024;

export function terminalTraceFilePath(configDir: string): string {
  return path.join(configDir, 'logs', TERMINAL_TRACE_FILE_NAME);
}

export function formatTerminalTraceLine(entry: TerminalTraceEvent): string {
  return JSON.stringify({
    ts: new Date(entry.ts).toISOString(),
    process: entry.process,
    sessionId: entry.sessionId,
    event: entry.event,
    ...(entry.detail ? { detail: entry.detail } : {}),
  }) + '\n';
}

export function createTerminalTracePersistListener(
  filePath: string,
  maxBytes: number = TERMINAL_TRACE_MAX_BYTES,
): TerminalTraceListener {
  return (entry) => {
    queueAppendWithRotation(filePath, formatTerminalTraceLine(entry), maxBytes);
  };
}
