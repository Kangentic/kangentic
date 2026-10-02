/**
 * Antigravity's `--output-format stream-json` events, read for a Knowledge Graph
 * answer, and the conversation a run leaves behind.
 *
 * Captured on agy 1.2.11:
 *
 *   { event: "init", conversation_id, init: { cwd, tools } }
 *   { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE",
 *     text_delta } }                                     the answer as it is written
 *   { event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name } }
 *   { event: "result", result: { status, response } }    the final text (see the adapter)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AnswerStreamEvent } from '../../shared/cli-answer';
import { antigravityDataRoot } from './data-paths';

interface AntigravityRecord {
  event?: unknown;
  conversation_id?: unknown;
  step_update?: { step_type?: unknown; state?: unknown; text_delta?: unknown; tool_name?: unknown };
}

function parse(line: string): AntigravityRecord | null {
  if (!line.startsWith('{')) return null;
  try {
    const record = JSON.parse(line) as unknown;
    return record && typeof record === 'object' ? record as AntigravityRecord : null;
  } catch {
    return null;
  }
}

/** Text deltas as they are written, and each tool as it starts. */
export function antigravityAnswerEvents(line: string): AnswerStreamEvent[] {
  const record = parse(line);
  const step = record?.event === 'step_update' ? record.step_update : undefined;
  if (!step) return [];
  if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
    return [{ kind: 'text', text: step.text_delta }];
  }
  if (step.step_type === 'tool' && step.state === 'ACTIVE' && typeof step.tool_name === 'string') {
    return [{ kind: 'tool', name: step.tool_name }];
  }
  return [];
}

/** The conversation id on the init event, or null. */
export function antigravityConversationId(line: string): string | null {
  if (!line.includes('"init"')) return null;
  const record = parse(line);
  return record?.event === 'init' && typeof record.conversation_id === 'string' ? record.conversation_id : null;
}

/**
 * Remove what one run left in agy's data root: its brain folder (the whole
 * transcript and any plan artifacts), its conversation database, and its
 * presence lock. An answer is not a conversation to resume. Best-effort.
 */
export async function removeAntigravityConversation(conversationId: string): Promise<void> {
  // A conversation id is a UUID; anything else is not a path to act on.
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return;
  const root = antigravityDataRoot();
  await Promise.all([
    path.join(root, 'brain', conversationId),
    path.join(root, 'conversations', `${conversationId}.db`),
    path.join(root, 'presence', `${conversationId}.lock`),
  ].map((target) => fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined)));
}
