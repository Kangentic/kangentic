import fs from 'node:fs';
import type { ParsedTranscript } from '../../agent-adapter';
import type { TranscriptBlock, TranscriptEntry } from '../../../../shared/types';
import {
  scanForSubmittedText,
  type UserTurnRecord,
} from '../../shared/submitted-text-verifier';
import { antigravityTranscriptPath } from './data-paths';

/**
 * Parser for Antigravity's per-conversation JSONL transcript at
 * `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
 * transcript.jsonl` (the exact path every hook payload reports as
 * `transcriptPath`). Format verified against agy 1.1.13; each line is a step:
 *
 *   { step_index, source: 'USER_EXPLICIT'|'SYSTEM'|'MODEL',
 *     type: 'USER_INPUT'|'PLANNER_RESPONSE'|'ERROR_MESSAGE'|'CHECKPOINT'|
 *           'CONVERSATION_HISTORY', status, created_at: ISO-8601,
 *     content?, thinking?, tool_calls?: [{ name, args }] }
 *
 * Notes that shape the mapping below:
 * - Lines are APPENDED during the session but can land slightly out of
 *   step_index order (observed: step 6 before step 5), so entries are sorted
 *   by step_index with last-write-wins on duplicates.
 * - USER_INPUT content wraps the actual prompt in `<USER_REQUEST>...`
 *   followed by `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` blocks the
 *   CLI injects; only the USER_REQUEST body is the user's text.
 * - tool_calls args values are themselves JSON-encoded strings
 *   (`"\"ok\""`, `"true"`); they are decoded for display when they parse.
 * - The transcript carries NO token usage - that is why the adapter has no
 *   `transcriptUsage` and declares `liveTelemetryUnsupported`.
 */

interface AntigravityStep {
  step_index: number;
  source?: string;
  type?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

/**
 * Resolve the transcript file for a conversation, or null when it does not
 * exist (yet). Non-polling: callers that need to wait (the adapter's
 * locateSessionHistoryFile) poll around this.
 */
export function locateAntigravityTranscriptFile(conversationId: string): string | null {
  const transcriptPath = antigravityTranscriptPath(conversationId);
  return fs.existsSync(transcriptPath) ? transcriptPath : null;
}

/** Read and order the raw steps of a conversation's transcript. */
function readSteps(transcriptPath: string): AntigravityStep[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return [];
  }

  const byIndex = new Map<number, AntigravityStep>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // A partially-flushed tail line - skip.
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const step = parsed as AntigravityStep;
    if (typeof step.step_index !== 'number') continue;
    byIndex.set(step.step_index, step); // last-write-wins on a re-emitted index
  }
  return Array.from(byIndex.values()).sort((left, right) => left.step_index - right.step_index);
}

/** Pull the user's actual prompt out of a USER_INPUT step's wrapped content. */
export function extractUserRequestText(content: string): string {
  const match = content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
  return (match ? match[1] : content).trim();
}

function stepTimestamp(step: AntigravityStep): number {
  const parsed = step.created_at ? Date.parse(step.created_at) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Decode a tool_calls args map whose values are JSON-encoded strings. */
function decodeToolArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === 'string') {
      try {
        decoded[key] = JSON.parse(value);
        continue;
      } catch {
        // Not JSON-encoded - keep the raw string.
      }
    }
    decoded[key] = value;
  }
  return decoded;
}

/**
 * Parse a conversation's transcript into agent-agnostic TranscriptEntry[].
 * Never throws: a missing or corrupt transcript yields `{ entries: [],
 * sourcePath }` per the AgentAdapter.parseTranscript contract.
 */
export async function parseAntigravityTranscript(
  agentSessionId: string,
  _cwd: string,
): Promise<ParsedTranscript> {
  const sourcePath = locateAntigravityTranscriptFile(agentSessionId);
  if (!sourcePath) return { entries: [], sourcePath: null };
  return parseAntigravityTranscriptFile(sourcePath);
}

/** Parse a known transcript file path (the `transcriptPath`-driven callers). */
export function parseAntigravityTranscriptFile(sourcePath: string): ParsedTranscript {
  const entries: TranscriptEntry[] = [];
  // The id of the most recent tool_use block, so a following ERROR_MESSAGE
  // step (agy records tool failures as their own step) can be attached as
  // that tool call's error result.
  let lastToolUseId: string | null = null;

  for (const step of readSteps(sourcePath)) {
    const uuid = `step-${step.step_index}`;
    const ts = stepTimestamp(step);

    switch (step.type) {
      case 'USER_INPUT': {
        if (typeof step.content !== 'string') break;
        entries.push({ kind: 'user', uuid, ts, text: extractUserRequestText(step.content) });
        break;
      }
      case 'PLANNER_RESPONSE': {
        // A new assistant step supersedes any prior tool_use as an error
        // anchor: without this reset, an ERROR_MESSAGE arriving after a
        // text-only response would attach to a long-resolved tool call from
        // an earlier turn (transcript fidelity: never misattribute).
        lastToolUseId = null;
        const blocks: TranscriptBlock[] = [];
        if (typeof step.thinking === 'string' && step.thinking.trim().length > 0) {
          blocks.push({ type: 'thinking', text: step.thinking.trim() });
        }
        if (typeof step.content === 'string' && step.content.trim().length > 0) {
          blocks.push({ type: 'text', text: step.content.trim() });
        }
        for (const [callIndex, toolCall] of (step.tool_calls ?? []).entries()) {
          if (!toolCall || typeof toolCall.name !== 'string') continue;
          const toolUseId = `${uuid}-tool-${callIndex}`;
          blocks.push({
            type: 'tool_use',
            id: toolUseId,
            name: toolCall.name,
            input: decodeToolArgs(toolCall.args),
          });
          lastToolUseId = toolUseId;
        }
        if (blocks.length > 0) {
          entries.push({ kind: 'assistant', uuid, ts, blocks });
        }
        break;
      }
      case 'ERROR_MESSAGE': {
        if (typeof step.content !== 'string' || !lastToolUseId) break;
        entries.push({
          kind: 'tool_result',
          uuid,
          ts,
          toolUseId: lastToolUseId,
          content: step.content.trim(),
          isError: true,
        });
        break;
      }
      case 'CHECKPOINT': {
        if (typeof step.content !== 'string') break;
        entries.push({ kind: 'system', uuid, ts, subtype: 'compaction', text: step.content.trim() });
        break;
      }
      default:
        // CONVERSATION_HISTORY and any future step types carry nothing the
        // viewer can render - skip defensively.
        break;
    }
  }

  return { entries, sourcePath };
}

/**
 * Watermark slack for the injection verifier. The transcript's `created_at`
 * values are truncated to whole seconds (verified against agy 1.1.13), so a
 * record written milliseconds after `sentAt` can carry a timestamp up to ~1s
 * BEFORE it; 5s keeps the original calibration's margin for clock skew on
 * top. The shared scan's own 50ms tolerance rides on top of this.
 */
const TRANSCRIPT_TIMESTAMP_SLACK_MS = 5_000;

/**
 * Extract a USER_INPUT turn from one transcript.jsonl line, in the shared
 * submitted-text verifier's `UserTurnRecord` shape. Non-user-turn lines
 * return null; a partial-flush parse failure throws, which
 * `scanForSubmittedText` treats the same way.
 */
export function extractAntigravityUserTurn(line: string): UserTurnRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object') return null;
  const step = parsed as { type?: unknown; content?: unknown; created_at?: unknown };
  if (step.type !== 'USER_INPUT' || typeof step.content !== 'string') return null;
  const timestamp = typeof step.created_at === 'string' ? Date.parse(step.created_at) : NaN;
  return {
    timestampMs: Number.isNaN(timestamp) ? null : timestamp,
    text: extractUserRequestText(step.content),
  };
}

/**
 * Verify that a command-injection submission became a real user turn: a
 * USER_INPUT step whose USER_REQUEST body equals the submitted text, created
 * at or after `sentAt` minus the whole-second slack above.
 *
 * Built on the shared bounded tail scan (`scanForSubmittedText` over the
 * cached `readTranscriptTailLines`), NOT a full-file read: the caller polls
 * every 25ms for up to ~2s per submission, so a whole-file parse here would
 * grow with conversation length and block the main process on every poll.
 * The backward scan also means that of two identical texts inside the slack
 * window, the most recent record - the current submission's - wins.
 *
 * Gated on the measured submit-time flush (scripts/measure-injection-flush.mjs
 * per docs/command-injection.md); only wired into getSubmissionVerifier when
 * that measurement passed.
 */
export function createAntigravityInjectionVerifier(
  transcriptPath: string | null,
): ((text: string, sentAt: number) => Promise<boolean>) | null {
  if (!transcriptPath) return null;
  return (text: string, sentAt: number): Promise<boolean> =>
    scanForSubmittedText(
      transcriptPath,
      text,
      sentAt - TRANSCRIPT_TIMESTAMP_SLACK_MS,
      extractAntigravityUserTurn,
    );
}
