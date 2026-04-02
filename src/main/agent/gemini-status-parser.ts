import type { SessionUsage, SessionEvent } from '../../shared/types';

/**
 * Parses Gemini CLI status and event data.
 *
 * Gemini CLI does not emit status line data (no context window / cost
 * streaming), so parseStatus always returns null. Event parsing reuses
 * the same JSONL format written by the agent-agnostic event-bridge.
 */
export class GeminiStatusParser {
  /**
   * Parse raw status data into SessionUsage.
   * Returns null because Gemini CLI has no status line feature.
   */
  static parseStatus(_raw: string): SessionUsage | null {
    return null;
  }

  /**
   * Parse a single JSONL line from the event bridge into SessionEvent.
   * The event-bridge output format is agent-agnostic.
   */
  static parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }
}
