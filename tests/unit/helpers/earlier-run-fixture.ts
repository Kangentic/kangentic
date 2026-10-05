/**
 * The database fixture and adapter stub behind the earlier-run suites
 * (earlier-run-result-tokens, earlier-run-fill-overtakes-queue, earlier-runs-edge-cases and
 * session-repository-earlier-runs).
 *
 * Each of them runs the real `SessionRepository` and the real session-metrics handlers over an
 * in-memory project database, seeding `sessions` rows that stand for the runs of one task's
 * track. They used to each carry a private copy of the same task insert, the same wide
 * `INSERT INTO sessions` and the same two read-backs, so a column added to `sessions` meant four
 * edits. This module holds what they share and nothing else: constants (timestamps, ids, the
 * rows a quit leaves behind), the manager stub and any adapter that differs from the scoped one
 * stay in the suite that owns them.
 *
 * Every function takes the `Database` it works on, so the helper holds no state between tests.
 * The caller opens the database in `beforeEach` and closes it in `afterEach`.
 */
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { agentRegistry } from '../../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../../src/main/db/migrations/project-schema';
import type { AgentAdapter } from '../../../src/main/agent/agent-adapter';
import type { PerToolStat } from '../../../src/shared/types';

/** A fresh in-memory project database with every migration applied. The caller closes it. */
export function openMigratedProjectDatabase(): Database.Database {
  const database = new Database(':memory:');
  runProjectMigrations(database);
  return database;
}

/** Inserts a task into the first swimlane the migrations seeded, titled after its id. */
export function insertTask(database: Database.Database, taskId: string): void {
  const swimlaneId = (database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
  database.prepare(`
    INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at)
    VALUES (?, ?, ?, 0, '2026-10-05T07:00:00.000Z', '2026-10-05T07:00:00.000Z')
  `).run(taskId, `Task ${taskId}`, swimlaneId);
}

export interface SessionRecordFixture {
  id: string;
  /** Defaults to `task-a`, the one task most suites seed. */
  taskId?: string;
  /** Defaults to the main track (null); a lane id puts the record on that lane's own track. */
  isolatedSwimlaneId?: string | null;
  /** Defaults to `stub_agent`, the session type `stubScopedAdapter` answers for. */
  sessionType?: string;
  /** Defaults to `/mock/project`. */
  cwd?: string;
  /** Omitted is the shared conversation (`conversation-1`); an explicit null is a record with none. */
  agentSessionId?: string | null;
  startedAt: string;
  /**
   * The stored per-tool rows. A string is stored as given, for a record whose breakdown is
   * malformed JSON. Omitted or null stores NULL.
   */
  toolBreakdown?: PerToolStat[] | string | null;
  /**
   * The stored count. Omitted derives it from `toolBreakdown`, as a run's own totals do (NULL
   * when there are no rows to sum); a number or null stores that value as given, for a record
   * whose count and rows disagree.
   */
  toolCallCount?: number | null;
}

/** Inserts one exited session record. */
export function insertSessionRecord(database: Database.Database, fixture: SessionRecordFixture): void {
  const toolBreakdown = fixture.toolBreakdown ?? null;
  const toolCallCount = fixture.toolCallCount !== undefined
    ? fixture.toolCallCount
    : Array.isArray(toolBreakdown) ? toolBreakdown.reduce((sum, stat) => sum + stat.callCount, 0) : null;
  database.prepare(`
    INSERT INTO sessions (
      id, task_id, session_type, isolated_swimlane_id, agent_session_id, command, cwd,
      status, started_at, tool_call_count, tool_breakdown
    ) VALUES (?, ?, ?, ?, ?, 'claude', ?, 'exited', ?, ?, ?)
  `).run(
    fixture.id,
    fixture.taskId ?? 'task-a',
    fixture.sessionType ?? 'stub_agent',
    fixture.isolatedSwimlaneId ?? null,
    fixture.agentSessionId === undefined ? 'conversation-1' : fixture.agentSessionId,
    fixture.cwd ?? '/mock/project',
    fixture.startedAt,
    toolCallCount,
    typeof toolBreakdown === 'string' || toolBreakdown === null ? toolBreakdown : JSON.stringify(toolBreakdown),
  );
}

/** The per-tool rows stored on a record. Throws if the record has none. */
export function readStoredToolRows(database: Database.Database, recordId: string): PerToolStat[] {
  const row = database.prepare('SELECT tool_breakdown FROM sessions WHERE id = ?').get(recordId) as { tool_breakdown: string };
  return JSON.parse(row.tool_breakdown) as PerToolStat[];
}

/** When the record's Tokens read was persisted, or null if it never was. */
export function readResultTokensReadAt(database: Database.Database, recordId: string): string | null {
  const row = database.prepare('SELECT result_tokens_read_at FROM sessions WHERE id = ?').get(recordId) as { result_tokens_read_at: string | null };
  return row.result_tokens_read_at;
}

/**
 * Registers one adapter the agent registry resolves by name (the retrieval worker) and by
 * session type (the earlier-run fill), answering `transcriptToolResultTokens`. It declares
 * `scopesTranscriptReadsByTime`, which the fill requires of an agent before it reads a
 * window. Spies on the registry, so the suite's `vi.restoreAllMocks()` undoes it.
 */
export function stubScopedAdapter(transcriptToolResultTokens: AgentAdapter['transcriptToolResultTokens']): void {
  const adapter = {
    name: 'stub-agent',
    sessionType: 'stub_agent',
    scopesTranscriptReadsByTime: true,
    transcriptToolResultTokens,
  } as unknown as AgentAdapter;
  vi.spyOn(agentRegistry, 'get').mockReturnValue(adapter);
  vi.spyOn(agentRegistry, 'getBySessionType').mockReturnValue(adapter);
}
