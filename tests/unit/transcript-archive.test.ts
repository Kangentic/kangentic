/**
 * The structured transcript archive (`src/main/retrieval/archive/transcript-archive.ts`)
 * keeps a conversation readable after the agent CLI deletes its own file.
 *
 * The claim that matters is exact: what the archive reads back is what a parse
 * of the whole file gives, after any number of appends, a torn last line, and
 * a rewrite. These tests hold it to that with the real pieces: Claude-format
 * JSONL on disk, the real window parser, real Brotli, and real better-sqlite3.
 * Windows are small, so a short transcript crosses several rows.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { resolveSessionTranscript, resolveTaskTranscript } from '../../src/main/agent/transcript-service';
import { openTestDatabase } from './helpers/test-database';
import type { TranscriptEntry } from '../../src/shared/types';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const WINDOW_BYTES = 2000;
const ALL = Number.MAX_SAFE_INTEGER;
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

beforeEach(() => resetArchiveReadCacheForTests());

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-archive-'));
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

function writeTranscript(filePath: string, lines: string[], trailing = ''): void {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n${trailing}`);
}

interface Fixture {
  database: DatabaseType.Database;
  archive: TranscriptArchive;
  /** Where each conversation's file lives, as `<agentSessionId>.jsonl`. */
  directory: string;
  transcriptPath: string;
  /** Agent session ids in the order the parser was asked for their windows. */
  walked: string[];
}

function fixture(options: {
  conversations?: string[];
  windowBytes?: number;
  mayReadPlace?: (place: CliPlace | null) => Promise<boolean>;
} = {}): Fixture {
  const directory = temporaryDirectory();
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  const conversations = options.conversations ?? ['agent-1'];
  conversations.forEach((agentSessionId, index) => {
    database.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES (?, 'task-1', 'claude_agent', ?, 'claude', '/work', 'suspended', ?)`,
    ).run(`session-${index + 1}`, agentSessionId, `2026-09-30T12:0${index}:00.000Z`);
  });
  const walked: string[] = [];
  const pathFor = (agentSessionId: string) => path.join(directory, `${agentSessionId}.jsonl`);
  const adapter: ArchiveAdapter = {
    locateSessionHistoryFile: async (agentSessionId) => (fs.existsSync(pathFor(agentSessionId)) ? pathFor(agentSessionId) : null),
    parseTranscriptWindow: async (agentSessionId, _cwd, startByte, maxBytes, carry) => {
      if (walked[walked.length - 1] !== agentSessionId) walked.push(agentSessionId);
      const window = await parseClaudeTranscriptWindow(pathFor(agentSessionId), startByte, maxBytes, carry);
      return { ...window, sourcePath: pathFor(agentSessionId) };
    },
  };
  const archive = new TranscriptArchive({
    getDb: () => database, getAdapter: () => adapter, windowBytes: options.windowBytes ?? WINDOW_BYTES,
    mayReadPlace: options.mayReadPlace,
  });
  return { database, archive, directory, transcriptPath: pathFor(conversations[0]), walked };
}

/** Entries as a whole-file parse gives them, for comparison. */
async function wholeFileEntries(filePath: string): Promise<TranscriptEntry[]> {
  return parseClaudeTranscript(filePath);
}

async function archivedEntries(database: DatabaseType.Database, agentSessionId = 'agent-1'): Promise<TranscriptEntry[]> {
  return (await readArchivedConversation(database, agentSessionId, ALL))?.entries ?? [];
}

function rowCount(database: DatabaseType.Database): number {
  return (database.prepare('SELECT COUNT(DISTINCT row_start) AS rows FROM transcript_archive_rows').get() as { rows: number }).rows;
}

describe('transcript archive', () => {
  it('reads back exactly what a whole-file parse gives, across several rows', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(12));

    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');

    expect(rowCount(database)).toBeGreaterThan(2);
    expect(await archivedEntries(database)).toEqual(await wholeFileEntries(transcriptPath));
  });

  it('keeps the conversation after the file is deleted, and a later walk changes nothing', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(6));
    await archive.archiveSession('project-1', 'session-1');
    const before = await wholeFileEntries(transcriptPath);

    fs.rmSync(transcriptPath);
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('missing-source');

    expect(await archivedEntries(database)).toEqual(before);
  });

  it('appends: a turn end rewrites only the open row and still matches the whole file', async () => {
    const { database, archive, transcriptPath } = fixture();
    const first = transcriptLines(10);
    writeTranscript(transcriptPath, first);
    await archive.archiveSession('project-1', 'session-1');
    const closedRows = database.prepare(
      'SELECT row_start, payload FROM transcript_archive_rows ORDER BY row_start, piece',
    ).all() as Array<{ row_start: number; payload: Buffer }>;
    const resumeOffset = (database.prepare('SELECT resume_offset FROM transcript_archive_state').get() as { resume_offset: number }).resume_offset;

    writeTranscript(transcriptPath, [...first, ...transcriptLines(5, '', 10)]);
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');

    // Every row before the open one is untouched, byte for byte.
    const after = database.prepare(
      'SELECT row_start, payload FROM transcript_archive_rows WHERE row_start < ? ORDER BY row_start, piece',
    ).all(resumeOffset) as Array<{ row_start: number; payload: Buffer }>;
    expect(after).toEqual(closedRows.filter((row) => row.row_start < resumeOffset));
    expect(await archivedEntries(database)).toEqual(await wholeFileEntries(transcriptPath));
  });

  it('reads a half-written last line whole on the next walk, once', async () => {
    const { database, archive, transcriptPath } = fixture();
    const lines = transcriptLines(8);
    const last = lines[lines.length - 1];
    writeTranscript(transcriptPath, lines.slice(0, -1), last.slice(0, 40));
    await archive.archiveSession('project-1', 'session-1');

    writeTranscript(transcriptPath, lines);
    await archive.archiveSession('project-1', 'session-1');

    const entries = await archivedEntries(database);
    expect(entries).toEqual(await wholeFileEntries(transcriptPath));
    expect(entries.filter((entry) => entry.uuid === 'assistant-7-tool')).toHaveLength(1);
  });

  it('walks a rewritten file from the start', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(10));
    await archive.archiveSession('project-1', 'session-1');

    // Different bytes before the resume point.
    writeTranscript(transcriptPath, transcriptLines(10, 'X'));
    await archive.archiveSession('project-1', 'session-1');

    const entries = await archivedEntries(database);
    expect(entries).toEqual(await wholeFileEntries(transcriptPath));
    expect(entries.some((entry) => entry.kind === 'user' && entry.text.includes('Question 0X'))).toBe(true);
  });

  it('skips a walk when the file has not changed', async () => {
    const { archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(4));
    await archive.archiveSession('project-1', 'session-1');
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('unchanged');
  });

  it('splits a large row into pieces that each fit the write budget, and reads them back', async () => {
    // A window large enough for the one big line.
    const { database, archive, transcriptPath } = fixture({ windowBytes: 1024 * 1024 });
    // Random text barely compresses, so one row is several pieces.
    const noise = crypto.randomBytes(90 * 1024).toString('hex');
    writeTranscript(transcriptPath, [JSON.stringify({
      type: 'user', uuid: 'big', timestamp: '2026-09-30T12:00:00.000Z', message: { role: 'user', content: noise },
    })]);
    await archive.archiveSession('project-1', 'session-1');

    const pieces = database.prepare('SELECT LENGTH(payload) AS bytes, piece_count AS count FROM transcript_archive_rows').all() as Array<{ bytes: number; count: number }>;
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.bytes <= 48 * 1024 && piece.count === pieces.length)).toBe(true);
    expect(await archivedEntries(database)).toEqual(await wholeFileEntries(transcriptPath));
  });

  it('reads only the newest rows within the bound, after an omitted-bytes count', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(20));
    await archive.archiveSession('project-1', 'session-1');

    const bounded = await readArchivedConversation(database, 'agent-1', WINDOW_BYTES);
    const whole = await wholeFileEntries(transcriptPath);
    expect(bounded).not.toBeNull();
    expect(bounded!.omittedBytes).toBeGreaterThan(0);
    expect(bounded!.entries.length).toBeLessThan(whole.length);
    expect(bounded!.entries[bounded!.entries.length - 1]).toEqual(whole[whole.length - 1]);
  });

  it('serves a repeat read at the same revision from cache, as the same object', async () => {
    const { database, archive, transcriptPath } = fixture();
    writeTranscript(transcriptPath, transcriptLines(3));
    await archive.archiveSession('project-1', 'session-1');
    const first = await readArchivedConversation(database, 'agent-1', ALL);
    expect(await readArchivedConversation(database, 'agent-1', ALL)).toBe(first);
  });

  it('archives only conversations a session record names', async () => {
    const { archive } = fixture();
    expect(await archive.archiveSession('project-1', 'workflow-agent-session')).toBe('skipped');
  });

  it('sweeps oldest first, then purges an archive once no session names it', async () => {
    const { database, archive, directory, walked } = fixture({ conversations: ['agent-new', 'agent-old'] });
    const newer = path.join(directory, 'agent-new.jsonl');
    const older = path.join(directory, 'agent-old.jsonl');
    writeTranscript(newer, transcriptLines(2));
    writeTranscript(older, transcriptLines(2));
    fs.utimesSync(older, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    fs.utimesSync(newer, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));

    expect(await archive.sweep('project-1', () => true)).toEqual({ archived: 2, purged: 0 });
    expect(walked).toEqual(['agent-old', 'agent-new']);

    database.prepare("DELETE FROM sessions WHERE agent_session_id = 'agent-old'").run();
    expect((await archive.sweep('project-1', () => true)).purged).toBe(1);
    expect(await archivedEntries(database, 'agent-old')).toEqual([]);
    expect((await archivedEntries(database, 'agent-new')).length).toBeGreaterThan(0);
  });

  it('is what the Conversation tab reads once the agent\'s file is gone: structured, not degraded, named', async () => {
    // The real Claude adapter looks for the file under the home folder, where
    // this conversation never was, so its live parse finds nothing and the
    // read falls to the archive, as it does once Claude deletes the file.
    const { database, archive, transcriptPath } = fixture();
    database.prepare("INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-1', 1, 'Fix login', '', 'lane-1', 0, '2026-09-30T12:00:00.000Z', '2026-09-30T12:00:00.000Z')").run();
    writeTranscript(transcriptPath, transcriptLines(4));
    await archive.archiveSession('project-1', 'session-1');
    const whole = await wholeFileEntries(transcriptPath);

    const session = await resolveSessionTranscript(database, 'session-1');
    expect(session?.source).toBe('archive');
    expect(session?.degraded).toBe(false);
    expect(session?.entries.map((entry) => entry.uuid)).toEqual(whole.map((entry) => entry.uuid));

    const task = await resolveTaskTranscript(database, 'session-1');
    expect(task?.archivedAgentName).toBe('Claude Code');
    expect(task?.degraded).toBe(false);
  });

  // Reading a stopped WSL distro's share starts it, so neither walk touches a
  // conversation there until the distro runs; then it is archived as any other.
  it('leaves a conversation in a stopped WSL distro for a walk while it runs', async () => {
    let running = false;
    const mayReadPlace = vi.fn(async () => running);
    const { database, archive, transcriptPath, walked } = fixture({ mayReadPlace });
    database.prepare('UPDATE sessions SET cli_target = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'wsl', distro: 'Ubuntu', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu' }),
      'session-1',
    );
    writeTranscript(transcriptPath, transcriptLines(2));

    expect(await archive.archiveSession('project-1', 'session-1')).toBe('skipped');
    expect(await archive.sweep('project-1', () => true)).toEqual({ archived: 0, purged: 0 });
    expect(walked).toEqual([]);
    expect(mayReadPlace.mock.calls[0][0]).toEqual(expect.objectContaining({ distro: 'Ubuntu' }));

    running = true;
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('archived');
  });

  it('does nothing on a database without the archive tables', async () => {
    const database = openTestDatabase();
    openDatabases.push(database);
    database.exec("CREATE TABLE sessions (id TEXT, agent_session_id TEXT, session_type TEXT, cwd TEXT, started_at TEXT)");
    const archive = new TranscriptArchive({ getDb: () => database, getAdapter: () => undefined, windowBytes: WINDOW_BYTES });
    expect(await archive.archiveSession('project-1', 'session-1')).toBe('skipped');
    expect(await archive.sweep('project-1', () => true)).toEqual({ archived: 0, purged: 0 });
    expect(await readArchivedConversation(database, 'agent-1', ALL)).toBeNull();
  });
});
