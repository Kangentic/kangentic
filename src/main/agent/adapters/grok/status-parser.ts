import type { SessionUsage, SessionEvent } from '../../../../shared/types';

/**
 * Parses Grok Build status and event data.
 *
 * Grok has NO statusline mechanism (verified against the grok 1.0.0 user
 * guide - the one structural divergence from Claude's harness), so
 * `parseStatus` always returns null; live telemetry comes from tailing the
 * native `updates.jsonl` instead (see GrokSessionHistoryParser).
 *
 * `parseEvent` decodes the agent-agnostic event-bridge JSONL that grok's
 * hooks append (hook-manager.ts): this is the LIVE activity pipeline, not a
 * dormant stub - grok fires the full Claude-compatible hook set, verified
 * end to end against grok 1.0.0 including headless mode.
 */
export class GrokStatusParser {
  static parseStatus(_raw: string): SessionUsage | null {
    return null;
  }

  static parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }
}
