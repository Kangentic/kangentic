/**
 * Pins for four fixes a review pass made to the structured transcript archive
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
function transcriptLines(turns: number, variant = ''): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
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
  const counter: ParseCounter = { calls: 0, failOnCall: null };
  const adapter: ArchiveAdapter = {
    locateSessionHistoryFile: async () => (fs.existsSync(transcriptPath) ? transcriptPath : null),
    parseTranscriptWindow: async (_agentSessionId, _cwd, startByte, maxBytes, carry) => {
      counter.calls += 1;
      if (counter.failOnCall === counter.calls) throw new Error('the adapter failed mid-walk');
      const window = await parseClaudeTranscriptWindow(transcriptPath, startByte, maxBytes, carry);
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

describe('an archived row that is not a list of entries', () => {
  const NOW = '2026-10-01T12:00:00.000Z';

  /** Writes one single-piece row directly, as an older or damaged archive could hold it. */
  function insertRawRow(database: DatabaseType.Database, rowStart: number, decoded: unknown): void {
    const payload = brotliCompressSync(Buffer.from(JSON.stringify(decoded), 'utf8'));
    database.prepare(
      `INSERT INTO transcript_archive_rows (agent_session_id, row_start, piece, piece_count, source_end, entry_count, payload)
       VALUES ('agent-raw', ?, 0, 1, ?, 1, ?)`,
    ).run(rowStart, rowStart + 100, payload);
  }

  // Red-green: `isArchivedEntry` and the list check in `readArchivedConversation`.
  // Replace the loop with `entries.push(...(rowEntries as TranscriptEntry[]))`
  // and the element with no `kind`, the bare values, and the characters of the
  // string row all reach the reader.
  it('skips a row that decodes to a non-list, and leaves out elements without a string kind', async () => {
    const database = openTestDatabase();
    openDatabases.push(database);
    runProjectMigrations(database);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    database.prepare(
      `INSERT INTO transcript_archive_state (agent_session_id, session_id, resume_offset, revision, updated_at)
       VALUES ('agent-raw', NULL, 0, 1, ?)`,
    ).run(NOW);
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
