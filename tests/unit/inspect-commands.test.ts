import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetTranscript, handleQueryDb } from '../../src/main/agent/commands/inspect-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { TranscriptEntry } from '../../src/shared/types';

// Vitest hoists vi.mock() calls automatically, so these mock factories run
// before the inspect-commands module is evaluated and intercept the parsers
// it would otherwise import directly.

vi.mock('../../src/main/agent/adapters/claude/transcript-parser', () => ({
  parseClaudeTranscript: vi.fn(),
  locateClaudeTranscriptFile: vi.fn().mockReturnValue('/fake/.claude/sessions/claude-session.jsonl'),
}));

vi.mock('../../src/main/agent/adapters/droid/transcript-parser', () => ({
  parseDroidTranscript: vi.fn(),
  droidTranscriptFilePath: vi.fn().mockReturnValue('/fake/.factory/sessions/cwd-slug/droid-session.jsonl'),
}));

vi.mock('../../src/shared/transcript-format', () => ({
  transcriptToMarkdown: vi.fn().mockReturnValue('## User\n\nhello\n\n## Assistant\n\nworld'),
}));

// Import the mocked functions so tests can configure return values.
import { parseClaudeTranscript, locateClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-parser';
import { parseDroidTranscript, droidTranscriptFilePath } from '../../src/main/agent/adapters/droid/transcript-parser';
import { transcriptToMarkdown } from '../../src/shared/transcript-format';

// --- Helpers ---

interface MockSessionRow {
  id: string;
  task_id: string;
  session_type?: string;
  agent_session_id?: string | null;
  cwd?: string;
  started_at?: string;
}

function createMockDb(options: {
  tasks?: Array<{ id: string; display_id: number; session_id: string | null }>;
  sessions?: MockSessionRow[];
  transcripts?: Array<{ session_id: string; transcript: string; size_bytes: number; created_at: string; updated_at: string }>;
  queryResults?: Record<string, unknown>[];
} = {}) {
  const { tasks = [], sessions = [], transcripts = [], queryResults = [] } = options;

  const prepareHandlers: Record<string, { get: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn> }> = {};

  // Track PRAGMA query_only state to simulate SQLite's read-only enforcement
  let queryOnly = false;

  // Write statement patterns that SQLite rejects when query_only = ON
  const writePattern = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;
  // Also catch write statements hidden inside subqueries or CTEs
  const embeddedWritePattern = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;

  const db = {
    pragma: vi.fn((command: string) => {
      if (command === 'query_only = ON') queryOnly = true;
      else if (command === 'query_only = OFF') queryOnly = false;
    }),
    prepare: vi.fn((sql: string) => {
      // Task resolution queries
      if (sql.includes('FROM tasks') && sql.includes('display_id')) {
        return {
          get: vi.fn((displayId: number) => tasks.find((task) => task.display_id === displayId) ?? undefined),
          all: vi.fn(() => tasks),
        };
      }
      if (sql.includes('FROM tasks') && sql.includes('WHERE id')) {
        return {
          get: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId) ?? undefined),
          all: vi.fn(() => tasks),
        };
      }

      // Session queries
      if (sql.includes('FROM sessions') && sql.includes('task_id = ?')) {
        // SessionRepository.getLatestForTask
        return {
          get: vi.fn((taskId: string) => sessions.find((session) => session.task_id === taskId) ?? undefined),
          all: vi.fn(() => sessions),
        };
      }
      if (sql.includes('FROM sessions') && sql.includes('id = ?') && sql.includes('agent_session_id = ?')) {
        // SessionRepository.findByAnyId - id OR agent_session_id, both bound positionally
        return {
          get: vi.fn((idArg: string, agentIdArg: string) =>
            sessions.find((session) => session.id === idArg || session.agent_session_id === agentIdArg) ?? undefined),
          all: vi.fn(() => sessions),
        };
      }

      // Transcript queries
      if (sql.includes('FROM session_transcripts') && sql.includes('*')) {
        return {
          get: vi.fn((sessionId: string) => transcripts.find((transcript) => transcript.session_id === sessionId) ?? undefined),
          all: vi.fn(() => transcripts),
        };
      }
      if (sql.includes('FROM session_transcripts') && sql.includes('transcript')) {
        return {
          get: vi.fn((sessionId: string) => {
            const record = transcripts.find((transcript) => transcript.session_id === sessionId);
            return record ? { transcript: record.transcript } : undefined;
          }),
          all: vi.fn(() => transcripts),
        };
      }

      // Generic query (for query_db) - simulate SQLite read-only enforcement
      const handler = {
        get: vi.fn(() => queryResults[0] ?? undefined),
        all: vi.fn(() => {
          if (queryOnly && (writePattern.test(sql) || embeddedWritePattern.test(sql))) {
            // PRAGMA read-only queries are allowed even when query_only is ON
            if (/^\s*PRAGMA\s+\w+\s*\(/i.test(sql)) return queryResults;
            if (/^\s*PRAGMA\s+(?!.*=)/i.test(sql)) return queryResults;
            throw new Error('attempt to write a read-only database');
          }
          return queryResults;
        }),
      };
      prepareHandlers[sql] = handler;
      return handler;
    }),
  };

  return db;
}

function createMockContext(db: ReturnType<typeof createMockDb>): CommandContext {
  return {
    getProjectDb: () => db as never,
    getProjectPath: () => 'C:/Users/dev/project',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

// --- handleGetTranscript ---

describe('handleGetTranscript', () => {
  beforeEach(() => {
    vi.mocked(parseClaudeTranscript).mockReset();
    vi.mocked(parseDroidTranscript).mockReset();
    vi.mocked(locateClaudeTranscriptFile).mockReturnValue('/fake/.claude/sessions/claude-session.jsonl');
    vi.mocked(droidTranscriptFilePath).mockReturnValue('/fake/.factory/sessions/cwd-slug/droid-session.jsonl');
    vi.mocked(transcriptToMarkdown).mockReturnValue('## User\n\nhello\n\n## Assistant\n\nworld');
  });

  it('returns error when no taskId or sessionId provided', async () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = await handleGetTranscript({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId or sessionId');
  });

  it('returns raw transcript by sessionId when format="raw"', async () => {
    const db = createMockDb({
      sessions: [{ id: 'session-abc', task_id: 'task-1', session_type: 'claude_agent' }],
      transcripts: [{
        session_id: 'session-abc',
        transcript: 'Hello world output',
        size_bytes: 18,
        created_at: '2026-04-04T15:00:00Z',
        updated_at: '2026-04-04T15:05:00Z',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-abc', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Hello world output');
    expect(result.message).toContain('session-');
    expect(result.message).toContain('Format: raw');
  });

  it('returns message when no raw transcript exists', async () => {
    const db = createMockDb({
      tasks: [{ id: 'task-1', display_id: 1, session_id: 'session-1' }],
      sessions: [{ id: 'session-1', task_id: 'task-1', session_type: 'claude_agent' }],
      transcripts: [],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ taskId: '1', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No raw transcript captured');
  });

  it('returns error when task not found', async () => {
    const db = createMockDb({ tasks: [] });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ taskId: '999' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not found');
  });

  it('rejects an unknown format value', async () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'x', format: 'pretty' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid format');
  });

  // --- format='structured' dispatch tests ---

  it('early-exits with "no agent_session_id" message before parser dispatch when agent_session_id is null', async () => {
    const db = createMockDb({
      sessions: [{ id: 'session-abc', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: null }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-abc', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('no agent_session_id');
    // Parser must NOT have been called - the guard fires before dispatch.
    expect(parseDroidTranscript).not.toHaveBeenCalled();
    expect(parseClaudeTranscript).not.toHaveBeenCalled();
  });

  it('early-exits with "no agent_session_id" message when agent_session_id is absent from the record', async () => {
    // A session row with no agent_session_id field at all (e.g. sessions
    // spawned before the column was populated). Same guard, different shape.
    const db = createMockDb({
      sessions: [{ id: 'session-abc', task_id: 'task-1', session_type: 'claude_agent' }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-abc', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('no agent_session_id');
    expect(parseClaudeTranscript).not.toHaveBeenCalled();
  });

  it('dispatches to droid_agent parser and returns structured markdown', async () => {
    const fakeEntries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hello' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'world' }] },
    ];
    vi.mocked(parseDroidTranscript).mockResolvedValue(fakeEntries);

    const db = createMockDb({
      sessions: [{
        id: 'session-droid',
        task_id: 'task-1',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid-1234',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-droid', format: 'structured' }, context);

    expect(result.success).toBe(true);
    // Header line must identify the session and format.
    expect(result.message).toContain('Format: structured');
    expect(result.message).toContain('Entries: 2');
    // Markdown body from the mock transcriptToMarkdown.
    expect(result.message).toContain('## User');
    // Droid parser was called; Claude parser was not.
    expect(parseDroidTranscript).toHaveBeenCalledOnce();
    expect(droidTranscriptFilePath).toHaveBeenCalledWith('droid-uuid-1234', 'C:/Users/dev/project');
    expect(parseClaudeTranscript).not.toHaveBeenCalled();
    // Data payload carries the expected metadata.
    expect(result.data).toMatchObject({
      sessionId: 'session-droid',
      format: 'structured',
      entryCount: 2,
    });
  });

  it('dispatches to claude_agent parser and returns structured markdown', async () => {
    const fakeEntries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'run ls' },
    ];
    vi.mocked(parseClaudeTranscript).mockResolvedValue(fakeEntries);

    const db = createMockDb({
      sessions: [{
        id: 'session-claude',
        task_id: 'task-2',
        session_type: 'claude_agent',
        agent_session_id: 'claude-uuid-abcd',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-claude', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Format: structured');
    expect(result.message).toContain('Entries: 1');
    expect(parseClaudeTranscript).toHaveBeenCalledOnce();
    expect(locateClaudeTranscriptFile).toHaveBeenCalledWith('claude-uuid-abcd', 'C:/Users/dev/project');
    expect(parseDroidTranscript).not.toHaveBeenCalled();
  });

  it('returns "not yet supported" for an unsupported session_type with the type name in the message', async () => {
    const db = createMockDb({
      sessions: [{
        id: 'session-codex',
        task_id: 'task-3',
        session_type: 'codex_agent',
        agent_session_id: 'codex-uuid-9999',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-codex', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('codex_agent');
    expect(result.message).toContain('not yet supported');
    // Neither parser should have been called.
    expect(parseDroidTranscript).not.toHaveBeenCalled();
    expect(parseClaudeTranscript).not.toHaveBeenCalled();
  });

  it('returns "no transcript entries" when the parser returns an empty array', async () => {
    vi.mocked(parseDroidTranscript).mockResolvedValue([]);

    const db = createMockDb({
      sessions: [{
        id: 'session-empty',
        task_id: 'task-4',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid-empty',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-empty', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No transcript entries found');
  });

  it('defaults to format="structured" when format param is omitted', async () => {
    const fakeEntries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hi' },
    ];
    vi.mocked(parseDroidTranscript).mockResolvedValue(fakeEntries);

    const db = createMockDb({
      sessions: [{
        id: 'session-default',
        task_id: 'task-5',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid-default',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    // No format param - should default to structured.
    const result = await handleGetTranscript({ sessionId: 'session-default' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Format: structured');
    expect(parseDroidTranscript).toHaveBeenCalledOnce();
  });
});

// --- handleQueryDb ---

describe('handleQueryDb', () => {
  it('returns error when sql is missing', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('sql parameter is required');
  });

  it('blocks INSERT statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: "INSERT INTO tasks VALUES ('x')" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks DELETE statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'DELETE FROM tasks' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks DROP statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'DROP TABLE tasks' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks UPDATE statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: "UPDATE tasks SET title = 'x'" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks PRAGMA writes', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'PRAGMA journal_mode = delete' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('allows SELECT queries', () => {
    const db = createMockDb({
      queryResults: [
        { id: 'task-1', title: 'Test task' },
        { id: 'task-2', title: 'Another task' },
      ],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT id, title FROM tasks' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('task-1');
    expect(result.message).toContain('Test task');
    expect(result.message).toContain('2 row(s)');
  });

  it('allows read-only PRAGMA queries', () => {
    const db = createMockDb({
      queryResults: [{ name: 'id', type: 'TEXT' }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'PRAGMA table_info(tasks)' }, context);

    expect(result.success).toBe(true);
  });

  it('allows WITH (CTE) queries', () => {
    const db = createMockDb({
      queryResults: [{ count: 5 }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'WITH t AS (SELECT * FROM tasks) SELECT count(*) as count FROM t' }, context);

    expect(result.success).toBe(true);
  });

  it('returns formatted message for empty results', () => {
    const db = createMockDb({ queryResults: [] });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT * FROM tasks WHERE 1=0' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('0 rows');
  });

  it('truncates long cell values', () => {
    const longValue = 'x'.repeat(200);
    const db = createMockDb({
      queryResults: [{ id: '1', content: longValue }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT * FROM data' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('...');
    expect(result.message).not.toContain(longValue);
  });

  it('formats output as markdown table', () => {
    const db = createMockDb({
      queryResults: [{ name: 'tasks', type: 'table' }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: "SELECT name, type FROM sqlite_master" }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('| name | type |');
    expect(result.message).toContain('| --- | --- |');
    expect(result.message).toContain('| tasks | table |');
  });

  it('blocks subquery with DELETE', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT * FROM (DELETE FROM tasks RETURNING *)' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });
});
