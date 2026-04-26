import type { SessionUsage, SessionEvent } from '../../../../shared/types';

/**
 * Parses Qwen Code status and event data.
 *
 * Qwen Code (like Gemini) does not emit status line data (no context
 * window / cost streaming), so parseStatus always returns null. Event
 * parsing reuses the same JSONL format written by the agent-agnostic
 * event-bridge.
 */
export class QwenStatusParser {
  /**
   * Parse raw status data into SessionUsage.
   * Returns null because Qwen Code has no status line feature.
   */
  static parseStatus(_raw: string): SessionUsage | null {
    return null;
  }

  /**
   * Parse a single JSONL line from the event bridge into SessionEvent.
   * The event-bridge output format is agent-agnostic. The double cast
   * through `unknown` documents that we're crossing a runtime boundary -
   * `JSON.parse` returns `any` and TypeScript can't enforce `SessionEvent`
   * shape from string content. Trust is bounded because the bridge writer
   * is in our own codebase (`src/main/agent/event-bridge.js`).
   */
  static parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as unknown as SessionEvent;
    } catch {
      return null;
    }
  }
}
