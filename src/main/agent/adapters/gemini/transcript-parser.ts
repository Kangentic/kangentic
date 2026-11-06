import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';
import type { TranscriptEntry, TranscriptBlock, TranscriptTurnUsage } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { timeSyncWork } from '../../../diagnostics/event-loop-lag';
import { geminiChatFilePattern, geminiChatsDir } from './session-history-parser';

/** A Gemini message without its own id is named by its line, so the tail, its notice and every page count lines. */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Gemini CLI's native chat session file into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Format (empirically verified against real Gemini CLI sessions, 2026-06):
 * the current CLI writes append-only JSONL, NOT the single-object `.json` the
 * telemetry-side `GeminiSessionHistoryParser` still assumes. Lines are:
 *   - a header line `{ sessionId, projectHash, startTime, lastUpdated, kind }`;
 *   - `$set` patch lines. The FIRST `$set` seeds `messages[]` (carrying the
 *     opening user turn); later `$set`s touch only `lastUpdated`. So `$set`
 *     payloads can carry a `messages[]` array we must fold in;
 *   - standalone message lines `{ id, timestamp, type: 'user'|'gemini',
 *     content, thoughts?, tokens?, model?, toolCalls? }`;
 *   - `$patch` and `$rewindTo` records, applied as `parseGeminiLines` describes.
 *
 * Critical: Gemini RE-EMITS a message with the SAME `id` as it streams (first
 * without `toolCalls`, then again with them). We dedupe by `id`, last emission
 * wins, preserving first-seen order, or every turn renders twice.
 *
 * Mapping:
 *   - `user`: `content[].text` joined -> user entry. The CLI's injected
 *     `<session_context>` opening turn is skipped (not authored by the user).
 *   - `gemini`: assistant entry with `model`; `thoughts[]` ->
 *     thinking blocks (`subject: description`), non-empty `content` -> text,
 *     `toolCalls[]` -> tool_use blocks plus synthesized tool_result entries
 *     from each call's embedded `result[].functionResponse.response`.
 *
 * Also tolerates the legacy single-JSON-object form (`{ messages: [...] }`) so
 * older sessions still parse. Defensive throughout: malformed lines skipped.
 */
export async function parseGeminiTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: UUIDS_NUMBER_LINES,
  });
  if (window.totalBytes === 0) return [];

  const trimmed = window.text.trim();
  // `window.omittedBytes === 0` is load-bearing, not belt-and-braces. The legacy
  // form is ONE JSON object spanning the whole file, so it is detected by the
  // file containing no newlines - but a tail window of a legacy document larger
  // than the cap also contains no newline, while being a fragment whose opening
  // brace was cut off. Without this guard it would fall through to the JSONL
  // loop and silently yield zero entries instead of the conversation.
  // Both ends checked, not just the head: `omittedBytes === 0` alone only means
  // the window started at byte 0, which would still be true of a document read
  // from the start and cut short at the cap.
  const isWholeFile = window.omittedBytes === 0 && window.nextByteOffset >= window.totalBytes;
  if (isWholeFile && trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.includes('\n')) {
    // Legacy single-object form: one JSON object with a messages[] array.
    return timeSyncWork('transcript:parse-gemini', () => {
      const kept = new Map<string, KeptItem>();
      const parsed = tryParseJson(trimmed);
      if (isRecord(parsed) && Array.isArray(parsed.messages)) {
        // The legacy form is one object on one line, so every message shares
        // line 0 and is distinguished by its index within the array. Its entries
        // carry no `origin`, since one line holds nothing to page.
        for (const [index, message] of parsed.messages.entries()) {
          keepMessage(kept, agentSessionId, message, 0, index, null);
        }
      }
      return entriesFromMessages(agentSessionId, kept);
    });
  }

  // The line count is only used when a message lacks its own `id`. See the
  // Qwen parser for why it is resolved up front rather than lazily.
  const entries = parseGeminiLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  if (window.omittedBytes <= 0) return entries;
  // The notice carries the cursor the Conversation viewer pages the left-out
  // history from (`readGeminiTranscriptPage`), with the line count the uuids
  // need. A legacy document past the cap gets the notice without one. Its tail
  // window held no whole line, and the page read refuses that form.
  const history = await isLegacyGeminiDocument(filePath)
    ? undefined
    : jsonlEarlierHistory(agentSessionId, window, UUIDS_NUMBER_LINES);
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, history);
}

/**
 * One page of a Gemini transcript's history for the Conversation viewer
 * (`AgentAdapter.readTranscriptPage`). A message without its own id is named
 * by its line, so cursors carry a line count. The legacy single document is
 * one line with nothing before it to page, so it answers `unsupported_agent`.
 */
export async function readGeminiTranscriptPage(
  agentSessionId: string,
  filePath: string | null,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  if (!filePath) return { status: 'unavailable', reason: 'file_missing' };
  if (await isLegacyGeminiDocument(filePath)) return { status: 'unavailable', reason: 'unsupported_agent' };
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: UUIDS_NUMBER_LINES,
    parseLines: (lines) => parseGeminiLines(agentSessionId, lines),
  });
}

/**
 * One bounded window of a Gemini chat file (`AgentAdapter.parseTranscriptWindow`),
 * retaining nothing between calls: the conversation indexer walks the whole
 * file this way, the message trail reads what was appended, and a turn end's
 * reply is read from its anchor.
 *
 * Patches and rewinds apply within the window, as for the tail and a page.
 * Usage needs no carry across windows: a reply's uuid is its message id, so
 * a copy re-emitted in a later window updates the same ledger row.
 *
 * Lines are counted from the file's start only when the window holds a
 * message with no id of its own, the one case whose uuid is its line number.
 * Gemini 0.66.0 gives every message an id, so a live read never pays for the
 * count. A legacy single document is one line: the window at byte 0 parses it
 * whole, and any later window holds nothing.
 */
export async function parseGeminiTranscriptWindow(
  agentSessionId: string,
  filePath: string,
  startByte: number,
  maxBytes: number,
): Promise<{ entries: TranscriptEntry[]; nextByteOffset: number; totalBytes: number; firstByteOffset: number; endByte: number }> {
  if (await isLegacyGeminiDocument(filePath)) {
    const totalBytes = await fs.promises.stat(filePath).then((stat) => stat.size, () => null);
    if (totalBytes === null) return { entries: [], nextByteOffset: 0, totalBytes: 0, firstByteOffset: 0, endByte: 0 };
    const entries = startByte === 0 ? await parseGeminiTranscript(agentSessionId, filePath) : [];
    return { entries, nextByteOffset: totalBytes, totalBytes, firstByteOffset: Math.min(startByte, totalBytes), endByte: totalBytes };
  }
  let window = await readJsonlWindow(filePath, { startByte, maxBytes });
  let namedByLine = false;
  let entries = parseGeminiLines(
    agentSessionId,
    splitJsonlLines(window.text, window.startByte, window.startByte === 0 ? 0 : null),
    () => { namedByLine = true; },
  );
  if (namedByLine && window.startByte > 0) {
    window = await readJsonlWindow(filePath, { startByte, maxBytes, countOmittedLines: true });
    entries = parseGeminiLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  }
  return {
    entries,
    nextByteOffset: window.nextByteOffset,
    totalBytes: window.totalBytes,
    firstByteOffset: window.startByte,
    endByte: window.endByte,
  };
}

/** Head bytes read to tell the legacy single document from a current JSONL file. */
const GENERATION_PROBE_BYTES = 4096;

/**
 * Whether a session file is the legacy single document, one JSON object
 * carrying `messages[]` on one line. Reads the head only, never the whole
 * file. A current file opens with a short header line that has no `messages`,
 * so a first line that outruns the head is read as legacy too. Misreading a
 * current file that way costs its paging, never its entries.
 */
async function isLegacyGeminiDocument(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, GENERATION_PROBE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline === -1 && bytesRead < size) return true;
    const firstLine = tryParseJson(buffer.toString('utf8', 0, newline === -1 ? bytesRead : newline));
    return isRecord(firstLine) && Array.isArray(firstLine.messages);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => { /* swallow */ });
  }
}

/**
 * What a window keeps, in order: a message the dedupe kept, or the tool results
 * a `$patch` line delivered for a message this window does not hold.
 */
type KeptItem =
  | {
    kind: 'message';
    message: Record<string, unknown>;
    /** The byte its kept emission's line starts at. Null for the legacy single document, whose entries carry no origin. */
    position: number | null;
  }
  | {
    kind: 'patched-results';
    /** The uuid of the message the results belong to, so they key as its own results do. */
    messageUuid: string;
    toolCalls: Array<Record<string, unknown>>;
    position: number;
    /** A patch line has no time of its own: the latest message time the window read before it. */
    ts: number | null;
  };

/**
 * Parse whole JSONL lines into entries, for the tail and a history page alike.
 * The dedupe runs within one call, which is one window of lines. A message
 * re-emitted in a later window is parsed there again under the same uuid with
 * its own line's origin. The viewer keeps the copy from the later position,
 * which is the same last-emission rule.
 *
 * The other records apply as the CLI's own loader applies them
 * (`createJsonlRecordAccumulator`, chatRecordingService.ts at v0.66.0,
 * https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingService.ts),
 * within this window:
 *   - `$patch` sets a message's `content` and its tool calls' `result` by call
 *     id, also for each entry of `updates[]`; `removeIds` deletes messages;
 *     `orderIds` moves the listed messages to the end in that order. Gemini
 *     writes a tool's result this way after the call was recorded, so a patch
 *     for a message an earlier window holds yields that message's results
 *     here, at the patch line.
 *   - `$rewindTo: <id>` (written by `/rewind`) drops that message and every
 *     one after it. When the id is not in the window the CLI clears what it
 *     holds, and that is also right for a window: the target sits earlier, so
 *     everything this window kept so far came after it. A window that starts
 *     after the rewind line, a page of older history, still shows the turns the
 *     rewind dropped.
 * `collectGeminiMessages` in session-history-parser.ts applies the same
 * records for the telemetry reader: change both together.
 * Built from that source. `$rewindTo` is replayed from a real 0.66.0 chat
 * (gemini-real-rewind.test.ts); `$patch`, `removeIds` and `orderIds` are not
 * yet run against a real session file.
 */
function parseGeminiLines(
  agentSessionId: string,
  lines: ReadonlyArray<JsonlLine>,
  onLineNamedMessage?: () => void,
): TranscriptEntry[] {
  return timeSyncWork('transcript:parse-gemini', () => collectGeminiEntries(agentSessionId, lines, onLineNamedMessage));
}

function collectGeminiEntries(
  agentSessionId: string,
  lines: ReadonlyArray<JsonlLine>,
  onLineNamedMessage?: () => void,
): TranscriptEntry[] {
  const kept = new Map<string, KeptItem>();
  let latestMessageTs: number | null = null;
  for (const { text, byte, line } of lines) {
    if (text.length === 0) continue;
    const parsed = tryParseJson(text);
    if (!isRecord(parsed)) continue;
    const lineNumber = line ?? 0;
    // `$set` patch line: fold in any seeded messages, ignore other keys.
    if (isRecord(parsed.$set)) {
      if (Array.isArray(parsed.$set.messages)) {
        for (const [index, message] of parsed.$set.messages.entries()) {
          if (keepMessage(kept, agentSessionId, message, lineNumber, index, byte)) onLineNamedMessage?.();
        }
      }
      continue;
    }
    if (typeof parsed.$rewindTo === 'string') {
      rewindTo(kept, parsed.$rewindTo);
      continue;
    }
    if (isRecord(parsed.$patch)) {
      applyPatchRecord(kept, parsed.$patch, byte, latestMessageTs);
      continue;
    }
    const messageTs = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
    if (Number.isFinite(messageTs)) latestMessageTs = messageTs;
    if (keepMessage(kept, agentSessionId, parsed, lineNumber, null, byte)) onLineNamedMessage?.();
  }
  return entriesFromMessages(agentSessionId, kept);
}

/** Drop `messageId` and everything after it, or everything when it is not here. */
function rewindTo(kept: Map<string, KeptItem>, messageId: string): void {
  if (!kept.has(messageId)) {
    kept.clear();
    return;
  }
  let found = false;
  for (const key of [...kept.keys()]) {
    if (key === messageId) found = true;
    if (found) kept.delete(key);
  }
}

/** One `$patch` record: its own patch, then each of `updates[]`, then `removeIds` and `orderIds`. */
function applyPatchRecord(
  kept: Map<string, KeptItem>,
  patch: Record<string, unknown>,
  position: number,
  timestampMs: number | null,
): void {
  const singles: unknown[] = [patch, ...(Array.isArray(patch.updates) ? patch.updates : [])];
  for (const [index, single] of singles.entries()) {
    // Keyed by the line's byte, never its line number: a window that does not
    // start at byte 0 numbers no lines, and every patch in it would share a key.
    if (isRecord(single)) applySinglePatch(kept, single, `${position}.${index}`, position, timestampMs);
  }
  if (Array.isArray(patch.removeIds)) {
    for (const removeId of patch.removeIds) {
      if (typeof removeId === 'string') kept.delete(removeId);
    }
  }
  if (Array.isArray(patch.orderIds)) {
    for (const orderId of patch.orderIds) {
      if (typeof orderId !== 'string') continue;
      const item = kept.get(orderId);
      if (!item) continue;
      kept.delete(orderId);
      kept.set(orderId, item);
    }
  }
}

function applySinglePatch(
  kept: Map<string, KeptItem>,
  patch: Record<string, unknown>,
  patchKey: string,
  position: number,
  timestampMs: number | null,
): void {
  if (typeof patch.id !== 'string' || patch.id.length === 0) return;
  const toolCallPatches = Array.isArray(patch.toolCalls) ? patch.toolCalls.filter(isRecord) : [];
  const target = kept.get(patch.id);
  if (target?.kind === 'message') {
    if ('content' in patch) target.message.content = patch.content;
    const calls = Array.isArray(target.message.toolCalls) ? target.message.toolCalls : [];
    for (const callPatch of toolCallPatches) {
      if (!('result' in callPatch)) continue;
      const call = calls.find((candidate) => isRecord(candidate) && candidate.id === callPatch.id);
      if (isRecord(call)) call.result = callPatch.result;
    }
    return;
  }
  // The message is in an earlier window: its results show here, at the patch.
  const withResults = toolCallPatches.filter((callPatch) => 'result' in callPatch && typeof callPatch.id === 'string');
  if (withResults.length === 0) return;
  kept.set(`$patch:${patchKey}`, { kind: 'patched-results', messageUuid: patch.id, toolCalls: withResults, position, ts: timestampMs });
}

/**
 * Keep a message under its uuid. The last emission wins, and the message keeps
 * its first-seen place, since a `set` on a present key does not move it.
 *
 * The map KEY is the entry uuid. Deriving both from one value is the point:
 * the key used to fall back to `gemini-${messagesById.size}` while the uuid
 * fell back to `''`, so an id-less message was keyed distinctly but then
 * emitted with a uuid shared by every other id-less message - and
 * `resolveTaskTranscript` dedups by uuid keeping the first, so all but one
 * vanished from the stitched Conversation tab. The fallback is now the
 * session-scoped absolute line index used by the Codex and Kimi parsers.
 *
 * Returns true when the uuid came from the line number, which a window read
 * needs to know: only then must it count the lines before its window.
 */
function keepMessage(
  kept: Map<string, KeptItem>,
  agentSessionId: string,
  message: unknown,
  lineNumber: number,
  indexWithinLine: number | null,
  position: number | null,
): boolean {
  if (!isRecord(message)) return false;
  const type = message.type;
  if (type !== 'user' && type !== 'gemini') return false;
  let messageId = typeof message.id === 'string' && message.id.length > 0 ? message.id : null;
  const namedByLine = messageId === null;
  if (messageId === null) {
    // A `$set` line seeds SEVERAL messages, so the line alone is not unique.
    messageId = indexWithinLine === null
      ? `${agentSessionId}:${lineNumber}`
      : `${agentSessionId}:${lineNumber}.${indexWithinLine}`;
  }
  kept.set(messageId, { kind: 'message', message, position });
  return namedByLine;
}

/** Map the kept items to entries, each stamped with its kept emission's line. */
function entriesFromMessages(agentSessionId: string, kept: Map<string, KeptItem>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // A message's key IS its uuid (see `keepMessage`).
  for (const [key, item] of kept) {
    const firstNew = entries.length;
    if (item.kind === 'message') {
      appendMessageEntries(key, item.message, entries);
    } else {
      // Keyed as the message's own results are (`transcriptEntryKey`: uuid and
      // call id), so a copy the message also carries dedupes to one, and the
      // assistant entry (keyed by uuid alone) is never shadowed. The viewer's
      // page merge and the task stitch both key this way.
      const ts = item.ts ?? Date.now();
      for (const call of item.toolCalls) {
        entries.push({
          kind: 'tool_result',
          uuid: item.messageUuid,
          ts,
          toolUseId: typeof call.id === 'string' ? call.id : '',
          content: extractToolCallOutput(call),
        });
      }
    }
    if (item.position !== null) stampOrigin(entries, firstNew, agentSessionId, item.position);
  }
  return entries;
}

/** Statuses after which a call's result is final (Gemini's `CoreToolCallStatus`). */
const FINISHED_TOOL_STATUSES = new Set(['success', 'error', 'cancelled']);

/**
 * Whether a call has a result to show yet. Gemini records the call before it
 * runs and patches the result in later, so a call with no `result`, no
 * `resultDisplay` and no finished status is still pending: no result entry,
 * rather than an empty one.
 */
function hasToolResult(call: Record<string, unknown>): boolean {
  if (call.result !== undefined && call.result !== null) return true;
  if (call.resultDisplay !== undefined && call.resultDisplay !== null) return true;
  return typeof call.status === 'string' && FINISHED_TOOL_STATUSES.has(call.status);
}

/**
 * Per-turn usage for the turn-usage ledger, from a message's `tokens`
 * (chatRecordingTypes.ts v0.66.0: `input` is promptTokenCount, `cached` is
 * cachedContentTokenCount, `thoughts` is thoughtsTokenCount). The Gemini API
 * counts the cached part inside promptTokenCount, so fresh input is `input`
 * less `cached`. Thinking tokens are billed as output, so they join `output`.
 * Gemini reports no cache write.
 */
export function turnUsageFromTokens(tokens: unknown): TranscriptTurnUsage | undefined {
  if (!isRecord(tokens)) return undefined;
  const input = toCount(tokens.input);
  const cached = Math.min(toCount(tokens.cached), input);
  return {
    inputTokens: input - cached,
    outputTokens: toCount(tokens.output) + toCount(tokens.thoughts),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  };
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Append the entries one kept message yields. */
function appendMessageEntries(uuid: string, message: Record<string, unknown>, entries: TranscriptEntry[]): void {
  const ts = parseTimestamp(message.timestamp);

  if (message.type === 'user') {
    const text = joinContentText(message.content);
    if (text.length === 0) return;
    // Skip the CLI's injected opening context turn.
    if (text.startsWith('<session_context>')) return;
    entries.push({ kind: 'user', uuid, ts, text });
    return;
  }

  // gemini (assistant)
  const model = typeof message.model === 'string' ? message.model : undefined;
  const blocks: TranscriptBlock[] = [];
  const toolResults: TranscriptEntry[] = [];

  if (Array.isArray(message.thoughts)) {
    for (const thought of message.thoughts) {
      if (!isRecord(thought)) continue;
      const subject = typeof thought.subject === 'string' ? thought.subject.trim() : '';
      const description = typeof thought.description === 'string' ? thought.description.trim() : '';
      const text = subject && description ? `${subject}: ${description}` : subject || description;
      if (text.length > 0) blocks.push({ type: 'thinking', text });
    }
  }

  const contentText = typeof message.content === 'string'
    ? message.content
    : joinContentText(message.content);
  if (contentText.trim().length > 0) blocks.push({ type: 'text', text: contentText });

  if (Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      if (!isRecord(call)) continue;
      const id = typeof call.id === 'string' ? call.id : '';
      const name = typeof call.name === 'string' ? call.name : 'tool';
      blocks.push({ type: 'tool_use', id, name, input: call.args });
      if (!hasToolResult(call)) continue;
      toolResults.push({
        kind: 'tool_result',
        uuid,
        ts,
        toolUseId: id,
        content: extractToolCallOutput(call),
        isError: call.status === 'error',
      });
    }
  }

  const usage = turnUsageFromTokens(message.tokens);
  if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, ...(usage ? { usage } : {}), blocks });
  for (const result of toolResults) entries.push(result);
}

/**
 * Locate the Gemini chat session file for a known session id. Matches both
 * the current `.jsonl` form and the legacy `.json` form (the filename embeds
 * the first 8 chars of the session UUID). Non-polling single readdir.
 * `place`: a Gemini in a WSL distro keeps it in the distro (`geminiChatsDir`).
 */
export function locateGeminiTranscriptFile(agentSessionId: string, cwd: string, place: CliPlace | null = null): string | null {
  const directory = geminiChatsDir(cwd, place);
  const pattern = geminiChatFilePattern(agentSessionId);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const match = names.find((name) => pattern.test(name));
  return match ? path.join(directory, match) : null;
}

/**
 * The path the CLI reported for this session, as this machine reads it, when
 * it is absolute and named for this session. A path that names another id says
 * nothing about this one.
 */
export function reportedGeminiChatFile(agentSessionId: string, reportedPath: string | null | undefined, place: CliPlace | null): string | null {
  if (!reportedPath) return null;
  const onHost = hostPathForTarget(reportedPath, place);
  return path.isAbsolute(onHost) && geminiChatFilePattern(agentSessionId).test(path.basename(onHost)) ? onHost : null;
}

/**
 * The file a transcript read opens. The CLI's own report wins while the file is
 * there: the folder under `tmp` is the CLI's choice, and the cwd only predicts
 * it. Else the file `locateGeminiTranscriptFile` finds.
 */
export function resolveGeminiTranscriptFile(
  agentSessionId: string,
  cwd: string,
  place: CliPlace | null,
  reportedPath?: string | null,
): string | null {
  const reported = reportedGeminiChatFile(agentSessionId, reportedPath, place);
  if (reported && fs.existsSync(reported)) return reported;
  return locateGeminiTranscriptFile(agentSessionId, cwd, place);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Join the `text` fields of a Gemini `content[]` array (or pass a string through). */
function joinContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * Pull readable output text out of a Gemini toolCall's embedded result. The
 * shape is `result[].functionResponse.response.output`; fall back to
 * `resultDisplay`, then to a JSON dump.
 */
function extractToolCallOutput(call: Record<string, unknown>): string {
  if (Array.isArray(call.result)) {
    const parts: string[] = [];
    for (const item of call.result) {
      if (!isRecord(item)) continue;
      const functionResponse = item.functionResponse;
      if (isRecord(functionResponse) && isRecord(functionResponse.response)) {
        const output = functionResponse.response.output;
        if (typeof output === 'string') parts.push(output);
        else if (output !== undefined) parts.push(safeJson(output));
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof call.resultDisplay === 'string') return call.resultDisplay;
  if (call.resultDisplay !== undefined) return safeJson(call.resultDisplay);
  return '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
