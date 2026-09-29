/**
 * OpenCode's `run --format json` events, read for a Knowledge Graph answer.
 *
 * One JSON object per line, captured on opencode 1.18.31:
 *
 *   step_start   { sessionID, part: { type: "step-start" } }
 *   text         { part: { type: "text", text } }       a COMPLETE text part,
 *                                                        written when its step ends
 *   tool_use     { part: { type: "tool", tool, state: { status, input, output } } }
 *   step_finish  { part: { reason: "tool-calls" | "stop", tokens, cost } }
 *
 * So OpenCode streams by step rather than by token: the narration before a
 * tool call arrives whole, then the tool, then the answer whole. The answer is
 * the text written after the last tool use.
 */

import type { AnswerStreamEvent } from '../../shared/auto-name';

interface OpenCodeRecord {
  type?: unknown;
  sessionID?: unknown;
  part?: { text?: unknown; tool?: unknown };
  error?: unknown;
}

function parse(line: string): OpenCodeRecord | null {
  if (!line.startsWith('{')) return null;
  try {
    const record = JSON.parse(line) as unknown;
    return record && typeof record === 'object' ? record as OpenCodeRecord : null;
  } catch {
    return null;
  }
}

function errorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; data?: { message?: unknown } };
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
    if (typeof record.data?.message === 'string' && record.data.message.trim()) return record.data.message.trim();
  }
  return null;
}

/** Each text part as its step completes, and each tool use. */
export function openCodeAnswerEvents(line: string): AnswerStreamEvent[] {
  const record = parse(line);
  if (!record) return [];
  if (record.type === 'text' && typeof record.part?.text === 'string' && record.part.text) {
    return [{ kind: 'text', text: record.part.text }];
  }
  if (record.type === 'tool_use' && typeof record.part?.tool === 'string') {
    return [{ kind: 'tool', name: record.part.tool }];
  }
  return [];
}

/** The text written after the last tool use. Throws the CLI's error when a run failed without one. */
export function extractOpenCodeAnswer(stdout: string): string {
  let sinceLastTool: string[] = [];
  let failure: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const record = parse(line);
    if (!record) continue;
    if (record.type === 'text' && typeof record.part?.text === 'string') sinceLastTool.push(record.part.text);
    else if (record.type === 'tool_use') sinceLastTool = [];
    else if (record.type === 'error') failure = errorMessage(record.error) ?? failure ?? 'the agent reported an error';
  }
  const answer = sinceLastTool.join('\n').trim();
  if (answer) return answer;
  if (failure) throw new Error(failure);
  return '';
}

/** The session id any event carries, or null. */
export function openCodeSessionId(line: string): string | null {
  if (!line.includes('sessionID')) return null;
  const record = parse(line);
  return typeof record?.sessionID === 'string' ? record.sessionID : null;
}
