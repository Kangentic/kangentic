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
    // First appearance of the newer session reads simply "New session".
    expect(boundary).toMatchObject({ kind: 'system', subtype: 'session_boundary', text: 'New session' });
    expect(newTurn.kind).toBe('assistant');
    if (newTurn.kind === 'assistant') {
      expect(newTurn.agentName).toBe('Claude Code (new)');
    }

    // Every contributing session is listed, oldest first.
    expect(result!.sessions.map((s) => s.sessionId)).toEqual(['session-old', 'session-new']);
  });

  it('labels a first-time session crossing simply "New session" (no agent name or swimlane detail), even for an isolated session', async () => {
    const older = makeRecord({ id: 'session-old', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-old' });
    const newer = makeRecord({
      id: 'session-new',
      started_at: '2026-06-01T12:00:00Z',
      session_type: 'claude_agent_a',
      agent_session_id: 'agent-new',
      isolated_swimlane_id: 'lane-executing',
    });
    const db = makeFakeDb({
      sessionsById: { 'session-old': older, 'session-new': newer },
      sessionsByTask: { 'task-1': [newer, older] },
      taskTitle: 'Wire the auth flow',
    });
    // Each session contributes a distinct turn so a boundary is genuinely
    // emitted between them (a boundary only precedes real new content).
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async (agentSessionId: string) => ({
        entries: [{ kind: 'user' as const, uuid: `turn-${agentSessionId}`, ts: 1, text: 'a turn' }],
        sourcePath: '/history/x.jsonl',
      })),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-new');

    const boundary = result!.entries.find((entry) => entry.kind === 'system' && entry.subtype === 'session_boundary');
    expect(boundary).toMatchObject({ kind: 'system', text: 'New session' });
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

  it('preserves an assistant turn\'s per-turn token usage through the stitch (so burn-rate analysis can read it off the unified conversation)', async () => {
    const record = makeRecord({ id: 'session-usage', task_id: 'task-1', agent_session_id: 'agent-usage' });
    const db = makeFakeDb({
      sessionsById: { 'session-usage': record },
      sessionsByTask: { 'task-1': [record] },
      taskTitle: 'Wire the auth flow',
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async () => ({
        entries: [
          { kind: 'assistant' as const, uuid: 'a1', ts: 1, model: 'claude-opus-4-8',
            usage: { inputTokens: 120, outputTokens: 45, cacheCreationInputTokens: 2000, cacheReadInputTokens: 18000 },
            blocks: [{ type: 'text' as const, text: 'reply' }] },
        ],
        sourcePath: '/history/usage.jsonl',
      })),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-usage');

    const assistant = result!.entries.find((entry) => entry.kind === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant?.kind === 'assistant') {
      // Survives both truncateEntries and the agentName stamp.
      expect(assistant.agentName).toBe('Claude Code');
      expect(assistant.usage).toEqual({ inputTokens: 120, outputTokens: 45, cacheCreationInputTokens: 2000, cacheReadInputTokens: 18000 });
    }
  });

  it('orders turns chronologically across an isolated excursion, with a boundary INTO the isolated session AND back to the main one, so resumed main-session turns land last (not buried mid-timeline)', async () => {
    // The real isolated-swimlane round-trip: the main session runs, is suspended
    // for an isolated Code Review excursion, then RESUMES into the same
    // transcript. Its post-excursion turns (ts 100/110) are timestamped AFTER
    // the isolated session's turns (ts 40/50), even though session-grouping
    // would lump them with the pre-excursion main turns. The merge must be
    // chronological, and a divider must appear at BOTH crossings.
    const main = makeRecord({ id: 'session-main', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-main' });
    const iso = makeRecord({
      id: 'session-iso',
      started_at: '2026-06-01T11:00:00Z',
      session_type: 'claude_agent_a',
      agent_session_id: 'agent-iso',
      isolated_swimlane_id: 'lane-code-review',
    });
    const db = makeFakeDb({
      sessionsById: { 'session-main': main, 'session-iso': iso },
      sessionsByTask: { 'task-1': [iso, main] }, // newest-first; service reverses to oldest-first
      taskTitle: 'Wire the auth flow',
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async (agentSessionId: string) =>
        agentSessionId === 'agent-main'
          ? {
              // The shared/resumed main transcript: turns before AND after the excursion.
              entries: [
                { kind: 'user', uuid: 'm1', ts: 10, text: 'pre-excursion prompt' },
                { kind: 'assistant', uuid: 'm2', ts: 20, blocks: [{ type: 'text', text: 'pre-excursion reply' }] },
                { kind: 'user', uuid: 'm3', ts: 100, text: 'post-resume prompt' },
                { kind: 'assistant', uuid: 'm4', ts: 110, blocks: [{ type: 'text', text: 'post-resume reply' }] },
              ],
              sourcePath: '/history/main.jsonl',
            }
          : {
              entries: [
                { kind: 'user', uuid: 'i1', ts: 40, text: 'code-review prompt' },
                { kind: 'assistant', uuid: 'i2', ts: 50, blocks: [{ type: 'text', text: 'code-review reply' }] },
              ],
              sourcePath: '/history/iso.jsonl',
            },
      ),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-iso');

    // Chronological order by ts, with a boundary at each session crossing:
    // "New session" into the never-seen isolated one, "Resumed session" back
    // into the main one it already showed.
    const shape = result!.entries.map((entry) =>
      entry.kind === 'system' ? `boundary:${entry.text}` : entry.uuid,
    );
    expect(shape).toEqual(['m1', 'm2', 'boundary:New session', 'i1', 'i2', 'boundary:Resumed session', 'm3', 'm4']);

    // The two newest turns (the resumed main session's) are dead last, not
    // buried in the middle where the viewer would never scroll to them.
    expect(result!.entries[result!.entries.length - 1]).toMatchObject({ uuid: 'm4' });
    expect(result!.entries[result!.entries.length - 2]).toMatchObject({ uuid: 'm3' });

    // Boundary uuids are unique even though main is entered twice conceptually.
    const boundaries = result!.entries.filter((entry) => entry.kind === 'system');
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].uuid).not.toBe(boundaries[1].uuid);
  });

  it('deduplicates turns a resumed session replays from its parent, keeping each once at its original position and only stitching the resume\'s genuinely-new turns', async () => {
    // The classic --resume shape: the newer session's native transcript
    // REPLAYS the older session's turns verbatim (same uuids), then appends a
    // new one. Naive concatenation would double-count every replayed turn,
    // producing duplicate uuids that break the viewer's React keys / measurement
    // cache (rows stack on top of each other).
    const older = makeRecord({ id: 'session-old', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-old' });
    const newer = makeRecord({ id: 'session-new', started_at: '2026-06-01T12:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-new', status: 'running' });
    const db = makeFakeDb({
      sessionsById: { 'session-old': older, 'session-new': newer },
      sessionsByTask: { 'task-1': [newer, older] },
      taskTitle: 'Wire the auth flow',
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async (agentSessionId: string) =>
        agentSessionId === 'agent-old'
          ? {
              entries: [
                { kind: 'user', uuid: 'shared-1', ts: 1, text: 'first prompt' },
                { kind: 'assistant', uuid: 'shared-2', ts: 2, blocks: [{ type: 'text', text: 'first reply' }] },
              ],
              sourcePath: '/history/old.jsonl',
            }
          : {
              // Replays shared-1 + shared-2, then adds one genuinely-new turn.
              entries: [
                { kind: 'user', uuid: 'shared-1', ts: 1, text: 'first prompt' },
                { kind: 'assistant', uuid: 'shared-2', ts: 2, blocks: [{ type: 'text', text: 'first reply' }] },
                { kind: 'user', uuid: 'new-3', ts: 3, text: 'second prompt' },
              ],
              sourcePath: '/history/new.jsonl',
            },
      ),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-new');

    // No duplicate uuids survive the stitch.
    const uuids = result!.entries.map((entry) => entry.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);

    // The two shared turns appear once (at their original position), then a
    // single boundary, then only the resume's new turn.
    const kinds = result!.entries.map((entry) =>
      entry.kind === 'system' ? `boundary` : `${entry.kind}:${entry.uuid}`,
    );
    expect(kinds).toEqual(['user:shared-1', 'assistant:shared-2', 'boundary', 'user:new-3']);
  });

  it('emits NO session_boundary for a wholly-replayed resume that adds no new turns (nothing to divide, no dangling divider)', async () => {
    // The exact bug from an isolated-swimlane round-trip: the "latest" session
    // is a --resume of the original and its transcript is an EXACT replay with
    // no new content yet. It must contribute nothing - no duplicate turns, and
    // no orphaned "New session" divider with an empty body under it.
    const older = makeRecord({ id: 'session-old', started_at: '2026-06-01T10:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-old' });
    const newer = makeRecord({ id: 'session-new', started_at: '2026-06-01T12:00:00Z', session_type: 'claude_agent_a', agent_session_id: 'agent-new', status: 'running' });
    const db = makeFakeDb({
      sessionsById: { 'session-old': older, 'session-new': newer },
      sessionsByTask: { 'task-1': [newer, older] },
      taskTitle: 'Wire the auth flow',
    });
    const replayed = [
      { kind: 'user' as const, uuid: 'shared-1', ts: 1, text: 'only prompt' },
      { kind: 'assistant' as const, uuid: 'shared-2', ts: 2, blocks: [{ type: 'text' as const, text: 'only reply' }] },
    ];
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async () => ({ entries: replayed, sourcePath: '/history/x.jsonl' })),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveTaskTranscript(db, 'session-new');

    // Exactly the two unique turns, no boundary at all.
    expect(result!.entries.map((entry) => entry.uuid)).toEqual(['shared-1', 'shared-2']);
    expect(result!.entries.some((entry) => entry.kind === 'system')).toBe(false);
    // Both sessions are still listed as metadata (the resume is real, it just
    // contributed no new turns).
    expect(result!.sessions.map((s) => s.sessionId)).toEqual(['session-old', 'session-new']);
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
