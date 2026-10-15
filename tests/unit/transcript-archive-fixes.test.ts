/**
 * Pins for fixes a review pass made to the structured transcript archive
 * (`src/main/retrieval/archive/transcript-archive.ts`). The main behavior tests
 * live in `transcript-archive.test.ts`; these hold the edges that file leaves
 * open, each with the real window parser, real Brotli and real better-sqlite3:
 *
 * 1. A whole-file walk that found no entries records the file as seen, so the
 *    next call does not walk it again, and the archived entries stay readable.
 * 2. A walk that throws after it began replacing rows bumps the revision, so a
 *    read cached before the failure is not served again.
 * 3. The read cache is keyed by database AND conversation, and a purge drops a
 *    purged conversation's entry, so a re-archive that starts again at
 *    revision 1 is not answered with the old content.
 * 4. A row that decodes to something other than a list is skipped, and an
 *    element without a string `kind` is left out of a list.
 *
 * Four more edges came out of a later review pass:
 *
 * 5. The read of the file after the walk, and the state write that follows it,
 *    sit inside the guard that bumps the revision, so a file the agent deletes
 *    right after the walk replaced rows cannot leave a stale cached read.
 * 6. A purge deletes a conversation's rows in capped batches and still removes
 *    every one, and only that conversation's.
 * 7. An adapter with no window parser is 'unsupported', and its file is never
 *    looked up.
 * 8. A row whose stored pieces do not match its piece count is left out of a
 *    read, and the rows around it are kept.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  TranscriptArchive,
  readArchivedConversation,
  resetArchiveReadCacheForTests,
  type ArchiveAdapter,
} from '../../src/main/retrieval/archive/transcript-archive';
import { parseClaudeTranscript, parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';
import type { TranscriptEntry } from '../../src/shared/types';

const WINDOW_BYTES = 2000;
const ALL = Number.MAX_SAFE_INTEGER;
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

beforeEach(() => resetArchiveReadCacheForTests());

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-archive-fixes-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Claude-format lines: a user line, then an assistant text line and a tool line under one message id. */
function transcriptLines(turns: number, variant = '', from = 0): string[] {
  const lines: string[] = [];
  for (let turn = from; turn < from + turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 12, 0, turn)).toISOString();
    lines.push(JSON.stringify({
      type: 'user', uuid: `user-${turn}`, timestamp,
      message: { role: 'user', content: `Question ${turn}${variant}: what does the archive keep?` },
    }));
    const usage = { input_tokens: 10 + turn, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
    const message = (content: unknown[]) => ({ id: `message-${turn}`, model: 'claude-test', content, usage });
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `assistant-${turn}-text`, timestamp,
      message: message([{ type: 'text', text: `Answer ${turn}: ${'the structure survives the deletion. '.repeat(1 + (turn * 3) % 4)}` }]),
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `assistant-${turn}-tool`, timestamp,
      message: message([{ type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { file_path: `src/file-${turn}.ts` } }]),
    }));
  }
  return lines;
}

/** Lines whose `type` is none the parser turns into an entry: a file that parses to nothing. */
function metadataOnlyLines(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => JSON.stringify({
    type: 'file-history-snapshot', messageId: `snapshot-${index}`, snapshot: { trackedFileBackups: {} },
  }));
}

function writeTranscript(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

/** Counts the adapter's window parses, and can make one of them throw. */
interface ParseCounter {
  calls: number;
  failOnCall: number | null;
  /** The agent deletes its file the moment the walk's last window has been parsed. */
  deleteAfterWalk: boolean;
}

interface Fixture {
  database: DatabaseType.Database;
  archive: TranscriptArchive;
  transcriptPath: string;
  counter: ParseCounter;
}

/** One project database with a single session, `session-1`, that ran conversation `agent-1`. */
function fixture(options: { fileBackedDatabase?: boolean } = {}): Fixture {
  const directory = temporaryDirectory();
  const database = openTestDatabase(options.fileBackedDatabase ? path.join(directory, 'project.db') : ':memory:');
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare(
    `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
     VALUES ('session-1', 'task-1', 'claude_agent', 'agent-1', 'claude', '/work', 'suspended', '2026-09-30T12:00:00.000Z')`,
  ).run();
  const transcriptPath = path.join(directory, 'agent-1.jsonl');
  const counter: ParseCounter = { calls: 0, failOnCall: null, deleteAfterWalk: false };
  const adapter: ArchiveAdapter = {
    locateSessionHistoryFile: async () => (fs.existsSync(transcriptPath) ? transcriptPath : null),
    parseTranscriptWindow: async (_agentSessionId, _cwd, startByte, maxBytes, carry) => {
      counter.calls += 1;
      if (counter.failOnCall === counter.calls) throw new Error('the adapter failed mid-walk');
      const window = await parseClaudeTranscriptWindow(transcriptPath, startByte, maxBytes, carry);
      // After the parse and before the walk returns, so the archive's own read
      // of the file once the walk is done is the first one to find it gone.
      if (counter.deleteAfterWalk && window.nextByteOffset >= window.totalBytes) {
        fs.rmSync(transcriptPath, { force: true });
      }
      return { ...window, sourcePath: transcriptPath };
    },
  };
  const archive = new TranscriptArchive({ getDb: () => database, getAdapter: () => adapter, windowBytes: WINDOW_BYTES });
  return { database, archive, transcriptPath, counter };
}

function stateOf(database: DatabaseType.Database, agentSessionId = 'agent-1') {
  return database.prepare('SELECT * FROM transcript_archive_state WHERE agent_session_id = ?').get(agentSessionId) as {
    source_path: string | null;
    source_size: number | null;
    source_mtime_ms: number | null;
    resume_offset: number;
    revision: number;
  };
}

async function archivedEntries(database: DatabaseType.Database): Promise<TranscriptEntry[]> {
  return (await readArchivedConversation(database, 'agent-1', ALL))?.entries ?? [];
}

describe('a whole-file walk that finds no entries', () => {
  // Red-green: the `UPDATE transcript_archive_state SET source_path ...` inside
  // the `!replaced && resumeOffset === 0 && state` block of `archiveConversation`.
  // Make that statement change no row (the block still returns 'unchanged') and
  // the second call walks the file again, so its parse count is not 0.
  it('records the file as seen, so the next call returns unchanged without walking it', async () => {
    const { database, archive, transcriptPath, counter } = fixture();
    writeTranscript(transcriptPath, transcriptLines(10));
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    const archivedBefore = await archivedEntries(database);
    expect(archivedBefore.length).toBeGreaterThan(0);
    const revisionBefore = stateOf(database).revision;
    const sizeBefore = fs.statSync(transcriptPath).size;

    // A different size, and nothing in it the parser keeps.
    writeTranscript(transcriptPath, metadataOnlyLines(3));
    const stat = fs.statSync(transcriptPath);
    expect(stat.size).not.toBe(sizeBefore);

    counter.calls = 0;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('unchanged');
    // The control: this first call did walk the file.
    expect(counter.calls).toBeGreaterThan(0);
    const state = stateOf(database);
    expect(state.source_path).toBe(transcriptPath);
    expect(state.source_size).toBe(stat.size);
    expect(state.source_mtime_ms).toBe(stat.mtimeMs);

    counter.calls = 0;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('unchanged');
    expect(counter.calls).toBe(0);

    // Nothing new was archived, and what was archived is still readable.
    expect(stateOf(database).revision).toBe(revisionBefore);
    expect(await archivedEntries(database)).toEqual(archivedBefore);
  });
});

describe('a walk that throws after it began replacing rows', () => {
  // Red-green: the `if (replaced) { ... revision = revision + 1 ... }` in the
  // catch of `archiveConversation`. Remove it and the revision stays 1, so the
  // read returns the object cached before the failure.
  it('bumps the revision, so the read cached before the failure is not served again', async () => {
    const { database, archive, transcriptPath, counter } = fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeTranscript(transcriptPath, transcriptLines(12));
    await archive.archiveSession('project-1', 'session-1');
    const cached = await readArchivedConversation(database, 'agent-1', ALL);
    expect(cached?.revision).toBe(1);

    // Different bytes from the start, so the walk begins at 0 and replaces the
    // rows; the adapter fails on the second window, after the first row landed.
    writeTranscript(transcriptPath, transcriptLines(12, 'X'));
    counter.calls = 0;
    counter.failOnCall = 2;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('error');
    expect(counter.calls).toBe(2);

    expect(stateOf(database).revision).toBe(2);
    const afterFailure = await readArchivedConversation(database, 'agent-1', ALL);
    expect(afterFailure).not.toBe(cached);
    expect(afterFailure?.revision).toBe(2);
    // The table holds the first window of the rewrite and nothing of the old file.
    expect(afterFailure?.entries.some((entry) => entry.kind === 'user' && entry.text.includes('Question 0X'))).toBe(true);
    expect(afterFailure?.entries.some((entry) => entry.kind === 'user' && !entry.text.includes('X:'))).toBe(false);
    expect(afterFailure!.entries.length).toBeLessThan(cached!.entries.length);
    // What the read answers is what the table holds, not a cached copy of it.
    resetArchiveReadCacheForTests();
    expect(await readArchivedConversation(database, 'agent-1', ALL)).toEqual(afterFailure);
  });

});

describe('a walk whose read of the file after the last window fails', () => {
  // Red-green: move the `hashBefore(sourcePath, lastRowStart)` read and the
  // state upsert that follows it out of the `try` in `archiveConversation`,
  // below its `catch`. The vanished file then throws past the revision bump:
  // the state stays at revision 1, `afterFailure` is the object cached before
  // the walk, and the first two revision and identity expectations fail.
  it('bumps the revision, so the read cached before the walk is not served after the file vanished', async () => {
    const { database, archive, transcriptPath, counter } = fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const firstLines = transcriptLines(10);
    writeTranscript(transcriptPath, firstLines);
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    const stateBefore = stateOf(database);
    // `hashBefore` opens the file only for a resume point past byte 0, so the
    // read this test makes fail exists only for an archive that has rows.
    expect(stateBefore.resume_offset).toBeGreaterThan(0);
    const cached = await readArchivedConversation(database, 'agent-1', ALL);
    expect(cached?.revision).toBe(stateBefore.revision);

    // The agent appends turns, so the walk resumes at the open row, replaces it
    // and the rows after, and then finds the file deleted.
    const appendedLines = [...firstLines, ...transcriptLines(6, '', 10)];
    writeTranscript(transcriptPath, appendedLines);
    const wholeFile = await parseClaudeTranscript(transcriptPath);
    expect(wholeFile.length).toBeGreaterThan(cached!.entries.length);
    counter.deleteAfterWalk = true;

    expect(await archive.archiveSession('project-1', 'session-1')).toBe('error');
    // The control: the file went away during the walk, so the read that failed
    // was the one after it.
    expect(fs.existsSync(transcriptPath)).toBe(false);

    const stateAfter = stateOf(database);
    expect(stateAfter.revision).toBe(stateBefore.revision + 1);
    // The state write never landed: it still describes the last good walk.
    expect(stateAfter.source_size).toBe(stateBefore.source_size);
    expect(stateAfter.resume_offset).toBe(stateBefore.resume_offset);

    const afterFailure = await readArchivedConversation(database, 'agent-1', ALL);
    expect(afterFailure).not.toBe(cached);
    expect(afterFailure?.revision).toBe(stateAfter.revision);
    // The walk finished before the file went, so the rows hold the appended turns.
    expect(afterFailure?.entries).toEqual(wholeFile);

    // The next walk, with the file back, repeats the failed one and ends clean.
    counter.deleteAfterWalk = false;
    writeTranscript(transcriptPath, appendedLines);
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    expect(stateOf(database).revision).toBe(stateAfter.revision + 1);
    expect(await archivedEntries(database)).toEqual(wholeFile);
  });
});

describe('the read cache', () => {
  // Red-green: the `readCache.delete(readCacheKey(db, agentSessionId))` in
  // `purgeOrphans`. Remove it and the re-archive, which starts again at
  // revision 1, is answered with the content cached before the purge.
  it('drops a purged conversation, so a re-archive at revision 1 reads its new content', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(4));
    await archive.archiveSession('project-1', 'session-1');
    const cachedBeforePurge = await readArchivedConversation(database, 'agent-1', ALL);
    expect(cachedBeforePurge?.revision).toBe(1);

    database.prepare("DELETE FROM sessions WHERE agent_session_id = 'agent-1'").run();
    expect((await archive.sweep('project-1', () => true)).purged).toBe(1);
    expect(await readArchivedConversation(database, 'agent-1', ALL)).toBeNull();

    // The same conversation id comes back on a new session, with different content.
    database.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES ('session-2', 'task-1', 'claude_agent', 'agent-1', 'claude', '/work', 'suspended', '2026-10-01T12:00:00.000Z')`,
    ).run();
    writeTranscript(transcriptPath, transcriptLines(6, 'Y'));
    expect(await archive.archiveSession('project-1', 'session-2')).toBe('archived');

    const reread = await readArchivedConversation(database, 'agent-1', ALL);
    expect(reread?.revision).toBe(1);
    expect(reread?.entries).toEqual(await parseClaudeTranscript(transcriptPath));
    expect(reread?.entries.some((entry) => entry.kind === 'user' && entry.text.includes('Question 0Y'))).toBe(true);
  });

  // Red-green: `readCacheKey`. Make it return only `agentSessionId` and the
  // second database's read is answered with the first one's cached entries.
  // The databases are files, as they are in the app: every in-memory database
  // is named ':memory:' and would share a key whatever the fix.
  it('keeps one agent session id apart across two project databases', async () => {
    const first = fixture({ fileBackedDatabase: true });
    const second = fixture({ fileBackedDatabase: true });
    expect(first.database.name).not.toBe(second.database.name);
    writeTranscript(first.transcriptPath, transcriptLines(3, 'A'));
    writeTranscript(second.transcriptPath, transcriptLines(5, 'B'));
    await first.archive.archiveSession('project-1', 'session-1');
    await second.archive.archiveSession('project-2', 'session-1');

    const fromFirst = await readArchivedConversation(first.database, 'agent-1', ALL);
    const fromSecond = await readArchivedConversation(second.database, 'agent-1', ALL);

    // Both archives are at revision 1, so only the key tells them apart.
    expect(fromFirst?.revision).toBe(1);
    expect(fromSecond?.revision).toBe(1);
    expect(fromFirst?.entries).toEqual(await parseClaudeTranscript(first.transcriptPath));
    expect(fromSecond?.entries).toEqual(await parseClaudeTranscript(second.transcriptPath));
    expect(fromFirst?.entries).not.toEqual(fromSecond?.entries);
    // And the first is still the first on a repeat read.
    expect(await readArchivedConversation(first.database, 'agent-1', ALL)).toBe(fromFirst);
  });
});

const NOW = '2026-10-01T12:00:00.000Z';

/** A database with the archive tables and no session record, for rows written directly. */
function rawDatabase(): DatabaseType.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  return database;
}

/** The state row a conversation has once the archive has walked it. */
function insertRawState(database: DatabaseType.Database, agentSessionId: string): void {
  database.prepare(
    `INSERT INTO transcript_archive_state (agent_session_id, session_id, resume_offset, revision, updated_at)
     VALUES (?, NULL, 0, 1, ?)`,
  ).run(agentSessionId, NOW);
}

/** The Brotli payload the archive stores for a row holding `decoded`. */
function compressedRow(decoded: unknown): Buffer {
  return brotliCompressSync(Buffer.from(JSON.stringify(decoded), 'utf8'));
}

/** Writes one piece of a row directly, as an older or damaged archive could hold it. */
function insertRawPiece(
  database: DatabaseType.Database,
  agentSessionId: string,
  rowStart: number,
  piece: number,
  declaredPieceCount: number,
  payload: Buffer,
): void {
  database.prepare(
    `INSERT INTO transcript_archive_rows (agent_session_id, row_start, piece, piece_count, source_end, entry_count, payload)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(agentSessionId, rowStart, piece, declaredPieceCount, rowStart + 100, payload);
}

/** Writes one single-piece row directly. */
function insertRawRow(database: DatabaseType.Database, rowStart: number, decoded: unknown, agentSessionId = 'agent-raw'): void {
  insertRawPiece(database, agentSessionId, rowStart, 0, 1, compressedRow(decoded));
}

function rowsOf(database: DatabaseType.Database, agentSessionId: string): number {
  return (database.prepare('SELECT COUNT(*) AS found FROM transcript_archive_rows WHERE agent_session_id = ?')
    .get(agentSessionId) as { found: number }).found;
}

function statesOf(database: DatabaseType.Database, agentSessionId: string): number {
  return (database.prepare('SELECT COUNT(*) AS found FROM transcript_archive_state WHERE agent_session_id = ?')
    .get(agentSessionId) as { found: number }).found;
}

describe('an archived row that is not a list of entries', () => {
  // Red-green: `isArchivedEntry` and the list check in `readArchivedConversation`.
  // Replace the loop with `entries.push(...(rowEntries as TranscriptEntry[]))`
  // and the element with no `kind`, the bare values, and the characters of the
  // string row all reach the reader.
  it('skips a row that decodes to a non-list, and leaves out elements without a string kind', async () => {
    const database = rawDatabase();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    insertRawState(database, 'agent-raw');
    const first = { kind: 'user', uuid: 'u1', ts: 1, text: 'valid first' };
    const second = { kind: 'user', uuid: 'u2', ts: 2, text: 'valid second' };
    insertRawRow(database, 0, { not: 'a list' });
    insertRawRow(database, 100, [first, { no: 'kind' }, { kind: 5 }, 42, null, 'text', [first]]);
    insertRawRow(database, 200, 'a plain string');
    insertRawRow(database, 300, [second]);

    const conversation = await readArchivedConversation(database, 'agent-raw', ALL);

    expect(conversation?.entries).toEqual([first, second]);
  });
});

describe('a purge of a conversation with more rows than one delete batch', () => {
  // Red-green: the batch loop in `deleteRows`. Make it return after its first
  // delete (`if (deleted < DELETES_PER_TRANSACTION) return;` becomes `return;`)
  // and 86 of the 150 rows, and 1 of the 65, are left behind.
  it('removes every row and the state of an orphan, and nothing of a conversation a session names', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(8));
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
    const namedRows = rowsOf(database, 'agent-1');
    const namedEntries = await archivedEntries(database);
    expect(namedRows).toBeGreaterThan(0);

    // No session names either of these. The first has a state row and 150 rows:
    // two full batches of 64 and a batch of 22. The second has rows and no
    // state, and one row more than a batch.
    insertRawState(database, 'agent-orphan');
    for (let index = 0; index < 150; index += 1) {
      insertRawRow(database, index * 100, [{ kind: 'user', uuid: `orphan-${index}`, ts: index, text: 'orphan' }], 'agent-orphan');
    }
    for (let index = 0; index < 65; index += 1) {
      insertRawRow(database, index * 100, [{ kind: 'user', uuid: `rows-only-${index}`, ts: index, text: 'orphan' }], 'agent-rows-only');
    }
    expect(rowsOf(database, 'agent-orphan')).toBe(150);
    expect(rowsOf(database, 'agent-rows-only')).toBe(65);

    expect(await archive.purgeOrphans(database, () => true)).toBe(2);

    expect(rowsOf(database, 'agent-orphan')).toBe(0);
    expect(statesOf(database, 'agent-orphan')).toBe(0);
    expect(rowsOf(database, 'agent-rows-only')).toBe(0);
    expect(rowsOf(database, 'agent-1')).toBe(namedRows);
    expect(statesOf(database, 'agent-1')).toBe(1);
    expect(await archivedEntries(database)).toEqual(namedEntries);
  });
});

describe('an adapter that cannot parse a window', () => {
  // Red-green: the `!adapter?.parseTranscriptWindow` check at the top of
  // `archiveConversation`. Remove it and the first call goes on to look up the
  // file and then calls a parser that is not there (the second dereferences a
  // missing adapter), so both calls answer 'error' instead.
  it("answers 'unsupported' for an adapter with no window parser, without looking up its file", async () => {
    const { database, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(3));
    const locateSessionHistoryFile = vi.fn(async () => transcriptPath);
    const archive = new TranscriptArchive({
      getDb: () => database, getAdapter: () => ({ locateSessionHistoryFile }), windowBytes: WINDOW_BYTES,
    });

    // The tables exist and the session names a conversation, so this is not the 'skipped' path.
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('unsupported');

    expect(locateSessionHistoryFile).not.toHaveBeenCalled();
    expect(rowsOf(database, 'agent-1')).toBe(0);
    expect(statesOf(database, 'agent-1')).toBe(0);
  });

  it("answers 'unsupported' when no adapter serves the session type", async () => {
    const { database, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(3));
    const archive = new TranscriptArchive({ getDb: () => database, getAdapter: () => undefined, windowBytes: WINDOW_BYTES });

    expect(await archive.archiveSession('project-1', 'session-1')).toBe('unsupported');

    expect(rowsOf(database, 'agent-1')).toBe(0);
    expect(statesOf(database, 'agent-1')).toBe(0);
  });
});

describe('an archived row whose stored pieces do not match its piece count', () => {
  const before = { kind: 'user', uuid: 'u-before', ts: 1, text: 'the row before' };
  const damaged = { kind: 'user', uuid: 'u-damaged', ts: 2, text: 'the row that lost a piece' };
  const after = { kind: 'user', uuid: 'u-after', ts: 3, text: 'the row after' };

  // Red-green: the `pieces.length !== row.pieceCount` guard in
  // `readArchivedConversation`. Turn its `continue` into a `break` and the row
  // after the damaged one is lost with it; remove the guard and the second
  // test reads the damaged row, whose one stored piece is a whole payload.
  it('leaves the damaged row out without throwing, and keeps the rows around it', async () => {
    const database = rawDatabase();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    insertRawState(database, 'agent-raw');
    insertRawRow(database, 0, [before]);
    // A row written in two pieces, as the archive splits one that outgrows a transaction.
    const payload = compressedRow([damaged]);
    const middle = Math.floor(payload.length / 2);
    insertRawPiece(database, 'agent-raw', 100, 0, 2, payload.subarray(0, middle));
    insertRawPiece(database, 'agent-raw', 100, 1, 2, payload.subarray(middle));
    insertRawRow(database, 200, [after]);
    // The control: whole, the two pieces read back as the row.
    expect((await readArchivedConversation(database, 'agent-raw', ALL))?.entries).toEqual([before, damaged, after]);

    // The cache answers at the same revision, so the damage must be read afresh.
    resetArchiveReadCacheForTests();
    database.prepare("DELETE FROM transcript_archive_rows WHERE agent_session_id = 'agent-raw' AND row_start = 100 AND piece = 1").run();

    const conversation = await readArchivedConversation(database, 'agent-raw', ALL);

    expect(conversation?.entries).toEqual([before, after]);
  });

  it('leaves out a row that declares more pieces than it holds, even when what it holds decodes', async () => {
    const database = rawDatabase();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    insertRawState(database, 'agent-raw');
    insertRawRow(database, 0, [before]);
    insertRawPiece(database, 'agent-raw', 100, 0, 2, compressedRow([damaged]));
    insertRawRow(database, 200, [after]);

    const conversation = await readArchivedConversation(database, 'agent-raw', ALL);

    expect(conversation?.entries).toEqual([before, after]);
  });
});
