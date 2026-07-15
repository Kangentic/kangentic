/**
 * The chunked/delta transcript streaming engine behind the mobile bridge's
 * read-stream handler (protocol v2). The transcript service below this
 * offers no incremental information - just a whole-transcript revision and
 * the full stitched entry array - so this module owns the diff: it
 * remembers exactly what it last sent to one subscription and emits only
 * the entries that changed, as absolute-indexed upserts split into
 * byte-budgeted chunks. That is what lets a live turn stream to the phone
 * entry-by-entry with small frames instead of re-sending a whole (possibly
 * multi-megabyte) conversation on every revision - the old wholesale push
 * silently overflowed the 1 MiB frame cap on long sessions and the phone
 * never saw a transcript at all.
 *
 * Diff model (matches the transcript service's semantics):
 * - Entries are keyed by uuid and append-mostly; the trailing assistant
 *   entry accretes blocks while a turn streams, so "changed at same index"
 *   is the streaming-tail case and "new index past the end" is the append
 *   case. Both become upserts.
 * - A uuid mismatch at a shared index, a shrink, or a degraded/index
 *   transcript source (whose synthesized uuids are unstable) means the
 *   phone's window cannot be patched - emit a 'reset' and let the phone
 *   re-request a window.
 * - Serialization cost is bounded by a per-uuid cache keyed on the source
 *   entry's object identity: the transcript cache returns unchanged
 *   session files as the same entry references, so only entries from a
 *   re-parsed (i.e. actually changed) file are re-mapped and re-stringified.
 */
import type { TranscriptEntryWire, TranscriptEventPayload, TranscriptUpsertWire } from '@kangentic/protocol';
import type { TranscriptEntry } from '../../../shared/types';
import type { ResolvedTaskTranscript } from '../../agent/transcript-service';
import { toTranscriptEntryWire } from './wire-mappers';

/**
 * Upserts per delta event are packed up to this serialized-JSON budget.
 * Well under the protocol's 1 MiB frame cap (and frames over 4 KiB are
 * deflated on top), so a chunk can never hit the encode ceiling while
 * still being large enough that a full window re-sync takes few frames.
 */
export const DELTA_CHUNK_BUDGET_CHARS = 192 * 1024;
/** Windowed-history responses default to this many entries when the phone does not say. */
export const WINDOW_DEFAULT_LIMIT = 60;
/** Hard cap on entries per windowed-history response, before the byte budget. */
export const WINDOW_MAX_LIMIT = 200;

interface SentEntry {
  /** Identity of the desktop-side entry this was mapped from - reference equality means "unchanged, skip re-serialization". */
  sourceRef: TranscriptEntry;
  uuid: string;
  wire: TranscriptEntryWire;
  serialized: string;
}

function mapEntry(entry: TranscriptEntry): SentEntry {
  const wire = toTranscriptEntryWire(entry);
  return { sourceRef: entry, uuid: entry.uuid, wire, serialized: JSON.stringify(wire) };
}

/** Packs upserts into delta payloads, splitting on the chunk byte budget so every frame stays small. */
function chunkUpserts(upserts: Array<TranscriptUpsertWire & { serializedLength: number }>, revision: number, totalEntries: number): TranscriptEventPayload[] {
  const payloads: TranscriptEventPayload[] = [];
  let current: TranscriptUpsertWire[] = [];
  let currentChars = 0;
  for (const upsert of upserts) {
    if (current.length > 0 && currentChars + upsert.serializedLength > DELTA_CHUNK_BUDGET_CHARS) {
      payloads.push({ mode: 'delta', revision, totalEntries, upserts: current });
      current = [];
      currentChars = 0;
    }
    current.push({ index: upsert.index, entry: upsert.entry });
    currentChars += upsert.serializedLength;
  }
  if (current.length > 0) payloads.push({ mode: 'delta', revision, totalEntries, upserts: current });
  return payloads;
}

export class TranscriptSync {
  private lastRevision = -1;
  private sent: SentEntry[] = [];

  /**
   * Marks the current transcript as already-known without emitting
   * anything - called at subscribe time. The phone bootstraps its view via
   * a transcript-window request; deltas cover only what changes after.
   * No-ops if a diff already ran (a session event can race the async
   * subscribe-time seed) - regressing lastRevision would re-send deltas.
   */
  seed(resolved: ResolvedTaskTranscript): void {
    if (this.lastRevision !== -1) return;
    this.lastRevision = resolved.revision;
    this.sent = resolved.entries.map(mapEntry);
  }

  /**
   * Diffs a freshly resolved transcript against what this subscription has
   * already been sent. Returns zero payloads (no content change), one or
   * more 'delta' chunks, or a single 'reset'.
   */
  diff(resolved: ResolvedTaskTranscript): TranscriptEventPayload[] {
    if (resolved.revision === this.lastRevision) return [];
    this.lastRevision = resolved.revision;

    const entries = resolved.entries;
    const unstableSource = resolved.degraded || resolved.source !== 'live';
    const previous = this.sent;

    // Structural breaks the phone cannot patch over: unstable uuids, a
    // shrink, or any uuid moving to a different index.
    let structuralBreak = unstableSource || entries.length < previous.length;
    if (!structuralBreak) {
      for (let index = 0; index < previous.length; index += 1) {
        if (previous[index].uuid !== entries[index].uuid) {
          structuralBreak = true;
          break;
        }
      }
    }
    if (structuralBreak) {
      this.sent = entries.map(mapEntry);
      return [{ mode: 'reset', revision: resolved.revision, totalEntries: entries.length }];
    }

    const nextSent: SentEntry[] = new Array(entries.length);
    const upserts: Array<TranscriptUpsertWire & { serializedLength: number }> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const source = entries[index];
      const previousSent = index < previous.length ? previous[index] : null;
      if (previousSent && previousSent.sourceRef === source) {
        nextSent[index] = previousSent;
        continue;
      }
      const mapped = mapEntry(source);
      nextSent[index] = mapped;
      if (previousSent && previousSent.serialized === mapped.serialized) continue;
      upserts.push({ index, entry: mapped.wire, serializedLength: mapped.serialized.length });
    }
    this.sent = nextSent;
    if (upserts.length === 0) return [];
    return chunkUpserts(upserts, resolved.revision, entries.length);
  }
}

export interface TranscriptWindowSlice {
  revision: number;
  totalEntries: number;
  startIndex: number;
  entries: TranscriptEntryWire[];
}

/**
 * The newest `limit` entries strictly before `beforeIndex` (or the tail
 * when omitted), additionally bounded by the chunk byte budget so one
 * response frame never balloons - the phone pages again from the returned
 * `startIndex` when it wants more history.
 */
export function sliceTranscriptWindow(resolved: ResolvedTaskTranscript, beforeIndex: number | undefined, limit: number | undefined): TranscriptWindowSlice {
  const total = resolved.entries.length;
  const end = Math.min(beforeIndex ?? total, total);
  const wantedCount = Math.min(limit ?? WINDOW_DEFAULT_LIMIT, WINDOW_MAX_LIMIT);

  const collected: TranscriptEntryWire[] = [];
  let budgetChars = 0;
  let start = end;
  while (start > 0 && collected.length < wantedCount) {
    const wire = toTranscriptEntryWire(resolved.entries[start - 1]);
    const serializedLength = JSON.stringify(wire).length;
    // Always include at least one entry so a single oversized entry cannot wedge paging.
    if (collected.length > 0 && budgetChars + serializedLength > DELTA_CHUNK_BUDGET_CHARS) break;
    collected.unshift(wire);
    budgetChars += serializedLength;
    start -= 1;
  }

  return { revision: resolved.revision, totalEntries: total, startIndex: start, entries: collected };
}
