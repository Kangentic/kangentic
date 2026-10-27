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
 *   { event: "result", result: { status, response, usage } }    the final text (see the
 *                                                               adapter) and what it cost
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentCallUsage } from '../../../../shared/types';
import type { AnswerStreamEvent } from '../../shared/cli-answer';
import { antigravityDataRoot } from './data-paths';
import type { CliPlace } from '../../shared/cli-target';

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
 * What a run cost, from a `usage` object agy prints: the stream's `result`
 * event or the print run's JSON. Captured on the current CLI (2026-10-13):
 *
 *   { input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }
 *
 * `total_tokens` is input plus output, so input is the fresh input and cache
 * reads are counted apart (one step: 2,230 input, 317 output, 14,972 cache
 * read, 2,547 total). Thinking is inside output. agy names no model and no
 * price, and reports no cache write. The 1.1.13 print run printed input and
 * output only, so cache reads count as 0 when absent. Null without both counts.
 */
export function antigravityUsage(value: unknown): AgentCallUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const count = (key: string): number | null => {
    const raw = usage[key];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  };
  const inputTokens = count('input_tokens');
  const outputTokens = count('output_tokens');
  if (inputTokens === null || outputTokens === null) return null;
  return {
    model: null,
    inputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: count('cache_read_tokens') ?? 0,
    outputTokens,
    costUsd: null,
  };
}

/**
 * The usage on a stream's `result` event, which is the whole run's: agy sums
 * its steps there, so the per-step `usage` on `step_update` lines is never
 * added up here. Null when no result arrived.
 */
export function antigravityStreamUsage(stdout: string): AgentCallUsage | null {
  let usage: AgentCallUsage | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes('"result"')) continue;
    const record = parse(line) as (AntigravityRecord & { result?: { usage?: unknown }; usage?: unknown }) | null;
    if (record?.event !== 'result') continue;
    usage = antigravityUsage(record.result?.usage ?? record.usage) ?? usage;
  }
  return usage;
}

/**
 * Remove what one run left in agy's data root: its brain folder (the whole
 * transcript and any plan artifacts), its conversation database, its presence
 * lock, and the title agy writes for it under `annotations` (new in the CLI
 * measured 2026-10-13: `title:"..."`). An answer is not a conversation to
 * resume. Best-effort. `place`: an agy in a WSL distro keeps it in the distro.
 */
export async function removeAntigravityConversation(conversationId: string, place: CliPlace | null = null): Promise<void> {
  // A conversation id is a UUID; anything else is not a path to act on.
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return;
  const root = antigravityDataRoot(place);
  await Promise.all([
    path.join(root, 'brain', conversationId),
    path.join(root, 'conversations', `${conversationId}.db`),
    path.join(root, 'presence', `${conversationId}.lock`),
    path.join(root, 'annotations', `${conversationId}.pbtxt`),
  ].map((target) => fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined)));
}
