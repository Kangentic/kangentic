/**
 * The structured transcript archive: each session's parsed conversation, kept
 * in the project database so it stays readable after the agent CLI deletes its
 * own file (Claude Code removes transcripts older than its `cleanupPeriodDays`).
 *
 * Before this, a deleted transcript left only the index's chunks, which keep
 * the text and lose the structure: tool calls read as JSON prose and turns run
 * together. The archive keeps the `TranscriptEntry[]` the viewer renders, so a
 * read from it looks like a live read.
 *
 * Worker only (`.claude/rules/retrieval-out-of-process.md`). Written whatever
 * the Knowledge Graph indexing switch says: no model, no network, and the
 * parse is the adapter's own windowed walk. Measured over one project's 629
 * conversations: 4.6 GB of JSONL parses to 470 MB of entries, 86 MB once
 * Brotli quality 9 compresses it.
 *
 * Layout. The walk tiles the source file in `windowBytes` windows, as the
 * indexer's does, and each window with entries becomes one row keyed by the
 * window's first byte. Only the newest row is open: the next walk resumes at
 * its start and rewrites it, so a turn end re-parses one window and appends,
 * and a half-written last line (which the parse skips) is read whole next time.
 * The rows before it never change. A row's payload is split into pieces so
 * each write fits the worker's per-transaction budget.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';
import type Database from 'better-sqlite3';
import { writeTransaction } from '../../db/transaction';
import { awaitWriteTurn } from '../write-budget';
import { touchBounded } from '../../agent/shared/bounded-lru';
import type { AgentAdapter } from '../../agent/agent-adapter';
import { mayReadPlaceUnattended, placeOfRecord, type CliPlace } from '../../agent/shared/cli-target';
import type { TranscriptEntry } from '../../../shared/types';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

/** Brotli quality 9: 5.3x on the measured payload at 29 MB/s, against gzip's 3.9x. */
const BROTLI_QUALITY = 9;
/** A piece of a row's payload, under the worker's 64 KB per-transaction write budget. */
const PIECE_BYTES = 48 * 1024;
/** Rows a purge deletes per transaction, as the indexer's deletes are capped. */
const DELETES_PER_TRANSACTION = 64;
/** Bytes before the resume offset hashed to tell an appended file from a rewritten one. */
const CHECK_BYTES = 4096;
/** Bounds a walk against a pathological file or an adapter that fails to advance. */
const MAX_WINDOWS = 4096;

/** What the archive needs of an adapter: where the file is, and the windowed parse. */
export type ArchiveAdapter = Pick<AgentAdapter, 'locateSessionHistoryFile' | 'parseTranscriptWindow'>;

export interface TranscriptArchiveDeps {
  getDb(projectId: string): Database.Database;
  getAdapter(sessionType: string): ArchiveAdapter | undefined;
  /** The walk's window. The indexer's 8 MiB, so a line the index reads the archive reads too. */
  windowBytes: number;
  /** Whether a conversation's file may be read now without starting its WSL distro (`mayReadPlaceUnattended`). */
  mayReadPlace?: (place: CliPlace | null) => Promise<boolean>;
}

export type ArchiveOutcome = 'archived' | 'unchanged' | 'missing-source' | 'unsupported' | 'skipped' | 'error';

/** One conversation to archive: its id, and the newest session row that ran it. */
interface ArchiveTarget {
  agentSessionId: string;
  sessionId: string;
  sessionType: string;
  cwd: string;
  /** Where the conversation's CLI ran when it was not this machine (a WSL distro): its file is there. */
  place: CliPlace | null;
  /**
   * The transcript path the agent reported (the row's `transcript_path`). An
   * agent can keep writing a resumed conversation outside the folder the cwd
   * maps to, and a path from the cwd alone would miss it and the archive would
   * stop updating.
   */
  reportedPath: string | null;
}

interface ArchiveStateRow {
  agent_session_id: string;
  source_path: string | null;
  resume_offset: number;
  check_hash: string | null;
  carry: string | null;
  source_size: number | null;
  source_mtime_ms: number | null;
  revision: number;
}

/**
 * Whether this database has the archive tables. The worker opens with
 * migrations off, so a project main has not opened since the upgrade has none
 * yet, and writing there would throw on every turn.
 */
export function hasArchiveTables(db: Database.Database): boolean {
  return (db.prepare(
    `SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name IN ('transcript_archive_state', 'transcript_archive_rows')`,
  ).get() as { found: number }).found === 2;
}

export class TranscriptArchive {
  private readonly mayReadPlace: (place: CliPlace | null) => Promise<boolean>;

  constructor(private readonly deps: TranscriptArchiveDeps) {
    this.mayReadPlace = deps.mayReadPlace ?? mayReadPlaceUnattended;
  }

  /**
   * Archive the conversation one session ran, by the session's id. A turn end,
   * a suspend or an exit asks for it. Only a session with a record is
   * archived: a workflow's own agent and a Command Terminal have none, and the
   * purge, which keys on session records, would delete their archive again.
   */
  async archiveSession(projectId: string, sessionId: string): Promise<ArchiveOutcome> {
    const opened = this.openArchiveDb(projectId);
    if (opened === 'error') return 'error';
    if (!opened) return 'skipped';
    const db = opened;
    // A row whose status line never painted has no path; an older row of the
    // same conversation may, as the walk below folds it.
    const record = db.prepare(
      `SELECT id, agent_session_id, session_type, cwd, cli_target,
              COALESCE(transcript_path, (
                SELECT older.transcript_path FROM sessions older
                WHERE older.agent_session_id = sessions.agent_session_id AND older.transcript_path IS NOT NULL
                ORDER BY older.started_at DESC LIMIT 1
              )) AS transcript_path
       FROM sessions WHERE id = ? OR agent_session_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(sessionId, sessionId) as {
      id: string;
      agent_session_id: string | null;
      session_type: string;
      cwd: string;
      cli_target: string | null;
      transcript_path: string | null;
    } | undefined;
    if (!record?.agent_session_id) return 'skipped';
    try {
      return await this.archiveConversation(db, {
        agentSessionId: record.agent_session_id,
        sessionId: record.id,
        sessionType: record.session_type,
        cwd: record.cwd,
        place: placeOfRecord(record),
        reportedPath: record.transcript_path,
      });
    } catch (error) {
      console.warn(`[retrieval] archive of ${record.agent_session_id.slice(0, 8)} failed:`, error instanceof Error ? error.message : error);
      return 'error';
    }
  }

  /**
   * The project-open pass: purge the archives no session record names any
   * more, then archive every conversation whose file changed since its last
   * walk, OLDEST FIRST by the file's time. Claude deletes the oldest first, so
   * the first open after an upgrade saves the ones closest to deletion. No
   * per-open cap: the worker's write budget paces it, and `shouldContinue`
   * stops it between conversations (a project switch).
   */
  async sweep(projectId: string, shouldContinue: () => boolean): Promise<{ archived: number; purged: number }> {
    const result = { archived: 0, purged: 0 };
    const db = this.openArchiveDb(projectId);
    if (!db || db === 'error') return result;
    result.purged = await this.purgeOrphans(db, shouldContinue);

    const rows = db.prepare(
      'SELECT id, agent_session_id, session_type, cwd, cli_target, transcript_path FROM sessions WHERE agent_session_id IS NOT NULL ORDER BY started_at DESC',
    ).all() as Array<{
      id: string;
      agent_session_id: string;
      session_type: string;
      cwd: string;
      cli_target: string | null;
      transcript_path: string | null;
    }>;
    const newestPerConversation = new Map<string, ArchiveTarget>();
    for (const row of rows) {
      const newer = newestPerConversation.get(row.agent_session_id);
      if (newer) {
        // A row whose status line never painted has no path; an older row of
        // the same conversation may.
        newer.reportedPath ??= row.transcript_path;
        continue;
      }
      newestPerConversation.set(row.agent_session_id, {
        agentSessionId: row.agent_session_id,
        sessionId: row.id,
        sessionType: row.session_type,
        cwd: row.cwd,
        place: placeOfRecord(row),
        reportedPath: row.transcript_path,
      });
    }

    const behind: Array<{ target: ArchiveTarget; mtimeMs: number }> = [];
    const readState = db.prepare('SELECT source_path, source_size, source_mtime_ms FROM transcript_archive_state WHERE agent_session_id = ?');
    for (const target of newestPerConversation.values()) {
      if (!shouldContinue()) return result;
      const adapter = this.deps.getAdapter(target.sessionType);
      if (!adapter?.parseTranscriptWindow) continue;
      if (!(await this.mayReadPlace(target.place))) continue;
      const sourcePath = await adapter.locateSessionHistoryFile(target.agentSessionId, target.cwd, target.place, target.reportedPath).catch(() => null);
      if (!sourcePath) continue;
      const stat = await fs.promises.stat(sourcePath).catch(() => null);
      if (!stat) continue;
      const state = readState.get(target.agentSessionId) as Pick<ArchiveStateRow, 'source_path' | 'source_size' | 'source_mtime_ms'> | undefined;
      if (isUnchangedSince(state, sourcePath, stat)) continue;
      behind.push({ target, mtimeMs: stat.mtimeMs });
    }
    behind.sort((left, right) => left.mtimeMs - right.mtimeMs);

    for (const { target } of behind) {
      if (!shouldContinue()) return result;
      try {
        if (await this.archiveConversation(db, target) === 'archived') result.archived += 1;
      } catch (error) {
        console.warn(`[retrieval] archive of ${target.agentSessionId.slice(0, 8)} failed:`, error instanceof Error ? error.message : error);
      }
      // Yield between conversations so a long first sweep never holds the loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return result;
  }

  /**
   * Delete the archives of conversations no session record names: the task was
   * deleted, moved to another project, or reset in To Do. Keyed on the session
   * records, not on the index, so it runs with indexing off. Returns how many
   * conversations went.
   */
  async purgeOrphans(db: Database.Database, shouldContinue: () => boolean): Promise<number> {
    const orphans = db.prepare(`
      SELECT agent_session_id FROM transcript_archive_state
      WHERE agent_session_id NOT IN (SELECT agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL)
      UNION
      SELECT DISTINCT agent_session_id FROM transcript_archive_rows
      WHERE agent_session_id NOT IN (SELECT agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL)
    `).all() as Array<{ agent_session_id: string }>;
    let purged = 0;
    for (const { agent_session_id: agentSessionId } of orphans) {
      if (!shouldContinue()) return purged;
      await deleteRows(db, agentSessionId, 0);
      writeTransaction(db, () => {
        db.prepare('DELETE FROM transcript_archive_state WHERE agent_session_id = ?').run(agentSessionId);
      })();
      // A re-archived conversation starts again at revision 1, which a cached
      // read of the purged one would otherwise answer for.
      readCache.delete(readCacheKey(db, agentSessionId));
      purged += 1;
      await awaitWriteTurn(db);
    }
    return purged;
  }

  /**
   * Walk one conversation's file from where the last walk left it and write
   * what changed. A missing file changes nothing: that is exactly when the
   * archive is needed. A file whose bytes before the resume point changed (or
   * that got shorter) is walked from the start, and its old rows are replaced
   * only once the new walk has produced entries.
   */
  private async archiveConversation(db: Database.Database, target: ArchiveTarget): Promise<ArchiveOutcome> {
    const adapter = this.deps.getAdapter(target.sessionType);
    if (!adapter?.parseTranscriptWindow) return 'unsupported';
    // A stopped WSL distro would start if its file were read; a later walk
    // with the distro running archives it.
    if (!(await this.mayReadPlace(target.place))) return 'skipped';
    const sourcePath = await adapter.locateSessionHistoryFile(target.agentSessionId, target.cwd, target.place, target.reportedPath).catch(() => null);
    if (!sourcePath) return 'missing-source';
    const stat = await fs.promises.stat(sourcePath).catch(() => null);
    if (!stat) return 'missing-source';

    const state = db.prepare('SELECT * FROM transcript_archive_state WHERE agent_session_id = ?')
      .get(target.agentSessionId) as ArchiveStateRow | undefined;
    if (isUnchangedSince(state, sourcePath, stat)) return 'unchanged';

    let resumeOffset = 0;
    let carry: string[] = [];
    if (state && state.source_path === sourcePath && state.resume_offset > 0 && state.resume_offset <= stat.size
      && await hashBefore(sourcePath, state.resume_offset) === state.check_hash) {
      resumeOffset = state.resume_offset;
      carry = parseCarry(state.carry);
    }

    const attributedMessageIds = new Set<string>(carry);
    let offset = resumeOffset;
    let lastRowStart = resumeOffset;
    let lastRowCarry = carry;
    let replaced = false;
    try {
      for (let windowIndex = 0; windowIndex < MAX_WINDOWS; windowIndex += 1) {
        // Taken before the parse, which prunes and adds to the carry in place.
        const carryBefore = [...attributedMessageIds];
        const parsedWindow = await adapter.parseTranscriptWindow(
          target.agentSessionId, target.cwd, offset, this.deps.windowBytes, attributedMessageIds, target.place, target.reportedPath,
        );
        // The reader's own size notice is not conversation.
        const entries = parsedWindow.entries.filter((entry) => !(entry.kind === 'system' && entry.subtype === 'truncated'));
        if (entries.length > 0) {
          if (!replaced) {
            // Not one transaction with the writes: each stays under the write
            // budget's caps. A read in between finds the conversation without
            // its newest window, and the revision bump at the end of the walk
            // sends the next read back for it.
            await deleteRows(db, target.agentSessionId, resumeOffset);
            replaced = true;
          }
          await writeRow(db, target.agentSessionId, offset, parsedWindow.nextByteOffset, entries);
        }
        lastRowStart = offset;
        lastRowCarry = carryBefore;
        if (parsedWindow.nextByteOffset <= offset) break;
        offset = parsedWindow.nextByteOffset;
        if (offset >= parsedWindow.totalBytes) break;
      }

      // A whole-file walk that found nothing keeps what the archive holds, and
      // records the file as seen, or every turn end would walk it again.
      if (!replaced && resumeOffset === 0 && state) {
        writeTransaction(db, () => {
          db.prepare(
            'UPDATE transcript_archive_state SET source_path = ?, source_size = ?, source_mtime_ms = ?, updated_at = ? WHERE agent_session_id = ?',
          ).run(sourcePath, stat.size, stat.mtimeMs, new Date().toISOString(), target.agentSessionId);
        })();
        return 'unchanged';
      }
      // Inside the guard: the agent can delete the file between the walk and
      // this read, after the rows were already replaced.
      const checkHash = await hashBefore(sourcePath, lastRowStart);
      writeTransaction(db, () => {
        db.prepare(`
          INSERT INTO transcript_archive_state
            (agent_session_id, session_id, source_path, resume_offset, check_hash, carry, source_size, source_mtime_ms, revision, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(agent_session_id) DO UPDATE SET
            session_id = excluded.session_id,
            source_path = excluded.source_path,
            resume_offset = excluded.resume_offset,
            check_hash = excluded.check_hash,
            carry = excluded.carry,
            source_size = excluded.source_size,
            source_mtime_ms = excluded.source_mtime_ms,
            revision = transcript_archive_state.revision + 1,
            updated_at = excluded.updated_at
        `).run(
          target.agentSessionId, target.sessionId, sourcePath, lastRowStart, checkHash,
          JSON.stringify(lastRowCarry), stat.size, stat.mtimeMs, new Date().toISOString(),
        );
      })();
    } catch (error) {
      // The rows from the resume point on may be gone or half rewritten, while
      // the state still describes the last walk, which the next walk repeats.
      // Bump the revision so no read cached in between keeps serving them.
      if (replaced) {
        writeTransaction(db, () => {
          db.prepare('UPDATE transcript_archive_state SET revision = revision + 1 WHERE agent_session_id = ?').run(target.agentSessionId);
        })();
      }
      throw error;
    }
    return replaced ? 'archived' : 'unchanged';
  }

  /** The project's database when it has the archive tables; null when not yet, 'error' when it cannot be opened. */
  private openArchiveDb(projectId: string): Database.Database | null | 'error' {
    try {
      const db = this.deps.getDb(projectId);
      return hasArchiveTables(db) ? db : null;
    } catch {
      return 'error';
    }
  }
}

/** Whether the file is the one the last walk saw, by path, size and time. */
function isUnchangedSince(
  state: Pick<ArchiveStateRow, 'source_path' | 'source_size' | 'source_mtime_ms'> | undefined,
  sourcePath: string,
  stat: fs.Stats,
): boolean {
  return state !== undefined
    && state.source_path === sourcePath
    && state.source_size === stat.size
    && state.source_mtime_ms === stat.mtimeMs;
}

/** One conversation read from the archive. */
export interface ArchivedConversation {
  entries: TranscriptEntry[];
  /** Bumps on every write; a read at the same revision is the same entries. */
  revision: number;
  /** Source bytes before the first row read (left out by the read bound). */
  omittedBytes: number;
  /** Source bytes the archive covers. */
  totalBytes: number;
}

interface CachedRead {
  revision: number;
  maxSourceBytes: number;
  conversation: ArchivedConversation;
}

/**
 * Decompressed reads, by database and conversation, so the Conversation
 * window's poll (every 2.5 s) neither decompresses again nor hands the stitch a
 * new array to diff. Sized by the source bytes each read covers, as the
 * transcript cache is. Keyed by the database too: a task moved to another
 * project takes its conversation id with it, and both archives start at
 * revision 1.
 */
const readCache = new Map<string, CachedRead>();
const READ_CACHE_LIMIT = 16;
const READ_CACHE_BYTE_BUDGET = 128 * 1024 * 1024;

function readCacheKey(db: Database.Database, agentSessionId: string): string {
  return `${db.name}\u0000${agentSessionId}`;
}

/**
 * A conversation's archived entries: the newest rows until their source span
 * reaches `maxSourceBytes`, the same bound a live read of the file has. Null
 * when the archive does not hold it. A row whose pieces are incomplete or
 * fail to decompress is left out rather than failing the read.
 */
export async function readArchivedConversation(
  db: Database.Database,
  agentSessionId: string,
  maxSourceBytes: number,
): Promise<ArchivedConversation | null> {
  if (!hasArchiveTables(db)) return null;
  const state = db.prepare('SELECT revision FROM transcript_archive_state WHERE agent_session_id = ?')
    .get(agentSessionId) as { revision: number } | undefined;
  if (!state) return null;
  const cacheKey = readCacheKey(db, agentSessionId);
  const cached = readCache.get(cacheKey);
  if (cached && cached.revision === state.revision && cached.maxSourceBytes === maxSourceBytes) {
    touchBounded(readCache, cacheKey, cached, cacheOptions);
    return cached.conversation;
  }

  const rows = db.prepare(`
    SELECT row_start AS rowStart, MAX(source_end) AS sourceEnd, MAX(piece_count) AS pieceCount
    FROM transcript_archive_rows WHERE agent_session_id = ?
    GROUP BY row_start ORDER BY row_start DESC
  `).all(agentSessionId) as Array<{ rowStart: number; sourceEnd: number; pieceCount: number }>;
  if (rows.length === 0) return null;

  // Newest rows while they fit the bound, and always at least one. Keeping the
  // row that crossed it read about 24 MiB against a 16 MiB bound; the
  // Conversation viewer pages anything older (`readArchivedPage`).
  const kept: typeof rows = [];
  let span = 0;
  for (const row of rows) {
    const rowSpan = Math.max(0, row.sourceEnd - row.rowStart);
    if (kept.length > 0 && span + rowSpan > maxSourceBytes) break;
    kept.push(row);
    span += rowSpan;
  }
  kept.reverse();

  const readPieces = db.prepare(
    'SELECT payload FROM transcript_archive_rows WHERE agent_session_id = ? AND row_start = ? ORDER BY piece',
  );
  const entries: TranscriptEntry[] = [];
  for (const row of kept) {
    const pieces = readPieces.all(agentSessionId, row.rowStart) as Array<{ payload: Buffer }>;
    if (pieces.length !== row.pieceCount) continue;
    try {
      const json = await decompress(Buffer.concat(pieces.map((piece) => piece.payload)));
      const rowEntries = JSON.parse(json.toString('utf8')) as unknown;
      if (!Array.isArray(rowEntries)) throw new Error('the row holds no list of entries');
      // Readers dispatch on `kind`, so an element without one is left out.
      for (const entry of rowEntries) {
        if (isArchivedEntry(entry)) entries.push(entry);
      }
    } catch (error) {
      console.warn(`[retrieval] an archived row of ${agentSessionId.slice(0, 8)} could not be read:`, error instanceof Error ? error.message : error);
    }
  }
  const conversation: ArchivedConversation = {
    entries,
    revision: state.revision,
    omittedBytes: kept[0]?.rowStart ?? 0,
    totalBytes: rows[0].sourceEnd,
  };
  touchBounded(readCache, cacheKey, { revision: state.revision, maxSourceBytes, conversation }, cacheOptions);
  return conversation;
}

/**
 * The byte a row's first whole line starts at. A row's `row_start` is the
 * offset its walk asked for, which after the first row is the previous
 * window's `nextByteOffset`: it points AT the newline before the row's first
 * line, one byte before the line-start coordinate the live tail and history
 * pages use. This is the one place that converts between the two; a query
 * that compares `row_start` with a line-start cursor directly picks the row
 * that begins at the cursor and pages nowhere.
 */
export function archiveRowLineStart(rowStart: number): number {
  return rowStart === 0 ? 0 : rowStart + 1;
}

/** The line-start byte a row's lines end before: the next row's first line. */
function archiveRowLineEnd(sourceEnd: number, totalBytes: number): number {
  return sourceEnd >= totalBytes ? sourceEnd : sourceEnd + 1;
}

/** One page of an archived conversation, for a Conversation viewer whose file is gone. */
export interface ArchivedPage {
  entries: TranscriptEntry[];
  revision: number;
  startPosition: number;
  endPosition: number;
  totalPosition: number;
  reachedStart: boolean;
}

/**
 * One archived row as a history page: the row ending before `position`
 * (`before`), the row holding or after it (`after`), or the row holding it
 * (`around`). Uncached, unlike `readArchivedConversation`, whose cache holds one
 * read per conversation and would hand the tail's next poll a new array if a
 * page read replaced it. A row straddling the cursor is cut at it by each
 * entry's origin; a row archived before entries carried one is returned whole,
 * and the viewer's dedupe by uuid drops the overlap. Null when the archive does
 * not hold the conversation or the row cannot be read.
 */
export async function readArchivedPage(
  db: Database.Database,
  agentSessionId: string,
  direction: 'before' | 'after' | 'around',
  position: number,
): Promise<ArchivedPage | null> {
  if (!hasArchiveTables(db)) return null;
  const state = db.prepare('SELECT revision FROM transcript_archive_state WHERE agent_session_id = ?')
    .get(agentSessionId) as { revision: number } | undefined;
  if (!state) return null;
  const total = db.prepare('SELECT MAX(source_end) AS total FROM transcript_archive_rows WHERE agent_session_id = ?')
    .get(agentSessionId) as { total: number | null } | undefined;
  const totalPosition = total?.total ?? 0;
  if (totalPosition <= 0) return null;

  const select = 'SELECT row_start AS rowStart, MAX(source_end) AS sourceEnd, MAX(piece_count) AS pieceCount '
    + 'FROM transcript_archive_rows WHERE agent_session_id = ? GROUP BY row_start';
  let row: { rowStart: number; sourceEnd: number; pieceCount: number } | undefined;
  if (direction === 'before') {
    row = db.prepare(`${select} HAVING (CASE WHEN row_start = 0 THEN 0 ELSE row_start + 1 END) < ? ORDER BY row_start DESC LIMIT 1`)
      .get(agentSessionId, position) as typeof row;
  } else if (direction === 'after') {
    row = db.prepare(`${select} HAVING MAX(source_end) >= ? ORDER BY row_start ASC LIMIT 1`)
      .get(agentSessionId, position) as typeof row;
  } else {
    row = (db.prepare(`${select} HAVING row_start <= ? ORDER BY row_start DESC LIMIT 1`).get(agentSessionId, position)
      ?? db.prepare(`${select} ORDER BY row_start ASC LIMIT 1`).get(agentSessionId)) as typeof row;
  }
  if (!row) return null;

  const pieces = db.prepare(
    'SELECT payload FROM transcript_archive_rows WHERE agent_session_id = ? AND row_start = ? ORDER BY piece',
  ).all(agentSessionId, row.rowStart) as Array<{ payload: Buffer }>;
  if (pieces.length !== row.pieceCount) return null;
  let rowEntries: unknown;
  try {
    const json = await decompress(Buffer.concat(pieces.map((piece) => piece.payload)));
    rowEntries = JSON.parse(json.toString('utf8')) as unknown;
  } catch (error) {
    console.warn(`[retrieval] an archived row of ${agentSessionId.slice(0, 8)} could not be read:`, error instanceof Error ? error.message : error);
    return null;
  }
  if (!Array.isArray(rowEntries)) return null;

  let startPosition = archiveRowLineStart(row.rowStart);
  let endPosition = archiveRowLineEnd(row.sourceEnd, totalPosition);
  if (direction === 'before') endPosition = Math.min(endPosition, position);
  if (direction === 'after') startPosition = Math.max(startPosition, position);
  const entries: TranscriptEntry[] = [];
  for (const entry of rowEntries) {
    if (!isArchivedEntry(entry)) continue;
    const entryPosition = entry.origin?.position;
    if (entryPosition !== undefined && (entryPosition < startPosition || entryPosition >= endPosition)) continue;
    entries.push(entry);
  }
  return {
    entries,
    revision: state.revision,
    startPosition,
    endPosition,
    totalPosition,
    reachedStart: row.rowStart === 0,
  };
}

/** An archived element a reader can dispatch on: an object with a string `kind`. */
function isArchivedEntry(value: unknown): value is TranscriptEntry {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

const cacheOptions = {
  limit: READ_CACHE_LIMIT,
  byteBudget: READ_CACHE_BYTE_BUDGET,
  sizeOf: (read: CachedRead) => Math.max(0, read.conversation.totalBytes - read.conversation.omittedBytes),
  minRetained: 1,
};

/** Test-only: drop every cached read. */
export function resetArchiveReadCacheForTests(): void {
  readCache.clear();
}

async function writeRow(
  db: Database.Database,
  agentSessionId: string,
  rowStart: number,
  sourceEnd: number,
  entries: TranscriptEntry[],
): Promise<void> {
  const payload = await compress(Buffer.from(JSON.stringify(entries), 'utf8'), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
  });
  const pieceCount = Math.max(1, Math.ceil(payload.length / PIECE_BYTES));
  const insert = db.prepare(`
    INSERT OR REPLACE INTO transcript_archive_rows
      (agent_session_id, row_start, piece, piece_count, source_end, entry_count, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (let piece = 0; piece < pieceCount; piece += 1) {
    const slice = payload.subarray(piece * PIECE_BYTES, (piece + 1) * PIECE_BYTES);
    writeTransaction(db, () => {
      insert.run(agentSessionId, rowStart, piece, pieceCount, sourceEnd, entries.length, slice);
    })();
    await awaitWriteTurn(db);
  }
}

/** Delete a conversation's rows from `fromOffset` on, a capped batch per transaction. */
async function deleteRows(db: Database.Database, agentSessionId: string, fromOffset: number): Promise<void> {
  const deleteBatch = db.prepare(`
    DELETE FROM transcript_archive_rows WHERE rowid IN (
      SELECT rowid FROM transcript_archive_rows WHERE agent_session_id = ? AND row_start >= ? LIMIT ${DELETES_PER_TRANSACTION}
    )
  `);
  for (;;) {
    const deleted = writeTransaction(db, () => deleteBatch.run(agentSessionId, fromOffset).changes)();
    if (deleted < DELETES_PER_TRANSACTION) return;
    await awaitWriteTurn(db);
  }
}

/** sha1 of the bytes just before `offset`, which tells an appended file from a rewritten one. */
async function hashBefore(filePath: string, offset: number): Promise<string> {
  const length = Math.min(CHECK_BYTES, Math.max(0, offset));
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      await handle.read(buffer, 0, length, offset - length);
    } finally {
      await handle.close();
    }
  }
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function parseCarry(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}
