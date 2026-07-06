import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Project } from '../../src/shared/types';

/**
 * `searchConversationMemory({ taskId })` restricts conversation hits to one
 * task's history - the "what was discussed in task #N about X" recall path.
 * Lexical filtering happens in the SQL query itself (a JOIN against
 * memory_chunks.task_id); semantic filtering post-filters an over-fetched
 * vec0 candidate set (vec0 has no per-query WHERE). This fake DB mirrors
 * memory-search-degradation.test.ts's pattern but adds routing for the two
 * new query shapes: getChunkIdsForTask and the task-scoped lexical JOIN.
 */

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => {
    throw new Error('getProjectDb should not be called - getDb is injected in tests');
  }),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: () => undefined },
}));

import { searchConversationMemory } from '../../src/main/retrieval/memory-search';

interface StoredChunkRow {
  id: number;
  corpus: string;
  doc_id: string;
  seq: number;
  session_id: string | null;
  task_id: string | null;
  agent_session_id: string | null;
  role: string;
  text: string;
  content_hash: string;
  token_estimate: number;
  ts_start: number | null;
  ts_end: number | null;
  turn_uuid_start: string | null;
  turn_uuid_end: string | null;
  embedded_model: string | null;
}

function chunkRow(overrides: Partial<StoredChunkRow> & { id: number }): StoredChunkRow {
  return {
    corpus: 'conversation',
    doc_id: 'session-1',
    seq: overrides.id,
    session_id: 's1',
    task_id: 't1',
    agent_session_id: 'agent-1',
    role: 'assistant',
    text: `full chunk text ${overrides.id}`,
    content_hash: `hash-${overrides.id}`,
    token_estimate: 10,
    ts_start: 1717000000000,
    ts_end: 1717000000000,
    turn_uuid_start: `turn-${overrides.id}`,
    turn_uuid_end: `turn-${overrides.id}`,
    embedded_model: null,
    ...overrides,
  };
}

interface FakeDbConfig {
  /** Rows returned for a task-scoped lexical MATCH (the JOIN query). */
  lexicalForTask: Record<string, Array<{ id: number; snip: string; score: number }>>;
  /** Chunk ids belonging to each task, for getChunkIdsForTask. */
  chunkIdsByTask: Record<string, number[]>;
  chunks: StoredChunkRow[];
  taskTitles: Record<string, string>;
  sessionTypes: Record<string, string>;
}

function makeFakeDb(config: FakeDbConfig): Database.Database {
  return {
    prepare(sql: string) {
      return {
        all: (...args: unknown[]) => {
          // getChunkIdsForTask: SELECT id FROM memory_chunks WHERE task_id = ?
          if (sql.includes('SELECT id FROM memory_chunks WHERE task_id')) {
            const taskId = args[0] as string;
            return (config.chunkIdsByTask[taskId] ?? []).map((id) => ({ id }));
          }
          // Task-scoped lexical: the FTS MATCH joined against memory_chunks.task_id.
          if (sql.includes('memory_chunks_fts') && sql.includes('MATCH') && sql.includes('task_id')) {
            const taskId = args[1] as string;
            return config.lexicalForTask[taskId] ?? [];
          }
          if (sql.includes('memory_chunks_vec')) return [];
          if (sql.includes('FROM memory_chunks') && sql.includes('id IN')) {
            const ids = new Set(args as number[]);
            return config.chunks.filter((row) => ids.has(row.id));
          }
          return [];
        },
        get: (...args: unknown[]) => {
          if (sql.includes('SELECT title FROM tasks')) {
            const taskId = args[0] as string;
            const title = config.taskTitles[taskId];
            return title === undefined ? undefined : { title };
          }
          if (sql.includes('SELECT session_type FROM sessions')) {
            const sessionId = args[0] as string;
            const sessionType = config.sessionTypes[sessionId];
            return sessionType === undefined ? undefined : { session_type: sessionType };
          }
          return undefined;
        },
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-A',
    name: overrides.name ?? 'Proj A',
    path: overrides.path ?? '/mock/proj-a',
    github_url: overrides.github_url ?? null,
    default_agent: overrides.default_agent ?? 'claude',
    group_id: overrides.group_id ?? null,
    position: overrides.position ?? 0,
    last_opened: overrides.last_opened ?? '2026-05-01T00:00:00Z',
    created_at: overrides.created_at ?? '2026-04-01T00:00:00Z',
  };
}

const PROJECT_A = makeProject({ id: 'project-A', name: 'Proj A' });

describe('searchConversationMemory - taskId scoping', () => {
  it('restricts hits to the given task and skips a project with none of its chunks', () => {
    const configA: FakeDbConfig = {
      lexicalForTask: { 't1': [{ id: 5, snip: 'discussed the retry logic', score: -3.2 }] },
      chunkIdsByTask: { t1: [5, 6] },
      chunks: [chunkRow({ id: 5 })],
      taskTitles: { t1: 'Fix retries' },
      sessionTypes: { s1: 'claude_agent' },
    };
    const projectB = makeProject({ id: 'project-B', name: 'Proj B' });
    const getDb = vi.fn((projectId: string) => {
      if (projectId === 'project-A') return makeFakeDb(configA);
      // Project B has no chunks for this task at all.
      return makeFakeDb({ lexicalForTask: {}, chunkIdsByTask: {}, chunks: [], taskTitles: {}, sessionTypes: {} });
    });

    return searchConversationMemory({
      query: 'retry',
      projects: [PROJECT_A, projectB],
      taskId: 't1',
      getDb,
    }).then((hits) => {
      expect(hits).toHaveLength(1);
      expect(hits[0].chunkId).toBe(5);
      expect(hits[0].taskId).toBe('t1');
      expect(hits[0].projectId).toBe('project-A');
      // Project B was skipped before ever running a lexical/semantic query
      // against it, since it holds none of the task's chunks.
    });
  });

  it('returns [] when the task has no chunks in any project, without throwing', async () => {
    const getDb = vi.fn(() =>
      makeFakeDb({ lexicalForTask: {}, chunkIdsByTask: {}, chunks: [], taskTitles: {}, sessionTypes: {} }),
    );

    const hits = await searchConversationMemory({
      query: 'anything',
      projects: [PROJECT_A],
      taskId: 'task-with-nothing',
      getDb,
    });

    expect(hits).toEqual([]);
  });

  it('without taskId, behaves as an unscoped search (existing behavior unaffected)', async () => {
    const configA: FakeDbConfig = {
      lexicalForTask: {},
      chunkIdsByTask: {},
      chunks: [chunkRow({ id: 5 })],
      taskTitles: { t1: 'Fix retries' },
      sessionTypes: { s1: 'claude_agent' },
    };
    // Unscoped search hits the plain (non-task) lexical query shape, which this
    // fake DB does not script - it should return [] rather than throw, proving
    // the taskId-scoped code path is not taken when taskId is omitted.
    const getDb = vi.fn(() => makeFakeDb(configA));

    const hits = await searchConversationMemory({
      query: 'retry',
      projects: [PROJECT_A],
      getDb,
    });

    expect(hits).toEqual([]);
  });
});
