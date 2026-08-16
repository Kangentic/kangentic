import type { SessionUsage, SessionEvent } from '../../../../shared/types';

/**
 * Parses Antigravity CLI status and event data.
 *
 * Antigravity has no status-line channel and writes no token usage anywhere
 * Kangentic can read for an interactive session (verified against agy
 * 1.1.13: neither transcript.jsonl nor the hook payloads carry usage), so
 * parseStatus always returns null and the adapter declares
 * `liveTelemetryUnsupported`. Event parsing reuses the agent-agnostic
 * event-bridge JSONL format, which is how the hook pipeline (Prompt /
 * ToolEnd / Idle) reaches the activity engine.
 */
export class AntigravityStatusParser {
  /** Antigravity has no status-line feature - always null. */
  static parseStatus(_raw: string): SessionUsage | null {
    return null;
  }

  /** Parse a single event-bridge JSONL line into a SessionEvent. */
  static parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }
}
