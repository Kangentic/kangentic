import { promises as fs } from 'node:fs';
import type { AgentAdapter } from './agent-adapter';
import type { AssistantMessageTrailEntry, TranscriptEntry } from '../../shared/types';
import { assistantMessagePreviews } from './shared/message-preview';
import { getCachedTranscript } from './transcript-cache';
import { finalAgentReply, type AgentReply } from './shared/agent-reply';
import {
  MESSAGE_TRAIL_ENTRY_MAX_CHARS,
  MESSAGE_TRAIL_MAX_ENTRIES,
  MESSAGE_TRAIL_MAX_WINDOWS_PER_READ,
  MESSAGE_TRAIL_TAIL_BYTES,
  MESSAGE_TRAIL_WINDOW_BYTES,
  type MessageTrailSessionFacts,
  type TrailRead,
} from './message-trail-tracker';

/**
 * One read of a session's message trail: the transcript parsing behind
 * `MessageTrailTracker`, which runs in the retrieval worker
 * (`transcript.trailRead`) so main parses no transcript. Returns the newest
 * assistant previews among the entries read (a few short lines, not the
 * entries), where the next read starts, and whether the adapter needed the
 * whole-tail fallback.
 *
 * Read: the adapter's stateless bounded window (`parseTranscriptWindow`) over
 * only the bytes appended since `cursor`. The first read starts
 * `MESSAGE_TRAIL_TAIL_BYTES` from the end, so a resumed session shows what its
 * previous run said at once. An adapter without the window capability falls
 * back to the stat-validated cached parse of its bounded tail.
 */

/** The three optional adapter capabilities a trail read goes through. */
export type MessageTrailAdapter = Pick<
  AgentAdapter,
  'parseTranscript' | 'parseTranscriptWindow' | 'locateSessionHistoryFile'
>;

async function statSize(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).size;
}

export async function readTrail(
  adapter: MessageTrailAdapter,
  facts: MessageTrailSessionFacts & { agentSessionId: string },
  cursor: number | null,
  fileSize: (filePath: string) => Promise<number> = statSize,
): Promise<TrailRead> {
  const parseWindow = adapter.parseTranscriptWindow;
  const locateFile = adapter.locateSessionHistoryFile;
  if (parseWindow && locateFile) {
    const read = await readWindows(adapter, parseWindow, locateFile, facts.cwd, facts.agentSessionId, cursor, fileSize, {
      tailBytes: MESSAGE_TRAIL_TAIL_BYTES,
      maxWindows: MESSAGE_TRAIL_MAX_WINDOWS_PER_READ,
    });
    return { previews: previewsOf(read.entries), cursor: read.cursor, usedFallback: false };
  }
  const parseTranscript = adapter.parseTranscript;
  if (parseTranscript) {
    const cached = await getCachedTranscript(
      facts.sessionType,
      facts.agentSessionId,
      () => parseTranscript.call(adapter, facts.agentSessionId, facts.cwd),
    );
    return { previews: previewsOf(cached.entries), cursor, usedFallback: true };
  }
  return { previews: [], cursor, usedFallback: false };
}

/** A reader over `resolveAdapter`, for a tracker running its reads in-process (tests). */
export function localTrailReader(
  resolveAdapter: (sessionType: string) => MessageTrailAdapter | undefined,
  fileSize?: (filePath: string) => Promise<number>,
): (facts: MessageTrailSessionFacts & { agentSessionId: string }, cursor: number | null) => Promise<TrailRead> {
  return async (facts, cursor) => {
    const adapter = resolveAdapter(facts.sessionType);
    if (!adapter) return { previews: [], cursor, usedFallback: false };
    return readTrail(adapter, facts, cursor, fileSize);
  };
}

/**
 * How much of a transcript's end a final-reply read parses. A review's verdict
 * runs about 11k characters, but the tool results before it can be large, and
 * the read has to reach back to the turn's own prompt to know where the turn
 * began. One megabyte reaches it in the cases measured; past it the reply is
 * still found, since it is the newest thing in the file.
 */
const FINAL_REPLY_TAIL_BYTES = 1024 * 1024;
const FINAL_REPLY_MAX_WINDOWS = 8;

/**
 * The session's final reply (`finalAgentReply`) from a bounded tail of its
 * transcript, for `{{agentReply}}`. Runs in the retrieval worker
 * (`transcript.finalReply`). Null for an agent with no transcript reader.
 */
export async function readFinalReply(
  adapter: MessageTrailAdapter,
  facts: MessageTrailSessionFacts & { agentSessionId: string },
  fileSize: (filePath: string) => Promise<number> = statSize,
): Promise<AgentReply | null> {
  const parseWindow = adapter.parseTranscriptWindow;
  const locateFile = adapter.locateSessionHistoryFile;
  if (parseWindow && locateFile) {
    const read = await readWindows(adapter, parseWindow, locateFile, facts.cwd, facts.agentSessionId, null, fileSize, {
      tailBytes: FINAL_REPLY_TAIL_BYTES,
      maxWindows: FINAL_REPLY_MAX_WINDOWS,
    });
    return finalAgentReply(read.entries);
  }
  const parseTranscript = adapter.parseTranscript;
  if (parseTranscript) {
    const cached = await getCachedTranscript(
      facts.sessionType,
      facts.agentSessionId,
      () => parseTranscript.call(adapter, facts.agentSessionId, facts.cwd),
    );
    return finalAgentReply(cached.entries);
  }
  return null;
}

function previewsOf(entries: TranscriptEntry[]): AssistantMessageTrailEntry[] {
  if (entries.length === 0) return [];
  return assistantMessagePreviews(entries, { count: MESSAGE_TRAIL_MAX_ENTRIES, maxChars: MESSAGE_TRAIL_ENTRY_MAX_CHARS });
}

async function readWindows(
  adapter: MessageTrailAdapter,
  parseWindow: NonNullable<MessageTrailAdapter['parseTranscriptWindow']>,
  locateFile: NonNullable<MessageTrailAdapter['locateSessionHistoryFile']>,
  cwd: string,
  agentSessionId: string,
  startCursor: number | null,
  fileSize: (filePath: string) => Promise<number>,
  bounds: { tailBytes: number; maxWindows: number },
): Promise<{ entries: TranscriptEntry[]; cursor: number | null }> {
  let cursor: number;
  if (startCursor === null) {
    const filePath = await locateFile.call(adapter, agentSessionId, cwd);
    if (!filePath) return { entries: [], cursor: null };
    const size = await fileSize(filePath);
    cursor = Math.max(0, size - bounds.tailBytes);
  } else {
    cursor = startCursor;
  }
  const collected: TranscriptEntry[] = [];
  for (let windowIndex = 0; windowIndex < bounds.maxWindows; windowIndex += 1) {
    const window = await parseWindow.call(adapter, agentSessionId, cwd, cursor, MESSAGE_TRAIL_WINDOW_BYTES);
    if (window.totalBytes < cursor) {
      // The file shrank under the cursor (a rotate, or a reused id): re-anchor at the new tail.
      cursor = Math.max(0, window.totalBytes - bounds.tailBytes);
      continue;
    }
    collected.push(...window.entries);
    if (window.nextByteOffset >= window.totalBytes) {
      // `readJsonlWindow` hands back an offset ON the closing newline for a
      // mid-file window but PAST the end for the final one, and every
      // mid-file start drops through its first newline. Stepping back one
      // byte makes the next read's drop consume exactly the newline the
      // last record ended with, instead of the whole first appended record.
      cursor = Math.max(0, window.nextByteOffset - 1);
      break;
    }
    if (window.nextByteOffset <= cursor) break;
    cursor = window.nextByteOffset;
  }
  return { entries: collected, cursor };
}
