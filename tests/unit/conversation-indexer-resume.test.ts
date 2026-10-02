/**
 * The live index resumes a growing transcript from its last window instead of
 * walking it from byte 0 on every turn (`ResumePoint` in
 * `src/main/retrieval/conversation/conversation-indexer.ts`).
 *
 * The claim is exact: a resumed walk leaves the same chunks, entry count,
 * usage ledger and spawn links as a walk from byte 0. These tests hold it to
 * that with the real pieces: a Claude-format JSONL on disk, the real window
 * parser (`parseClaudeTranscriptWindow`) and chunker, and the real store and
 * ledger on node:sqlite. Windows are small, so a transcript of a few dozen
 * lines crosses several seams, and assistant messages span several lines so
 * the usage carry has to survive the seam a resume starts at.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { ConversationIndexer } from '../../src/main/retrieval/conversation/conversation-indexer';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { adaptDatabase } from './helpers/node-sqlite-database';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

const WINDOW_BYTES = 2000;
const AGENT_SESSION_ID = 'agent-1';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryFile(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-resume-'));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

/**
 * A transcript's lines, in Claude's format. Each turn is a user line, then an
 * assistant message written as a text line and a tool_use line under one
 * message id, each carrying the message's usage, as Claude writes them. Every
 * fifth turn spawns a subagent.
 */
function transcriptLines(turns: number, variant = ''): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 12, 0, turn)).toISOString();
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `user-${turn}`,
      timestamp,
      message: { role: 'user', content: `Question ${turn}${variant}: what does the resumed walk keep from window ${turn % 7}?` },
    }));
    const usage = { input_tokens: 10 + turn, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 + turn };
    const message = (content: unknown[]) => ({ id: `message-${turn}`, model: 'claude-test', content, usage });
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `assistant-${turn}-text`,
      timestamp,
      // Lengths vary by turn, so window seams fall between any two lines.
      message: message([{ type: 'text', text: `Answer ${turn}: ${'every chunk before the window it starts at. '.repeat(1 + (turn * 7) % 5)}` }]),
    }));
    // Long, so a window often ends just before it and the next opens on the
    // second line of a message: the seam the usage carry exists for.
    const note = 'the tool input a window cannot fit beside the lines before it. '.repeat(20);
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `assistant-${turn}-tool`,
      timestamp,
      message: message([turn % 5 === 0
        ? { type: 'tool_use', id: `tool-${turn}`, name: 'Task', input: { description: `Subagent ${turn}`, note } }
        : { type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { file_path: `src/file-${turn}.ts`, note } }]),
    }));
  }
  return lines;
}

function writeTranscript(filePath: string, lines: string[], trailing = ''): void {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n${trailing}`);
}

interface Project {
  database: InstanceType<SqliteModule['DatabaseSync']>;
  indexer: ConversationIndexer;
  /** The start byte of every window the adapter was asked for. */
  windowStarts: number[];
  /** Point the adapter at another file, as a moved transcript would be. */
  setTranscript(filePath: string): void;
}

function project(transcriptPath: string): Project {
  const database = new sqlite!.DatabaseSync(':memory:');
  const db = adaptDatabase(database);
  runProjectMigrations(db);
  database.exec('PRAGMA foreign_keys = OFF');
  addSession(database, 'session-1', '2026-09-30T12:00:00.000Z');
  const windowStarts: number[] = [];
  let currentPath = transcriptPath;
  const adapter = {
    displayName: 'Claude',
    subagentSpawnToolName: 'Task',
    locateSessionHistoryFile: async () => currentPath,
    parseTranscriptWindow: async (
      _agentSessionId: string, _cwd: string, startByte: number, maxBytes: number, carry?: Set<string>,
    ) => {
      windowStarts.push(startByte);
      const window = await parseClaudeTranscriptWindow(currentPath, startByte, maxBytes, carry);
      return { ...window, sourcePath: currentPath };
    },
  };
  const indexer = new ConversationIndexer({ getDb: () => db, getAdapter: () => adapter, windowBytes: WINDOW_BYTES });
  return { database, indexer, windowStarts, setTranscript: (filePath) => { currentPath = filePath; } };
}

function addSession(database: Project['database'], sessionId: string, startedAt: string, taskId = 'task-1'): void {
  database.prepare(
    `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
     VALUES (?, ?, 'claude_agent', ?, 'claude', '/work', 'running', ?)`,
  ).run(sessionId, taskId, AGENT_SESSION_ID, startedAt);
}

/** Everything a walk leaves behind, in a form two databases can be compared by. */
function indexed(database: Project['database']) {
  return {
    chunks: database.prepare(
      "SELECT seq, content_hash AS hash, session_id AS sessionId FROM memory_chunks WHERE corpus = 'conversation' ORDER BY seq",
    ).all(),
    state: database.prepare(
      "SELECT entry_count AS entries, chunk_count AS chunks, status FROM memory_index_state WHERE corpus = 'conversation'",
    ).all(),
    usage: database.prepare(
      `SELECT turn_uuid AS turn, session_id AS sessionId, input_tokens AS input, output_tokens AS output,
              cache_read_input_tokens AS cacheRead FROM conversation_turn_usage ORDER BY turn_uuid`,
    ).all(),
    spawnLinks: database.prepare('SELECT tool_use_id AS toolUse, turn_uuid AS turn FROM turn_spawn_links ORDER BY tool_use_id').all(),
  };
}

/** What a walk from byte 0 over the transcript as it is now leaves. */
async function fromScratch(transcriptPath: string, sessionId = 'session-1') {
  const fresh = project(transcriptPath);
  if (sessionId !== 'session-1') addSession(fresh.database, sessionId, '2026-09-30T13:00:00.000Z');
  expect(await fresh.indexer.indexSession('project-1', sessionId)).toBe('indexed');
  return indexed(fresh.database);
}

function storedResumeOffset(database: Project['database']): number | null {
  const row = database.prepare("SELECT resume_point AS point FROM memory_index_state WHERE corpus = 'conversation'").get() as { point: string | null };
  return row.point ? (JSON.parse(row.point) as { offset: number }).offset : null;
}

describeWithSqlite('memory_index_state.resume_point migration', () => {
  it('is added in place to a table made before it, keeping its rows', () => {
    const database = new sqlite!.DatabaseSync(':memory:');
    const db = adaptDatabase(database);
    runProjectMigrations(db);
    database.exec('ALTER TABLE memory_index_state DROP COLUMN resume_point');
    database.prepare(
      "INSERT INTO memory_index_state (corpus, doc_id, status, indexed_at) VALUES ('conversation', 'agent-1', 'ok', '2026-09-30T00:00:00.000Z')",
    ).run();

    runProjectMigrations(db);
    runProjectMigrations(db);

    const columns = (database.prepare('PRAGMA table_info(memory_index_state)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns.filter((name) => name === 'resume_point')).toHaveLength(1);
    expect(database.prepare('SELECT doc_id AS docId, resume_point AS point FROM memory_index_state').all())
      .toEqual([{ docId: 'agent-1', point: null }]);
  });
});

describeWithSqlite('ConversationIndexer resumed walk', () => {
  it('walks from byte 0 the first time and leaves a resume point at its last window', async () => {
    const transcriptPath = temporaryFile('agent-1.jsonl');
    writeTranscript(transcriptPath, transcriptLines(20));
    const live = project(transcriptPath);

    expect(await live.indexer.indexSession('project-1', 'session-1')).toBe('indexed');

    expect(live.windowStarts[0]).toBe(0);
    expect(live.windowStarts.length).toBeGreaterThan(3);
    expect(storedResumeOffset(live.database)).toBe(live.windowStarts[live.windowStarts.length - 1]);
  });

  it.each([
    ['inside the last window', 1],
    ['across one seam', 6],
    ['across several seams', 30],
  ])('resumes an append %s and ends where a walk from byte 0 does', async (_label, appendedTurns) => {
    const transcriptPath = temporaryFile('agent-1.jsonl');
    const lines = transcriptLines(20 + appendedTurns);
    writeTranscript(transcriptPath, lines.slice(0, 60));
    const live = project(transcriptPath);
    await live.indexer.indexSession('project-1', 'session-1');
    const resumeOffset = storedResumeOffset(live.database);
    expect(resumeOffset).toBeGreaterThan(0);

    writeTranscript(transcriptPath, lines);
    live.windowStarts.length = 0;
    expect(await live.indexer.indexSession('project-1', 'session-1')).toBe('indexed');

    // It started at the stored window, not at byte 0.
    expect(live.windowStarts[0]).toBe(resumeOffset);
    expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath));
  });

  it('carries the usage attribution across the seam it resumes at', async () => {
    // A message's text line claims its usage and its tool_use line, under the
    // same message id, does not. When the resume window opens on that tool_use
    // line, only the restored carry says the message was already attributed;
    // without it the ledger gains a second row for the same message.
    const lines = transcriptLines(50);
    const lineStarts: number[] = [];
    let position = 0;
    for (const line of lines) {
      lineStarts.push(position);
      position += line.length + 1;
    }
    for (let written = 40; written < 90; written += 1) {
      const transcriptPath = temporaryFile('agent-1.jsonl');
      writeTranscript(transcriptPath, lines.slice(0, written));
      const live = project(transcriptPath);
      await live.indexer.indexSession('project-1', 'session-1');
      // A window starts ON the newline before its first line.
      const firstLine = lineStarts.indexOf((storedResumeOffset(live.database) ?? -2) + 1);
      if (firstLine < 0 || !(JSON.parse(lines[firstLine]) as { uuid: string }).uuid.endsWith('-tool')) continue;

      writeTranscript(transcriptPath, lines);
      await live.indexer.indexSession('project-1', 'session-1');
      expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath));
      return;
    }
    throw new Error('no length of transcript put a message across the resume seam');
  });

  it('keeps resuming turn after turn', async () => {
    const transcriptPath = temporaryFile('agent-1.jsonl');
    const lines = transcriptLines(40);
    const live = project(transcriptPath);
    for (let written = 30; written <= lines.length; written += 9) {
      writeTranscript(transcriptPath, lines.slice(0, written));
      await live.indexer.indexSession('project-1', 'session-1');
    }
    writeTranscript(transcriptPath, lines);
    await live.indexer.indexSession('project-1', 'session-1');
    expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath));
  });

  it('resumes a transcript caught mid-line, and reads the finished line whole', async () => {
    // The reader keeps a half-written last line at end of file, where it
    // fails to parse and is skipped, so the resume point is that window's
    // start and the next walk reads the finished line from it.
    const transcriptPath = temporaryFile('agent-1.jsonl');
    const lines = transcriptLines(30);
    const partial = lines[60].slice(0, Math.floor(lines[60].length / 2));
    writeTranscript(transcriptPath, lines.slice(0, 60), partial);
    const live = project(transcriptPath);
    await live.indexer.indexSession('project-1', 'session-1');
    const resumeOffset = storedResumeOffset(live.database);

    writeTranscript(transcriptPath, lines);
    live.windowStarts.length = 0;
    await live.indexer.indexSession('project-1', 'session-1');
    expect(live.windowStarts[0]).toBe(resumeOffset);
    expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath));
  });

  it('resumes from the last window that advanced when the walk ends on one that did not', async () => {
    // An adapter that cannot get past a record reports no progress, and the
    // walk stops there. A point at that window would restart on nothing.
    const transcriptPath = temporaryFile('agent-1.jsonl');
    writeTranscript(transcriptPath, transcriptLines(30));
    const live = project(transcriptPath);
    const stallAt = 3;
    let calls = 0;
    const database = live.database;
    const stalling = new ConversationIndexer({
      getDb: () => adaptDatabase(database),
      windowBytes: WINDOW_BYTES,
      getAdapter: () => ({
        displayName: 'Claude',
        locateSessionHistoryFile: async () => transcriptPath,
        parseTranscriptWindow: async (_agent: string, _cwd: string, startByte: number, maxBytes: number, carry?: Set<string>) => {
          live.windowStarts.push(startByte);
          calls += 1;
          const window = await parseClaudeTranscriptWindow(transcriptPath, startByte, maxBytes, carry);
          const stalled = calls > stallAt ? { entries: [], nextByteOffset: startByte } : {};
          return { ...window, ...stalled, sourcePath: transcriptPath };
        },
      }),
    });

    await stalling.indexSession('project-1', 'session-1');

    expect(live.windowStarts).toHaveLength(stallAt + 1);
    expect(storedResumeOffset(live.database)).toBe(live.windowStarts[stallAt - 1]);
  });

  describe('walks from byte 0 instead when', () => {
    async function indexedOnce(turns = 30) {
      const transcriptPath = temporaryFile('agent-1.jsonl');
      writeTranscript(transcriptPath, transcriptLines(turns));
      const live = project(transcriptPath);
      await live.indexer.indexSession('project-1', 'session-1');
      live.windowStarts.length = 0;
      return { transcriptPath, live };
    }

    it('a new session row now owns the transcript, and re-points every chunk and turn to it', async () => {
      const { transcriptPath, live } = await indexedOnce();
      writeTranscript(transcriptPath, transcriptLines(34));
      addSession(live.database, 'session-2', '2026-09-30T13:00:00.000Z');

      await live.indexer.indexSession('project-1', 'session-2');

      expect(live.windowStarts[0]).toBe(0);
      expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath, 'session-2'));
    });

    it('the bytes before the resume point were rewritten', async () => {
      const { transcriptPath, live } = await indexedOnce();
      // Longer than before, so only the check on the bytes catches it.
      writeTranscript(transcriptPath, transcriptLines(34, ' (rewritten)'));

      await live.indexer.indexSession('project-1', 'session-1');

      expect(live.windowStarts[0]).toBe(0);
      expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath));
    });

    it('a chunk before the resume point is gone', async () => {
      const { transcriptPath, live } = await indexedOnce();
      live.database.prepare("DELETE FROM memory_chunks WHERE corpus = 'conversation' AND seq = 0").run();
      writeTranscript(transcriptPath, transcriptLines(34));

      await live.indexer.indexSession('project-1', 'session-1');

      expect(live.windowStarts[0]).toBe(0);
      expect(indexed(live.database)).toEqual(await fromScratch(transcriptPath));
    });

    it('the transcript moved', async () => {
      const { live } = await indexedOnce();
      const moved = temporaryFile('agent-1.jsonl');
      writeTranscript(moved, transcriptLines(34));
      live.setTranscript(moved);

      await live.indexer.indexSession('project-1', 'session-1');

      expect(live.windowStarts[0]).toBe(0);
      expect(indexed(live.database)).toEqual(await fromScratch(moved));
    });

    it('the transcript shrank below the resume point', async () => {
      const { transcriptPath, live } = await indexedOnce();
      writeTranscript(transcriptPath, transcriptLines(3));

      await live.indexer.indexSession('project-1', 'session-1');

      expect(live.windowStarts[0]).toBe(0);
      // The ledger keeps the turns the longer transcript had: it never
      // deletes, by design, so only the index can match a fresh walk.
      const { chunks, state } = indexed(live.database);
      const fresh = await fromScratch(transcriptPath);
      expect({ chunks, state }).toEqual({ chunks: fresh.chunks, state: fresh.state });
    });
  });
});
