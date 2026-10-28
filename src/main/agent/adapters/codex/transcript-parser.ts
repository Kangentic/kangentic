import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { codexHomeDir } from './config-toml';
import type { CliPlace } from '../../shared/cli-target';
import { touchBounded } from '../../shared/bounded-lru';
import { readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';

/** Codex uuids number lines (see `parseCodexRecord`), so the tail, its notice and every page count them. */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Codex CLI's native rollout JSONL into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Schema (empirically verified against real Codex rollouts, 2026-06):
 * append-only JSONL, one object per line as `{ timestamp, type, payload }`.
 * The conversation lives in `type: "response_item"` entries; Codex also emits
 * a parallel `type: "event_msg"` stream that duplicates user/assistant text,
 * so we read `response_item` ONLY to avoid double-rendering every turn.
 *
 * `response_item` payload variants:
 *   - `message` with `role`:
 *       - `developer` / `system`: instruction wrappers - skipped.
 *       - `user`: `content[].input_text` joined. Codex injects an
 *         `<environment_context>` (and sometimes `<user_instructions>`)
 *         wrapper as a synthetic user turn; those are skipped.
 *       - `assistant`: `content[].output_text` joined -> assistant text.
 *   - `reasoning`: `summary[]` of `{ type: "summary_text", text }`. Real
 *     rollouts almost always carry an empty summary plus `encrypted_content`
 *     (no plaintext), so only non-empty summaries become thinking blocks.
 *   - `function_call`: `{ name, arguments (JSON string), call_id }` -> tool_use.
 *   - `function_call_output`: `{ call_id, output (string) }` -> tool_result.
 *
 * Model is tracked from `turn_context` entries (`payload.model`) and attached
 * to the assistant entries that follow.
 *
 * Defensive parsing throughout: a malformed line is skipped, never thrown.
 */
export async function parseCodexTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  // `countOmittedLines` because the uuids below embed the ABSOLUTE physical
  // line index (see there). A rollout is append-only, so that index is stable.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: UUIDS_NUMBER_LINES,
  });
  if (window.totalBytes === 0) return [];

  // Line indices must stay absolute within the FILE, not relative to the
  // window (the Grok precedent), so the lines are numbered from the count
  // before it.
  const entries = parseCodexLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  // The notice carries the cursor the Conversation viewer pages the left-out
  // history from (`readCodexTranscriptPage`), with the line count the uuids need.
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, jsonlEarlierHistory(agentSessionId, window, UUIDS_NUMBER_LINES));
}

/**
 * One page of a Codex rollout's history for the Conversation viewer
 * (`AgentAdapter.readTranscriptPage`). Every uuid is named by its line, so
 * cursors carry a line count.
 */
export function readCodexTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: UUIDS_NUMBER_LINES,
    parseLines: (lines) => parseCodexLines(agentSessionId, lines),
  });
}

/** What one read carries from line to line: the model the last `turn_context` named. */
interface CodexLineState {
  model: string | undefined;
}

/**
 * Parse whole lines into entries, each stamped with the byte its line starts at.
 *
 * The model starts unknown on every call, so assistant entries before a read's
 * first `turn_context` carry none. The tail has always read its own start that
 * way, and a history page reads its start the same way: carrying the model in
 * from earlier lines would need state between reads, which a page keeps none
 * of. Rollouts measured on the dev machine were at most 0.3 MB, far under the
 * tail's cap, so in practice a rollout is read whole and never paged.
 */
function parseCodexLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const state: CodexLineState = { model: undefined };
  for (const { text: line, byte, line: lineNumber } of lines) {
    if (line.length === 0) continue;
    const firstNew = entries.length;
    parseCodexRecord(agentSessionId, line, lineNumber ?? 0, state, entries);
    stampOrigin(entries, firstNew, agentSessionId, byte);
  }
  return entries;
}

/** Parse one JSONL record, appending what it yields and noting a new model. */
function parseCodexRecord(
  agentSessionId: string,
  line: string,
  lineNumber: number,
  state: CodexLineState,
  entries: TranscriptEntry[],
): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw)) return;

  const ts = parseTimestamp(raw.timestamp);

  if (raw.type === 'turn_context' && isRecord(raw.payload)) {
    const model = raw.payload.model;
    if (typeof model === 'string' && model.length > 0) state.model = model;
    return;
  }

  if (raw.type !== 'response_item' || !isRecord(raw.payload)) return;
  const payload = raw.payload;
  // Session-scoped and ABSOLUTE. Both halves are load-bearing, and a rollout
  // carries no per-record id to derive either from (only `function_call` /
  // `function_call_output` have a `call_id`, and they share it as a pair).
  //   - absolute, because these uuids are the persisted citation anchors
  //     `sliceTranscriptAroundUuid` resolves against. The window-relative
  //     counter this replaced renumbered every turn once a transcript grew
  //     past the read cap and the tail window started sliding.
  //   - session-scoped, because `resolveTaskTranscript` stitches every
  //     session a task has had and dedups by uuid keeping the first. Two
  //     Codex sessions on one task both minted `codex-0..N`, so the second
  //     session's turns collided with the first's and vanished from the
  //     Conversation tab. That bug did not need a large transcript.
  const uuid = `${agentSessionId}:${lineNumber}`;

  if (payload.type === 'message') {
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') return; // skip developer/system
    const text = joinContentText(payload.content);
    if (text.length === 0) return;
    if (role === 'user') {
      // Skip Codex's injected context wrappers (not authored by the user).
      if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) {
        return;
      }
      entries.push({ kind: 'user', uuid, ts, text });
    } else {
      entries.push({ kind: 'assistant', uuid, ts, model: state.model, blocks: [{ type: 'text', text }] });
    }
    return;
  }

  if (payload.type === 'reasoning') {
    const blocks: TranscriptBlock[] = [];
    if (Array.isArray(payload.summary)) {
      for (const item of payload.summary) {
        if (isRecord(item) && typeof item.text === 'string' && item.text.length > 0) {
          blocks.push({ type: 'thinking', text: item.text });
        }
      }
    }
    if (blocks.length > 0) {
      entries.push({ kind: 'assistant', uuid, ts, model: state.model, blocks });
    }
    return;
  }

  if (payload.type === 'function_call') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
    const name = typeof payload.name === 'string' ? payload.name : 'function';
    const input = typeof payload.arguments === 'string'
      ? (tryParseJson(payload.arguments) ?? payload.arguments)
      : payload.arguments;
    entries.push({
      kind: 'assistant',
      uuid,
      ts,
      model: state.model,
      blocks: [{ type: 'tool_use', id: callId, name, input }],
    });
    return;
  }

  if (payload.type === 'function_call_output') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
    entries.push({
      kind: 'tool_result',
      uuid,
      ts,
      toolUseId: callId,
      content: stringifyOutput(payload.output),
    });
  }
}

/**
 * Locate the rollout JSONL for a known Codex session id. Unlike the
 * telemetry-side `CodexSessionHistoryParser.locate` (which polls only
 * today/yesterday for the post-spawn capture window), this walks the
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>` tree newest-first so an older session
 * can be viewed on demand. Returns the absolute path, or null if not found.
 * `place` is where the CLI ran when it was not this machine (a WSL distro).
 */
export function locateCodexTranscriptFile(agentSessionId: string, place: CliPlace | null = null): string | null {
  const root = path.join(codexHomeDir(place), 'sessions');
  const pattern = rolloutFilePattern(agentSessionId);

  for (const year of listDescending(root)) {
    const yearDir = path.join(root, year);
    for (const month of listDescending(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of listDescending(monthDir)) {
        const dayDir = path.join(monthDir, day);
        let names: string[];
        try {
          names = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        const match = names.find((name) => pattern.test(name));
        if (match) return path.join(dayDir, match);
      }
    }
  }
  return null;
}

const FOUND_ROLLOUTS_LIMIT = 256;
const FOUND_ROLLOUTS_BYTE_BUDGET = 64 * 1024;
/** Where `findCodexTranscriptFile` found each rollout, by sessions folder and id. */
const foundRollouts = new Map<string, string>();

/**
 * The same newest-first walk on `fs.promises`, for the adapter's on-demand
 * `locateSessionHistoryFile`. Several of its callers run on main (the Command
 * Terminal's Earlier conversations once per row, the handoff, session files,
 * analytics), where a synchronous readdir per day folder would hold the loop.
 * It replaced the telemetry locate there, which looked only in today's and
 * yesterday's folders and polled 5 s for anything older, so every on-demand
 * read of an older conversation found nothing and an Earlier conversations
 * row for it was deleted.
 */
export async function findCodexTranscriptFile(agentSessionId: string, place: CliPlace | null = null): Promise<string | null> {
  const root = path.join(codexHomeDir(place), 'sessions');
  // An Earlier conversations list asks for the same rollouts each time it
  // opens; a found one is re-checked instead of walked to again.
  const key = `${root}\u0000${agentSessionId}`;
  const known = foundRollouts.get(key);
  if (known && await fs.promises.stat(known).then(() => true, () => false)) return known;
  foundRollouts.delete(key);
  const pattern = rolloutFilePattern(agentSessionId);

  for (const year of await listDescendingAsync(root)) {
    const yearDir = path.join(root, year);
    for (const month of await listDescendingAsync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of await listDescendingAsync(monthDir)) {
        const dayDir = path.join(monthDir, day);
        const names = await fs.promises.readdir(dayDir).catch((): string[] => []);
        const match = names.find((name) => pattern.test(name));
        if (!match) continue;
        const filePath = path.join(dayDir, match);
        touchBounded(foundRollouts, key, filePath, {
          limit: FOUND_ROLLOUTS_LIMIT,
          byteBudget: FOUND_ROLLOUTS_BYTE_BUDGET,
          sizeOf: (held) => held.length,
          minRetained: 0,
        });
        return filePath;
      }
    }
  }
  return null;
}

/** Codex writes `rollout-<ISO timestamp>-<session id>.jsonl`; the timestamp is unknown, the id unique. */
function rolloutFilePattern(agentSessionId: string): RegExp {
  const escapedId = agentSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^rollout-.*-${escapedId}\\.jsonl$`);
}

function listDescending(directory: string): string[] {
  try {
    return fs.readdirSync(directory).sort(descending);
  } catch {
    return [];
  }
}

async function listDescendingAsync(directory: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(directory)).sort(descending);
  } catch {
    return [];
  }
}

function descending(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Join the `text` fields of a Codex message `content[]` (input_text/output_text/text). */
function joinContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A function_call_output `output` is usually a string; stringify other shapes. */
function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
