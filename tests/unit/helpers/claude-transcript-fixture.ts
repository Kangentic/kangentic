/**
 * Claude transcript lines for tests that read a turn's reply from a temp JSONL
 * with the REAL window parser (`parseClaudeTranscriptWindow`): the human prompt,
 * a background job's `<task-notification>`, an `isMeta` peer hand-back, assistant
 * text, an assistant tool call, its tool result, and the lines the CLI writes
 * when a turn ends. `claudeWindowAdapter` is the window read over such a file.
 *
 * The lines are synthetic, shaped like the CLI's own. Which fields matter:
 *
 * - `isMeta` on the peer hand-back. The parser drops an `isMeta` user line
 *   (transcript-parser.ts), so a turn that one opened has no prompt entry.
 * - The `<task-notification>` text prefix. The parser keeps that line as a user
 *   entry, and `finalAgentReply` (shared/agent-reply.ts) refuses it as the
 *   prompt that ends the walk back.
 * - The turn-end system lines (`stop_hook_summary`, `turn_duration`). The
 *   parser keeps neither (it handles only `compact_boundary`), so they give no
 *   entry. They are here because the CLI writes them after every turn, so the
 *   offset an anchor takes after a turn steps across them.
 *
 * `promptSource` and `origin` are on the prompt lines because the Claude CLI
 * writes them (src/main/agent/adapters/claude/background-shell-transcript.ts:16
 * cites `promptSource: "system"`; nothing in this repo cites `origin`). The
 * parser reads neither, so no test here depends on their values.
 */
import { parseClaudeTranscriptWindow } from '../../../src/main/agent/adapters/claude/transcript-parser';
import type { MessageTrailAdapter } from '../../../src/main/agent/message-trail-read';

export interface ClaudeTranscriptSession {
  /** The `sessionId` every line carries. */
  agentSessionId: string;
  /** The `cwd` every line carries. */
  cwd: string;
}

export interface ClaudeTranscriptLines {
  /** A prompt the user typed: the real prompt a walk back stops at. */
  humanPrompt(uuid: string, text: string): string;
  /** A background job's completion restarting the agent. Not a real prompt. */
  notification(uuid: string): string;
  /** An `isMeta` hand-back from a peer session, which the parser drops. */
  peerHandBack(uuid: string): string;
  assistantText(uuid: string, text: string): string;
  assistantTool(uuid: string, toolUseId: string, name: string): string;
  toolResult(uuid: string, toolUseId: string, content?: string): string;
  /** What the CLI writes after a turn's last assistant line. */
  turnEnd(uuid: string): string;
}

/**
 * Line builders for one session. Each fixture stamps its lines from its own
 * clock, one second apart, so timestamps rise in the order the lines are built.
 */
export function claudeTranscriptLines(session: ClaudeTranscriptSession): ClaudeTranscriptLines {
  let clock = 0;

  function line(record: Record<string, unknown>): string {
    clock += 1;
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
    return `${JSON.stringify({ sessionId: session.agentSessionId, cwd: session.cwd, timestamp, ...record })}\n`;
  }

  function assistantMessage(uuid: string, content: Array<Record<string, unknown>>): string {
    return line({ type: 'assistant', uuid, message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-test', content } });
  }

  return {
    humanPrompt: (uuid, text) => line({
      type: 'user',
      uuid,
      promptSource: 'typed',
      origin: { kind: 'human' },
      message: { role: 'user', content: text },
    }),

    notification: (uuid) => line({
      type: 'user',
      uuid,
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>job-1</task-id>\n<status>completed</status>\n</task-notification>',
      },
    }),

    peerHandBack: (uuid) => line({
      type: 'user',
      uuid,
      isMeta: true,
      promptSource: 'system',
      origin: { kind: 'peer' },
      message: { role: 'user', content: 'Another session sent a message: the review is done.' },
    }),

    assistantText: (uuid, text) => assistantMessage(uuid, [{ type: 'text', text }]),

    assistantTool: (uuid, toolUseId, name) => assistantMessage(uuid, [{ type: 'tool_use', id: toolUseId, name, input: {} }]),

    toolResult: (uuid, toolUseId, content = 'ok') => line({
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    }),

    turnEnd: (uuid) => line({ type: 'system', subtype: 'stop_hook_summary', uuid: `${uuid}-hooks` })
      + line({ type: 'system', subtype: 'turn_duration', uuid, durationMs: 1000, messageCount: 3 }),
  };
}

/**
 * The window read a trail or a final-reply read goes through, over one
 * transcript file: the file is always the one located, and each window is
 * parsed by the real Claude window parser with `sourcePath` set.
 */
export function claudeWindowAdapter(filePath: string): MessageTrailAdapter {
  return {
    locateSessionHistoryFile: async () => filePath,
    parseTranscriptWindow: async (_agentSessionId, _cwd, startByte, maxBytes) => ({
      ...(await parseClaudeTranscriptWindow(filePath, startByte, maxBytes)),
      sourcePath: filePath,
    }),
  };
}
