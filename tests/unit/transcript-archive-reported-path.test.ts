/**
 * The transcript archive hands the agent-reported transcript path to the adapter
 * (`src/main/retrieval/archive/transcript-archive.ts`).
 *
 * An agent can keep writing a resumed conversation outside the folder its cwd
 * maps to, and the session row's `transcript_path` is the only record of where.
 * `locateSessionHistoryFile` and `parseTranscriptWindow` take it as a trailing
 * `reportedPath`; an archive that drops it locates the file from the cwd alone,
 * finds nothing or the wrong file, and stops updating the conversation. Every
 * other archive test passes a stub that ignores the argument, so a dropped one
 * goes unnoticed. These tests use an adapter that records every argument.
 *
 * Both entry points read the path the same way: the newest session row of the
 * conversation that has one. A row whose status line never painted has none, and
 * an older row of the same conversation may.
 *
 * Real migrated better-sqlite3. The adapter is a recording stub over a real file
 * in a temp folder (the archive stats whatever path the adapter locates). The
 * reported paths themselves are only strings the stub is expected to receive.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  TranscriptArchive,
  resetArchiveReadCacheForTests,
  type ArchiveAdapter,
} from '../../src/main/retrieval/archive/transcript-archive';
import type { ParsedTranscriptWindow } from '../../src/main/agent/agent-adapter';
import { openTestDatabase } from './helpers/test-database';

type LocateArguments = Parameters<ArchiveAdapter['locateSessionHistoryFile']>;
type WindowArguments = Parameters<NonNullable<ArchiveAdapter['parseTranscriptWindow']>>;

/** Where `reportedPath` sits in each recorded call. */
const LOCATE_REPORTED_PATH_INDEX = 3;
const WINDOW_REPORTED_PATH_INDEX = 6;

const AGENT_SESSION_ID = 'agent-conversation-1';
const WINDOW_BYTES = 2000;

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

beforeEach(() => resetArchiveReadCacheForTests());

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A path an agent could have reported, distinct per name. Never created. */
function reportedPath(name: string): string {
  return path.join(os.tmpdir(), 'kangentic-reported-path-names', `${name}.jsonl`);
}

/** One session row of the conversation: `transcriptPath` is what the row's status line reported, or null. */
interface SessionRow {
  id: string;
  startedAt: string;
  transcriptPath: string | null;
}

interface Fixture {
  archive: TranscriptArchive;
  locateCalls: LocateArguments[];
  windowCalls: WindowArguments[];
}

/** A project with `rows` as the sessions of one conversation, and an archive over a recording adapter. */
function fixture(rows: SessionRow[]): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-archive-reported-path-'));
  temporaryDirectories.push(directory);
  const sourceFile = path.join(directory, 'conversation.jsonl');
  fs.writeFileSync(sourceFile, `${JSON.stringify({ type: 'user', uuid: 'user-1' })}\n`);

  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  const insert = database.prepare(
    `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at, transcript_path)
     VALUES (?, 'task-1', 'claude_agent', ?, 'claude', '/work', 'suspended', ?, ?)`,
  );
  for (const row of rows) insert.run(row.id, AGENT_SESSION_ID, row.startedAt, row.transcriptPath);

  const locateCalls: LocateArguments[] = [];
  const windowCalls: WindowArguments[] = [];
  const adapter: ArchiveAdapter = {
    locateSessionHistoryFile: async (...args: LocateArguments) => {
      locateCalls.push(args);
      return sourceFile;
    },
    parseTranscriptWindow: async (...args: WindowArguments): Promise<ParsedTranscriptWindow> => {
      windowCalls.push(args);
      const size = fs.statSync(sourceFile).size;
      return {
        entries: [{ kind: 'user', uuid: 'user-1', ts: 1, text: 'What does the archive keep?' }],
        sourcePath: sourceFile,
        nextByteOffset: size,
        totalBytes: size,
        firstByteOffset: 0,
        endByte: size,
      };
    },
  };
  const archive = new TranscriptArchive({ getDb: () => database, getAdapter: () => adapter, windowBytes: WINDOW_BYTES });
  return { archive, locateCalls, windowCalls };
}

/** The distinct values the calls carried at `index`: empty when nothing was called. */
function distinctAt(calls: ReadonlyArray<ReadonlyArray<unknown>>, index: number): unknown[] {
  return [...new Set(calls.map((args) => args[index]))];
}

/** Every locate and window call got exactly `expected` as its reported path (and there was at least one of each). */
function expectReportedPath(context: Fixture, expected: string | null): void {
  expect(distinctAt(context.locateCalls, LOCATE_REPORTED_PATH_INDEX)).toEqual([expected]);
  expect(distinctAt(context.windowCalls, WINDOW_REPORTED_PATH_INDEX)).toEqual([expected]);
}

describe('TranscriptArchive.sweep hands the reported path to the adapter', () => {
  it('uses the older row\'s path when the newest row of the conversation has none', async () => {
    const older = reportedPath('older-row');
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: older },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.sweep('project-1', () => true)).toEqual({ archived: 1, purged: 0 });

    // The scan's locate, the walk's locate and the window parse all got it.
    expectReportedPath(context, older);
  });

  it('uses the newest row\'s own path when it has one, not an older row\'s', async () => {
    const newest = reportedPath('newest-row');
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: reportedPath('older-row') },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: newest },
    ]);

    expect(await context.archive.sweep('project-1', () => true)).toEqual({ archived: 1, purged: 0 });

    expectReportedPath(context, newest);
  });

  it('takes the newest path that exists when the newest row has none, and skips an older one', async () => {
    const middle = reportedPath('middle-row');
    const context = fixture([
      { id: 'session-oldest', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: reportedPath('oldest-row') },
      { id: 'session-middle', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: middle },
      { id: 'session-newest', startedAt: '2026-09-30T12:10:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.sweep('project-1', () => true)).toEqual({ archived: 1, purged: 0 });

    expectReportedPath(context, middle);
  });

  it('passes null, not a missing argument, when no row of the conversation reported a path', async () => {
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: null },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.sweep('project-1', () => true)).toEqual({ archived: 1, purged: 0 });

    expectReportedPath(context, null);
  });
});

describe('TranscriptArchive.archiveSession hands the reported path to the adapter', () => {
  it('uses the older row\'s path when the session asked for has none (the query coalesces it)', async () => {
    const older = reportedPath('older-row');
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: older },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.archiveSession('project-1', 'session-newest')).toBe('archived');

    expectReportedPath(context, older);
  });

  it('reads the same older path when the session is named by its agent session id', async () => {
    const older = reportedPath('older-row');
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: older },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.archiveSession('project-1', AGENT_SESSION_ID)).toBe('archived');

    expectReportedPath(context, older);
  });

  it('uses the session\'s own path when it has one, not an older row\'s', async () => {
    const newest = reportedPath('newest-row');
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: reportedPath('older-row') },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: newest },
    ]);

    expect(await context.archive.archiveSession('project-1', 'session-newest')).toBe('archived');

    expectReportedPath(context, newest);
  });

  it('takes the newest older path that exists, skipping a row without one', async () => {
    const middle = reportedPath('middle-row');
    const context = fixture([
      { id: 'session-oldest', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: reportedPath('oldest-row') },
      { id: 'session-middle', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: middle },
      { id: 'session-newest', startedAt: '2026-09-30T12:10:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.archiveSession('project-1', 'session-newest')).toBe('archived');

    expectReportedPath(context, middle);
  });

  it('passes null, not a missing argument, when no row of the conversation reported a path', async () => {
    const context = fixture([
      { id: 'session-older', startedAt: '2026-09-30T12:00:00.000Z', transcriptPath: null },
      { id: 'session-newest', startedAt: '2026-09-30T12:05:00.000Z', transcriptPath: null },
    ]);

    expect(await context.archive.archiveSession('project-1', 'session-newest')).toBe('archived');

    expectReportedPath(context, null);
  });
});
