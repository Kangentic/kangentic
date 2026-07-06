import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../../src/shared/types';

/**
 * `resolveTaskTranscript` stitches a task's ENTIRE lifecycle (every session it
 * has ever accumulated - a model switch stays within one session, but an
 * agent change, an isolated swimlane move, or an explicit new spawn each
 * create a new `sessions` row) into one chronological timeline. This is
 * unconditional, not a user setting: "the conversation for this task" always
 * means its full history end to end, regardless of the anchor session id
 * passed in. Covers: multi-session stitching + session_boundary dividers +
 * per-entry agentName stamping, isolated-swimlane boundary labeling, the
 * single-session/orphan fallback, and the not-found case.
 */

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { resolveTaskTranscript } from '../../src/main/agent/transcript-service';
import { agentRegistry } from '../../src/main/agent/agent-registry';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-1',
    cwd: '/work/project',
    started_at: '2026-06-01T12:00:00Z',
    exited_at: null,
    status: 'exited',
    ...overrides,
  } as unknown as SessionRecord;
}

interface FakeDbOptions {
  /** Rows returned for `findByAnyId` (keyed by the id or agent_session_id passed). */
  sessionsById: Record<string, SessionRecord | undefined>;
  /** Rows returned for `listForTaskNewestFirst`, already in the desired order
   *  (the fake does not itself sort - callers script it however the test needs). */
  sessionsByTask: Record<string, SessionRecord[]>;
  taskTitle?: string;
  swimlaneNames?: Record<string, string>;
  /** Indexed chunks keyed by doc_id (the Kangentic session id), for the
   *  index-fallback path when a session's live parse comes back empty. */
  chunkRowsByDocId?: Record<string, Array<{ id: number; role: string; text: string; turn_uuid_start: string | null; ts_start: number | null }>>;
}

function makeFakeDb(options: FakeDbOptions): Database.Database {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ? OR agent_session_id = ?')) {
            const id = args[0] as string;
            return options.sessionsById[id];
          }
          if (sql.includes('SELECT title FROM tasks WHERE id = ?')) {
            return options.taskTitle ? { title: options.taskTitle } : undefined;
          }
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE task_id = ?')) {
            const taskId = args[0] as string;
            return options.sessionsByTask[taskId] ?? [];
          }
          if (sql.includes('FROM swimlanes WHERE id IN')) {
            const ids = args as string[];
            return ids
              .filter((id) => options.swimlaneNames?.[id])
              .map((id) => ({ id, name: options.swimlaneNames![id] }));
          }
          if (sql.includes('FROM memory_chunks WHERE corpus = ? AND doc_id = ?')) {
            const docId = args[1] as string;
            const rows = options.chunkRowsByDocId?.[docId] ?? [];
            return rows.map((row) => ({
              id: row.id,
              corpus: 'conversation',
              doc_id: docId,
              seq: row.id,
              session_id: docId,
              task_id: 'task-1',
              agent_session_id: null,
              role: row.role,
              text: row.text,
              content_hash: `hash-${row.id}`,
              token_estimate: 1,
              ts_start: row.ts_start,
              ts_end: row.ts_start,
              turn_uuid_start: row.turn_uuid_start,
              turn_uuid_end: row.turn_uuid_start,
              embedded_model: null,
            }));
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  } as unknown as Database.Database;
}

const getBySessionType = vi.mocked(agentRegistry.getBySessionType);

describe('resolveTaskTranscript', () => {
  it('returns null when the anchor session id resolves to no record at all', async () => {
    const db = makeFakeDb({ sessionsById: {}, sessionsByTask: {} });
    getBySessionType.mockReturnValue(undefined);

    const result = await resolveTaskTranscript(db, 'no-such-session');

    expect(result).toBeNull();
  });

  it('stitches two sessions oldest-first with a session_boundary divider, stamping each assistant entry with its own session\'s agentName', async () => {
    // Distinct session_type per record so getBySessionType can route each to
    // its own parser/displayName below.
    const older = makeRecord({ id: 'session-old', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_old' });
    const newer = makeRecord({ id: 'session-new', started_at: '2026-06-01T12:00:00Z', session_type: 'claude_agent_new', status: 'running' });
    const db = makeFakeDb({
      sessionsById: { 'session-old': older, 'session-new': newer },
      // Newest-first, matching the real SQL's ORDER BY started_at DESC - the
      // service reverses this itself.
      sessionsByTask: { 'task-1': [newer, older] },
      taskTitle: 'Wire the auth flow',
    });
    const parseOld = vi.fn(async () => ({
      entries: [{ kind: 'assistant' as const, uuid: 'a-old', ts: 1, blocks: [{ type: 'text' as const, text: 'from the old session' }] }],
      sourcePath: '/history/old.jsonl',
    }));
    const parseNew = vi.fn(async () => ({
      entries: [{ kind: 'assistant' as const, uuid: 'a-new', ts: 2, blocks: [{ type: 'text' as const, text: 'from the new session' }] }],
      sourcePath: '/history/new.jsonl',
    }));
    getBySessionType.mockImplementation((sessionType: string) =>
      (sessionType === 'claude_agent_old'
        ? { displayName: 'Claude Code (old)', parseTranscript: parseOld }
        : { displayName: 'Claude Code (new)', parseTranscript: parseNew }) as unknown as ReturnType<
        typeof agentRegistry.getBySessionType
      >,
    );

    const result = await resolveTaskTranscript(db, 'session-new');

    expect(result).not.toBeNull();
    // Top-level fields describe the LATEST session.
    expect(result!.record.id).toBe('session-new');
    expect(result!.agentName).toBe('Claude Code (new)');
    expect(result!.source).toBe('live');
    expect(result!.sourcePath).toBe('/history/new.jsonl');

    // Entries: old session's turn, a session_boundary divider, new session's turn.
    expect(result!.entries).toHaveLength(3);
    const [oldTurn, boundary, newTurn] = result!.entries;
    expect(oldTurn.kind).toBe('assistant');
    if (oldTurn.kind === 'assistant') {
      expect(oldTurn.agentName).toBe('Claude Code (old)');
      expect(oldTurn.blocks[0]).toMatchObject({ text: 'from the old session' });
    }
    expect(boundary).toMatchObject({ kind: 'system', subtype: 'session_boundary' });
    if (boundary.kind === 'system') {
      expect(boundary.text).toContain('Claude Code (new)');
    }
    expect(newTurn.kind).toBe('assistant');
    if (newTurn.kind === 'assistant') {
      expect(newTurn.agentName).toBe('Claude Code (new)');
    }

    // Every contributing session is listed, oldest first.
    expect(result!.sessions.map((s) => s.sessionId)).toEqual(['session-old', 'session-new']);
  });

  it('labels the session_boundary with the isolated swimlane name when the newer session is isolated', async () => {
    const older = makeRecord({ id: 'session-old', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_a' });
    const newer = makeRecord({
      id: 'session-new',
      started_at: '2026-06-01T12:00:00Z',
      session_type: 'claude_agent_a',
      isolated_swimlane_id: 'lane-executing',
    });
    const db = makeFakeDb({
      sessionsById: { 'session-old': older, 'session-new': newer },
      sessionsByTask: { 'task-1': [newer, older] },
      taskTitle: 'Wire the auth flow',
      swimlaneNames: { 'lane-executing': 'Executing' },
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async () => ({ entries: [], sourcePath: null })),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-new');

    const boundary = result!.entries.find((entry) => entry.kind === 'system' && entry.subtype === 'session_boundary');
    expect(boundary).toBeDefined();
    if (boundary?.kind === 'system') {
      expect(boundary.text).toContain('isolated: Executing');
    }
  });

  it('degrades gracefully to just its own entries for a session with no task_id (an orphan/transient record)', async () => {
    const orphan = makeRecord({ id: 'session-orphan', task_id: null as unknown as string });
    const db = makeFakeDb({
      sessionsById: { 'session-orphan': orphan },
      sessionsByTask: {},
      taskTitle: undefined,
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async () => ({
        entries: [{ kind: 'user' as const, uuid: 'u1', ts: 1, text: 'orphan turn' }],
        sourcePath: '/history/orphan.jsonl',
      })),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-orphan');

    expect(result).not.toBeNull();
    expect(result!.entries).toEqual([{ kind: 'user', uuid: 'u1', ts: 1, text: 'orphan turn' }]);
    // No session_boundary divider: there is nothing to stitch across.
    expect(result!.entries.some((entry) => entry.kind === 'system')).toBe(false);
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].sessionId).toBe('session-orphan');
  });

  it('aggregates degraded=true when an EARLIER session fell back to the index, even though the latest session is live', async () => {
    const older = makeRecord({ id: 'session-old', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-old' });
    const newer = makeRecord({ id: 'session-new', started_at: '2026-06-01T12:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-new' });
    const db = makeFakeDb({
      sessionsById: { 'session-old': older, 'session-new': newer },
      sessionsByTask: { 'task-1': [newer, older] },
      taskTitle: 'Wire the auth flow',
      // The older session's native history is gone, but it has an indexed
      // chunk to fall back to (source 'index', degraded for that session).
      // Keyed by agent_session_id, matching resolveSessionTranscript's actual
      // doc_id lookup (the indexer's document identity is the agent transcript,
      // not the Kangentic session row).
      chunkRowsByDocId: {
        'agent-old': [{ id: 1, role: 'user', text: 'indexed only', turn_uuid_start: 'u-old', ts_start: 1 }],
      },
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async (agentSessionId: string) =>
        // The older session's live parse comes back empty (triggering its
        // own index fallback); the newer session's succeeds normally.
        agentSessionId === older.agent_session_id
          ? { entries: [], sourcePath: null }
          : { entries: [{ kind: 'user', uuid: 'u-new', ts: 2, text: 'live turn' }], sourcePath: '/history/new.jsonl' },
      ),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-new');

    // The top-level `source` describes only the LATEST session (live)...
    expect(result!.source).toBe('live');
    // ...but `degraded` is the aggregate: true because the OLDER session
    // degraded, even though it isn't the one the top-level fields describe.
    expect(result!.degraded).toBe(true);
  });
});
