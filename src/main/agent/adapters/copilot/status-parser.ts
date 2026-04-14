import type { SessionUsage, SessionEvent } from '../../../../shared/types';

/**
 * Parses GitHub Copilot CLI status and event data.
 *
 * Copilot CLI supports the same `statusLine` config pattern as Claude Code:
 * a command that receives session status JSON on stdin and prints status to
 * stdout. The status-bridge.js script writes this JSON to a file that the
 * StatusFileReader watches.
 *
 * The status JSON format from Copilot's statusLine has not been empirically
 * verified yet. `parseStatus` returns null until a real sample is captured
 * and a fixture test is written to pin the expected shape. The event bridge
 * JSONL format is agent-agnostic and handled by `parseEvent`.
 */
export class CopilotStatusParser {
  /**
   * Parse raw status JSON from Copilot CLI's statusLine bridge into SessionUsage.
   *
   * Returns null until Copilot's actual statusLine JSON format is empirically
   * verified and a fixture test is written. The statusLine is still injected
   * (so the status file is created), but the data is not consumed until the
   * format is confirmed. This avoids silently returning wrong data.
   *
   * TODO: Capture a real Copilot statusLine sample, add it as a fixture in
   * tests/fixtures/, write a unit test, then implement parsing here.
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
