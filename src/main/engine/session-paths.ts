import path from 'node:path';

/**
 * Compute the standard output file paths for a session directory.
 * Used by transition-engine and session-startup to avoid duplicating
 * the path patterns.
 */
export function sessionOutputPaths(sessionDir: string): {
  statusOutputPath: string;
  eventsOutputPath: string;
} {
  return {
    statusOutputPath: path.join(sessionDir, 'status.json'),
    eventsOutputPath: path.join(sessionDir, 'events.jsonl'),
  };
}
