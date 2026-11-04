import type { SessionUsage, SessionEvent, SessionStartReport } from '../../../../shared/types';

/**
 * The SessionStart sources that move the terminal's conversation: `/clear`
 * and `/branch` start a new session id (`config.startNewSession()` in
 * packages/cli/src/ui/commands/clearCommand.ts and useBranchCommand.ts),
 * `/resume` inside the TUI loads another, and `compact` keeps the same one.
 * `startup` is a launch. `SessionStartSource` in
 * https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/hooks/types.ts.
 */
const MOVING_SOURCES: ReadonlySet<string> = new Set(['resume', 'clear', 'compact', 'branch']);

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
   * Read a SessionStart hook payload (`statusFile.parseSessionStart`): the
   * `session_id` it names, and whether its `source` moved the terminal's
   * conversation there. With `runtime.sessionId.followsSessionStartMoves`, a
   * move to a new id (a `/clear` or `/branch`) switches the session's id, so
   * a later resume reopens the conversation the user was in.
   *
   * An unknown or missing source reads as a launch. A payload carrying
   * `agent_id` fired inside a subagent (hooks.md, v0.26.6) and never names
   * the terminal's conversation, so it is not read. An id that could leave
   * the chats folder (a path separator, or `..`) is not read either: the id
   * names the chat file and the subagent folder. Built from Qwen's source;
   * the live 0.25.2 capture holds only a `startup` SessionStart.
   */
  static parseSessionStart(hookContext: string): SessionStartReport | null {
    let payload: unknown;
    try {
      payload = JSON.parse(hookContext);
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (typeof record.agent_id === 'string' && record.agent_id.length > 0) return null;
    const sessionId = record.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    if (/[\\/]/.test(sessionId) || sessionId.includes('..')) return null;
    const movesConversation = typeof record.source === 'string' && MOVING_SOURCES.has(record.source);
    return { agentSessionId: sessionId, movesConversation, inBackgroundSession: false };
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
