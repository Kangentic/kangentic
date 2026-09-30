/**
 * Copilot's `--output-format json` stream, read for a Knowledge Graph answer.
 *
 * One JSON object per line, each `{ type, data }`. Captured on CLI 1.0.88:
 *
 *   assistant.message_delta  { messageId, deltaContent }   text as written (`--stream on`)
 *   assistant.message        { messageId, content, toolRequests, phase }
 *                            the complete message; the answer is the last one with
 *                            content (`phase: "final_answer"`), and a turn that only
 *                            calls a tool has `content: ""`
 *   tool.execution_start     { toolName, mcpToolName, arguments }
 *   assistant.reasoning_delta, session.*, model.*, ...        not shown
 *   result                   { sessionId, exitCode, usage }   the last line
 */

import type { AnswerStreamEvent } from '../../shared/auto-name';

interface CopilotRecord {
  type?: unknown;
  data?: Record<string, unknown>;
  exitCode?: unknown;
}

function parse(line: string): CopilotRecord | null {
  if (!line.startsWith('{')) return null;
  try {
    const record = JSON.parse(line) as unknown;
    return record && typeof record === 'object' ? record as CopilotRecord : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A stateful reducer: text from the deltas, and a complete message's text
 * only when no delta for that message was seen (a run without `--stream on`),
 * so nothing reaches the reader twice.
 */
export function createCopilotAnswerReducer(): (line: string) => AnswerStreamEvent[] {
  const streamedMessages = new Set<string>();
  return (line) => {
    const record = parse(line);
    if (!record) return [];
    if (record.type === 'assistant.message_delta') {
      const text = stringField(record.data, 'deltaContent');
      streamedMessages.add(stringField(record.data, 'messageId'));
      return text ? [{ kind: 'text', text }] : [];
    }
    if (record.type === 'assistant.message') {
      const content = stringField(record.data, 'content');
      if (!content || streamedMessages.has(stringField(record.data, 'messageId'))) return [];
      return [{ kind: 'text', text: content }];
    }
    if (record.type === 'tool.execution_start') {
      const name = stringField(record.data, 'mcpToolName') || stringField(record.data, 'toolName');
      return name ? [{ kind: 'tool', name }] : [];
    }
    return [];
  };
}

/**
 * The answer: the last assistant message with content. Throws the CLI's own
 * error text, so the chat shows why, when the run failed: its result line
 * reports a non-zero exit code, even after an answer (a partial answer read as
 * a whole one), or it wrote no answer and some event reported an error. An
 * error event in a run that exited 0 was recovered from, a failed tool call
 * among them, so its answer stands.
 */
export function extractCopilotAnswer(stdout: string): string {
  let answer = '';
  let errorText = '';
  let exitCode: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const record = parse(line);
    if (!record) continue;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'assistant.message') {
      const content = stringField(record.data, 'content').trim();
      if (content) answer = content;
    } else if (type === 'result') {
      exitCode = typeof record.exitCode === 'number' ? record.exitCode : null;
    } else if (type.endsWith('error')) {
      errorText = stringField(record.data, 'message') || stringField(record.data, 'error') || errorText;
    }
  }
  if (exitCode !== null && exitCode !== 0) throw new Error(errorText || `the agent exited ${exitCode}`);
  if (answer) return answer;
  if (errorText) throw new Error(errorText);
  return '';
}
