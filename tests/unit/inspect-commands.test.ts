import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetTranscript, handleQueryDb } from '../../src/main/agent/commands/inspect-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { TranscriptEntry } from '../../src/shared/types';
import type { AgentAdapter, ParsedTranscript } from '../../src/main/agent/agent-adapter';

// Vitest hoists vi.mock() calls automatically, so these factories run before
// the inspect-commands module is evaluated. We mock the agent registry (the
// single dispatch point) rather than individual parser modules - the handler
// routes structured transcripts through `agentRegistry.getBySessionType().
// parseTranscript`, with no agent-name branching of its own.

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

// transcript-format is NOT mocked: filterTranscriptView / searchTranscript /
// renderTranscriptBudgeted are pure and agent-agnostic, so the handler's
// view/tail/search/budget wiring is exercised against the real implementations.
import { agentRegistry } from '../../src/main/agent/agent-registry';

/**
 * Build a stub adapter for a session_type. Pass `parseTranscript` to simulate
 * an agent with a structured parser; omit it to simulate an agent that only
 * supports the raw format (Aider, Warp, ...).
 */
function stubAdapter(options: {
  displayName: string;
  parseTranscript?: (agentSessionId: string, cwd: string) => Promise<ParsedTranscript>;
}): AgentAdapter {
  const adapter: Partial<AgentAdapter> = { displayName: options.displayName };
  if (options.parseTranscript) {
    adapter.parseTranscript = vi.fn(options.parseTranscript);
  }
  return adapter as AgentAdapter;
}

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
        // SessionRepository.getLatestForTask / listForTaskNewestFirst.
        // `all` filters by the bound task id and orders started_at DESC.
        return {
          get: vi.fn((taskId: string) => sessions.find((session) => session.task_id === taskId) ?? undefined),
          all: vi.fn((taskId?: string) => {
            const matched = taskId ? sessions.filter((session) => session.task_id === taskId) : sessions;
            return [...matched].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
          }),
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
      // TranscriptRepository.getTranscriptTail - SELECT substr(transcript, ?) ...
      // bound as (negativeStart, sessionId). Simulates SQLite's substr(X, -N)
      // (last N chars) so the raw get_transcript tail path is exercised end to end.
      if (sql.includes('FROM session_transcripts') && sql.includes('substr(transcript')) {
        return {
          get: vi.fn((negativeStart: number, sessionId: string) => {
            const record = transcripts.find((transcript) => transcript.session_id === sessionId);
            if (!record) return undefined;
            const full = record.transcript ?? '';
            // substr(X, Y): Y < 0 -> last |Y| chars; Y === 0 -> the whole string.
            const start = negativeStart < 0 ? Math.max(0, full.length + negativeStart) : 0;
            return {
              tail: full.slice(start),
              full_length: full.length,
              size_bytes: record.size_bytes,
              created_at: record.created_at,
              updated_at: record.updated_at,
            };
          }),
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
    vi.mocked(agentRegistry.getBySessionType).mockReset();
  });

  it('returns error when no taskId or sessionId provided', async () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = await handleGetTranscript({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId or sessionId');
  });

  it('returns raw transcript by sessionId when format="raw"', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Claude Code' }));
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
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Claude Code' }));
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

  it('reports structured is unsupported when the adapter has no parseTranscript', async () => {
    // Aider-style adapter: present in the registry but no structured parser.
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Aider' }));
    const db = createMockDb({
      sessions: [{
        id: 'session-aider',
        task_id: 'task-1',
        session_type: 'aider_agent',
        agent_session_id: 'aider-uuid',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-aider', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('not supported');
    expect(result.message).toContain('Aider');
    expect(result.message).toContain('format="raw"');
  });

  it('reports structured is unsupported when no adapter is registered for the session_type', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(undefined);
    const db = createMockDb({
      sessions: [{
        id: 'session-unknown',
        task_id: 'task-1',
        session_type: 'mystery_agent',
        agent_session_id: 'x',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-unknown', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('not supported');
    expect(result.message).toContain('mystery_agent');
  });

  it('reports native history not yet written when the parser exists but agent_session_id is null', async () => {
    const parseTranscript = vi.fn();
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );
    const db = createMockDb({
      sessions: [{ id: 'session-abc', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: null }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-abc', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('no agent_session_id');
    // Parser must NOT have been called - the guard fires before dispatch.
    expect(parseTranscript).not.toHaveBeenCalled();
  });

  it('dispatches through the adapter capability and returns structured markdown', async () => {
    const fakeEntries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hello' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'world' }] },
    ];
    const parseTranscript = vi.fn().mockResolvedValue({
      entries: fakeEntries,
      sourcePath: '/fake/.factory/sessions/cwd-slug/droid-session.jsonl',
    });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );

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
    expect(result.message).toContain('Format: structured');
    expect(result.message).toContain('Entries: 2');
    expect(result.message).toContain('## User');
    // The capability is invoked with the agent session id and cwd.
    expect(parseTranscript).toHaveBeenCalledWith('droid-uuid-1234', 'C:/Users/dev/project');
    // Data payload carries the located source path as filePath.
    expect(result.data).toMatchObject({
      sessionId: 'session-droid',
      format: 'structured',
      entryCount: 2,
      filePath: '/fake/.factory/sessions/cwd-slug/droid-session.jsonl',
    });
  });

  it('reports native history not found when the parser returns no entries', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({ entries: [], sourcePath: '/fake/path.jsonl' });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );

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
    expect(result.message).toContain('No structured transcript found');
    expect(result.message).toContain('/fake/path.jsonl');
  });

  it('defaults to format="structured" when format param is omitted', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({
      entries: [{ kind: 'user', uuid: 'u1', ts: 0, text: 'hi' }] satisfies TranscriptEntry[],
      sourcePath: '/fake/path.jsonl',
    });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );

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
    expect(parseTranscript).toHaveBeenCalledOnce();
  });

  // --- view / tail / search / maxChars / sessionIndex (cross-agent views) ---

  /** Wire a droid session whose parser returns `entries`, scoped to task-1. */
  function structuredSetup(entries: TranscriptEntry[]): { parseTranscript: ReturnType<typeof vi.fn>; context: CommandContext } {
    const parseTranscript = vi.fn().mockResolvedValue({ entries, sourcePath: '/fake/history.jsonl' });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );
    const db = createMockDb({
      sessions: [{
        id: 'session-views',
        task_id: 'task-1',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid',
        cwd: 'C:/Users/dev/project',
      }],
    });
    return { parseTranscript, context: createMockContext(db) };
  }

  it('view="responses" returns only assistant text turns', async () => {
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'please deploy' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [
        { type: 'text', text: 'first answer' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] },
      { kind: 'tool_result', uuid: 'r1', ts: 2, toolUseId: 't1', content: 'a.txt' },
      { kind: 'assistant', uuid: 'a2', ts: 3, blocks: [{ type: 'text', text: 'second answer' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', view: 'responses' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('first answer');
    expect(result.message).toContain('second answer');
    expect(result.message).not.toContain('please deploy');
    expect(result.message).not.toContain('## User');
    expect(result.message).not.toContain('Bash');
    expect(result.data).toMatchObject({ view: 'responses' });
  });

  it('view="result" returns the final assistant text bare, without an "## Assistant" heading', async () => {
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'first answer' }] },
      { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: 'the final answer' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', view: 'result' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('the final answer');
    expect(result.message).not.toContain('first answer');
    expect(result.message).not.toContain('## Assistant');
    expect(result.data).toMatchObject({ view: 'result', renderedEntryCount: 1 });
  });

  it('view="result" walks back past a trailing tool-call-only turn', async () => {
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'closing summary' }] },
      { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { kind: 'tool_result', uuid: 'r1', ts: 2, toolUseId: 't1', content: 'done' },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', view: 'result' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('closing summary');
  });

  it('view="result" reports when there is no assistant text', async () => {
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hi' },
      { kind: 'system', uuid: 's1', ts: 1, subtype: 'command', text: '/exit' },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', view: 'result' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No assistant response found');
    expect(result.message).toContain('view="result"');
  });

  it('search returns only entries containing the term', async () => {
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'unrelated prompt' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'the migration is safe' }] },
      { kind: 'assistant', uuid: 'a2', ts: 2, blocks: [{ type: 'text', text: 'something else entirely' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', search: 'migration' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('the migration is safe');
    expect(result.message).not.toContain('something else entirely');
    expect(result.message).not.toContain('unrelated prompt');
    expect(result.message).toContain('Search: "migration"');
    expect(result.data).toMatchObject({ matchCount: 1 });
  });

  it('search matches content inlined from a tool result, keeping the owning turn', async () => {
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [
        { type: 'text', text: 'running the check' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep migration' } },
      ] },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: 'migration applied cleanly' },
      { kind: 'assistant', uuid: 'a2', ts: 2, blocks: [{ type: 'text', text: 'unrelated closing note' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', search: 'applied cleanly' }, context);

    expect(result.success).toBe(true);
    // The owning assistant turn AND its inlined result are kept and rendered.
    expect(result.message).toContain('running the check');
    expect(result.message).toContain('migration applied cleanly');
    expect(result.message).not.toContain('unrelated closing note');
  });

  it('search reports when nothing matches', async () => {
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'hello world' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', search: 'zzz-nope' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No entries match "zzz-nope"');
  });

  it('tail keeps only the most recent N entries and notes the omission', async () => {
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'aaa' },
      { kind: 'user', uuid: 'u2', ts: 1, text: 'bbb' },
      { kind: 'user', uuid: 'u3', ts: 2, text: 'ccc' },
      { kind: 'assistant', uuid: 'a1', ts: 3, blocks: [{ type: 'text', text: 'final reply' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', tail: 1 }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('final reply');
    expect(result.message).not.toContain('aaa');
    expect(result.message).toContain('Truncated');
    expect(result.message).toContain('by tail');
    expect(result.data).toMatchObject({ renderedEntryCount: 1, omittedEntryCount: 3, truncated: true });
  });

  it('truncates to the most recent entries when over the maxChars budget', async () => {
    const big = (label: string): string => 'x'.repeat(800) + label;
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: big('OLDEST') }] },
      { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: big('MIDDLE') }] },
      { kind: 'assistant', uuid: 'a3', ts: 2, blocks: [{ type: 'text', text: big('NEWEST') }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', maxChars: 1000 }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('NEWEST');
    expect(result.message).not.toContain('OLDEST');
    expect(result.message).toContain('size cap');
    expect(result.data).toMatchObject({ truncated: true });
  });

  it('sessionIndex selects an older session', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({
      entries: [{ kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'ok' }] }],
      sourcePath: '/fake/history.jsonl',
    });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Droid', parseTranscript }));
    const db = createMockDb({
      tasks: [{ id: 'task-1', display_id: 1, session_id: 'session-new' }],
      sessions: [
        { id: 'session-new', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: 'agent-new', cwd: 'C:/Users/dev/project', started_at: '2026-02-02T00:00:00Z' },
        { id: 'session-old', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: 'agent-old', cwd: 'C:/Users/dev/project', started_at: '2026-02-01T00:00:00Z' },
      ],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ taskId: '1', sessionIndex: 1 }, context);

    expect(result.success).toBe(true);
    // sessionIndex 1 = the previous session (sessions ordered started_at DESC).
    expect(parseTranscript).toHaveBeenCalledWith('agent-old', 'C:/Users/dev/project');
  });

  it('returns an error when sessionIndex is out of range', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Droid' }));
    const db = createMockDb({
      tasks: [{ id: 'task-1', display_id: 1, session_id: 'session-1' }],
      sessions: [
        { id: 'session-1', task_id: 'task-1', session_type: 'droid_agent', started_at: '2026-02-02T00:00:00Z' },
        { id: 'session-2', task_id: 'task-1', session_type: 'droid_agent', started_at: '2026-02-01T00:00:00Z' },
      ],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ taskId: '1', sessionIndex: 5 }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
    expect(result.error).toContain('have 2 sessions');
  });

  it('rejects an unknown view value', async () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'x', view: 'pretty' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid view');
  });

  // --- clamp boundary tests ---

  it('tail=0 clamps to 1 and returns the single most-recent entry', async () => {
    // The clamp is Math.max(1, ...), so 0 becomes 1. The result should contain
    // only the last entry and note omission of the rest.
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'first' },
      { kind: 'user', uuid: 'u2', ts: 1, text: 'second' },
      { kind: 'user', uuid: 'u3', ts: 2, text: 'third' },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', tail: 0 }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('third');
    expect(result.message).not.toContain('first');
    expect(result.message).not.toContain('second');
    // Clamped to 1, so 2 entries were omitted by tail
    expect(result.data).toMatchObject({ renderedEntryCount: 1, omittedEntryCount: 2, truncated: true });
  });

  it('maxChars below 1000 clamps to 1000 (the minimum budget floor)', async () => {
    // Supply 10 as maxChars. The handler clamps to 1000. With a 1000-char budget
    // a short single-entry transcript fits entirely, so it should not be truncated.
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'short answer' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', maxChars: 10 }, context);

    expect(result.success).toBe(true);
    // The budget floor of 1000 is wide enough for "short answer", so no truncation.
    expect(result.message).toContain('short answer');
    expect(result.data).toMatchObject({ truncated: false });
  });

  it('maxChars above 500000 clamps to 500000 (the hard ceiling)', async () => {
    // Supply 999999. The handler accepts it silently (no error) but clamps to 500000.
    // With a 500000-char budget a short entry fits without truncation.
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'the answer' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', maxChars: 999_999 }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('the answer');
    // No truncation: the clamped 500k budget comfortably fits a short transcript.
    expect(result.data).toMatchObject({ truncated: false });
  });

  it('negative sessionIndex defaults to 0 (picks the most recent session, not an error)', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({
      entries: [{ kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'from newest' }] }],
      sourcePath: '/fake/path.jsonl',
    });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Droid', parseTranscript }));
    const db = createMockDb({
      tasks: [{ id: 'task-1', display_id: 1, session_id: 'session-new' }],
      sessions: [
        { id: 'session-new', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: 'agent-new', cwd: 'C:/Users/dev/project', started_at: '2026-02-02T00:00:00Z' },
        { id: 'session-old', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: 'agent-old', cwd: 'C:/Users/dev/project', started_at: '2026-02-01T00:00:00Z' },
      ],
    });
    const context = createMockContext(db);

    // sessionIndex=-1 is not >= 0, so the handler defaults to 0 (most recent).
    const result = await handleGetTranscript({ taskId: '1', sessionIndex: -1 }, context);

    expect(result.success).toBe(true);
    expect(parseTranscript).toHaveBeenCalledWith('agent-new', 'C:/Users/dev/project');
    expect(result.message).toContain('from newest');
  });

  // --- medium-value handler tests ---

  it('view="responses" + search together: search filters within the responses view', async () => {
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'deploy please' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'migration is done' }] },
      { kind: 'assistant', uuid: 'a2', ts: 2, blocks: [{ type: 'text', text: 'unrelated closing note' }] },
    ]);

    const result = await handleGetTranscript(
      { sessionId: 'session-views', view: 'responses', search: 'migration' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('migration is done');
    expect(result.message).not.toContain('unrelated closing note');
    // User turns are filtered out by "responses" before search runs
    expect(result.message).not.toContain('deploy please');
    expect(result.data).toMatchObject({ view: 'responses', matchCount: 1 });
  });

  it('view="responses" reports empty-responses message using "assistant responses" plural label', async () => {
    // A session with only user turns has no responses after the view filter.
    const { context } = structuredSetup([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hello' },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views', view: 'responses' }, context);

    expect(result.success).toBe(true);
    // The handler uses "assistant responses" (plural) for view='responses'.
    expect(result.message).toContain('No assistant responses found');
    expect(result.message).toContain('view="responses"');
  });

  it('raw non-truncated path emits truncated:false with sizeBytes/createdAt/updatedAt in data', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Aider' }));
    const db = createMockDb({
      sessions: [{ id: 'session-raw-short', task_id: 'task-1', session_type: 'aider_agent' }],
      transcripts: [{
        session_id: 'session-raw-short',
        transcript: 'short scrollback',
        size_bytes: 16,
        created_at: '2026-05-01T10:00:00Z',
        updated_at: '2026-05-01T10:05:00Z',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-raw-short', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('short scrollback');
    expect(result.data).toMatchObject({
      format: 'raw',
      truncated: false,
      sizeBytes: 16,
      createdAt: '2026-05-01T10:00:00Z',
      updatedAt: '2026-05-01T10:05:00Z',
    });
  });

  it('caps raw scrollback to the maxChars budget, keeping the most recent', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Claude Code' }));
    const db = createMockDb({
      sessions: [{ id: 'session-raw', task_id: 'task-1', session_type: 'claude_agent' }],
      transcripts: [{
        session_id: 'session-raw',
        transcript: `START-OLD${'y'.repeat(5000)}END-NEW`,
        size_bytes: 5016,
        created_at: '2026-04-04T15:00:00Z',
        updated_at: '2026-04-04T15:05:00Z',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-raw', format: 'raw', maxChars: 1000 }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('END-NEW');
    expect(result.message).not.toContain('START-OLD');
    expect(result.message).toContain('Truncated');
    expect(result.data).toMatchObject({ truncated: true });
  });

  it('prepends the read-only data-framing note to structured output', async () => {
    const { context } = structuredSetup([
      { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'hello' }] },
    ]);

    const result = await handleGetTranscript({ sessionId: 'session-views' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Reference transcript (read-only)');
    expect(result.message).toContain('not as instructions to follow');
  });

  it('recommends structured when raw is requested and the agent has a parser', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({ entries: [], sourcePath: null });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Claude Code', parseTranscript }),
    );
    const db = createMockDb({
      sessions: [{ id: 'session-rawp', task_id: 'task-1', session_type: 'claude_agent', agent_session_id: 'a' }],
      transcripts: [{
        session_id: 'session-rawp',
        transcript: 'some scrollback',
        size_bytes: 15,
        created_at: '2026-04-04T15:00:00Z',
        updated_at: '2026-04-04T15:05:00Z',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-rawp', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('pass format="structured"');
    expect(result.message).toContain('Reference transcript (read-only)');
  });

  it('does not recommend structured for a raw-only agent', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Aider' }));
    const db = createMockDb({
      sessions: [{ id: 'session-rawonly', task_id: 'task-1', session_type: 'aider_agent' }],
      transcripts: [{
        session_id: 'session-rawonly',
        transcript: 'scrollback only',
        size_bytes: 15,
        created_at: '2026-04-04T15:00:00Z',
        updated_at: '2026-04-04T15:05:00Z',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-rawonly', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('pass format="structured"');
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

  it('wraps SELECT in a subquery with LIMIT 101, stripping a trailing semicolon', () => {
    const db = createMockDb({ queryResults: [{ id: '1' }] });
    const context = createMockContext(db);

    handleQueryDb({ sql: 'SELECT id FROM tasks;' }, context);

    // The handler strips the trailing semicolon and wraps the SQL before calling prepare.
    // Only the wrapped form is attempted when it succeeds (no raw fallback needed).
    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM (SELECT id FROM tasks) LIMIT 101');
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw query when the wrapped subquery form throws (e.g. EXPLAIN, PRAGMA)', () => {
    // Build a minimal db mock where prepare throws for the wrapped form but
    // succeeds for the raw form, simulating what real SQLite does for statements
    // that cannot be placed inside a subquery such as EXPLAIN or bare PRAGMA.
    const rawResults: Record<string, unknown>[] = [{ journal_mode: 'wal' }];
    const prepareFn = vi.fn((sql: string) => {
      if (sql.startsWith('SELECT * FROM (')) {
        throw new Error('syntax error: cannot be used as a subquery');
      }
      return { all: () => rawResults };
    });
    const customDb = { pragma: vi.fn(), prepare: prepareFn };
    const context = createMockContext(customDb as ReturnType<typeof createMockDb>);

    const result = handleQueryDb({ sql: 'PRAGMA journal_mode' }, context);

    expect(result.success).toBe(true);
    // Wrapped form was attempted first (throws), then raw fallback succeeded.
    expect(prepareFn).toHaveBeenNthCalledWith(1, 'SELECT * FROM (PRAGMA journal_mode) LIMIT 101');
    expect(prepareFn).toHaveBeenNthCalledWith(2, 'PRAGMA journal_mode');
    expect(result.message).toContain('journal_mode');
  });

  it('summary says "Showing the first N rows (more exist; ...)" when over MAX_QUERY_ROWS rows', () => {
    // Return MAX_QUERY_ROWS + 1 = 101 rows so the handler detects truncation.
    const queryResults = Array.from({ length: 101 }, (_, index) => ({ id: String(index) }));
    const db = createMockDb({ queryResults });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT id FROM tasks' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain(
      'Showing the first 100 rows (more exist; add a LIMIT or WHERE to narrow the result).',
    );
    expect(Array.isArray(result.data) && result.data.length).toBe(100);
  });
});
