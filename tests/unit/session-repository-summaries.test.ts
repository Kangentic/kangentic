/**
 * Real-DB tests for SessionRepository.listAllSummaries (the Completed Tasks
 * dialog aggregation, now pushed into SQL).
 *
 * The strongest pin is PARITY: getSummaryForTask (unchanged, per-task,
 * already SQL-aggregated) is the semantic oracle, and listAllSummaries must
 * deep-equal it for every task. On top of that, a few absolute assertions pin
 * the semantics both methods share, so a bug present in both cannot hide:
 *   - session-lineage token dedup (latest row per COALESCE(agent_session_id, id),
 *     summed across lineages - a flat SUM would double-count resumed sessions);
 *   - MAX(files_changed) vs SUM for the other counters;
 *   - latest-record scalars (model, exit code, tool breakdown);
 *   - MIN(started_at) / MAX(COALESCE(exited_at, suspended_at)) timeline;
 *   - sessions with NULL total_cost_usd are excluded entirely.
 *
 * Uses a real in-memory better-sqlite3 DB bootstrapped via runProjectMigrations
 * so the schema matches production exactly. Skips cleanly when better-sqlite3
 * cannot load under the test runner's Node ABI (NODE_MODULE_VERSION mismatch
 * under plain system Node); mirrors the probe pattern in
 * usage-history-migration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors usage-history-migration.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    // Use a variable for the module name to avoid the static-require lint rule
    // (which targets string-literal bare requires in bundled main/preload code;
    // this is a test helper for a native probe, not a bundled require).
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';

interface SessionFixture {
  id: string;
  taskId: string;
  agentSessionId?: string | null;
  startedAt: string;
  exitedAt?: string | null;
  suspendedAt?: string | null;
  exitCode?: number | null;
  totalCostUsd?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  totalDurationMs?: number | null;
  toolCallCount?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  toolBreakdown?: string | null;
  compactionCount?: number | null;
  modelDisplayName?: string | null;
}

describe.runIf(CAN_RUN)('SessionRepository.listAllSummaries (real DB)', () => {
  let db: InstanceType<typeof DatabaseType>;
  let repository: SessionRepository;

  function insertTask(taskId: string, createdAt: string): void {
    const swimlaneId = (db.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
    db.prepare(`
      INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(taskId, `Task ${taskId}`, swimlaneId, createdAt, createdAt);
  }

  function insertSession(fixture: SessionFixture): void {
    db.prepare(`
      INSERT INTO sessions (
        id, task_id, session_type, agent_session_id, command, cwd, started_at,
        exited_at, suspended_at, exit_code, total_cost_usd, total_input_tokens,
        total_output_tokens, total_duration_ms, tool_call_count, lines_added,
        lines_removed, files_changed, tool_breakdown, compaction_count,
        model_display_name
      ) VALUES (?, ?, 'agent', ?, 'claude', '/mock/project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixture.id,
      fixture.taskId,
      fixture.agentSessionId ?? null,
      fixture.startedAt,
      fixture.exitedAt ?? null,
      fixture.suspendedAt ?? null,
      fixture.exitCode ?? null,
      fixture.totalCostUsd ?? null,
      fixture.totalInputTokens ?? null,
      fixture.totalOutputTokens ?? null,
      fixture.totalDurationMs ?? null,
      fixture.toolCallCount ?? null,
      fixture.linesAdded ?? null,
      fixture.linesRemoved ?? null,
      fixture.filesChanged ?? null,
      fixture.toolBreakdown ?? null,
      fixture.compactionCount ?? null,
      fixture.modelDisplayName ?? null,
    );
  }

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
    repository = new SessionRepository(db);
  });

  afterEach(() => {
    db?.close();
  });

  /**
   * Seeds the shared multi-task fixture:
   * - task-resumed: one lineage resumed across two records (shared
   *   agent_session_id) plus an isolated-swimlane lineage, mixed NULL metrics.
   * - task-single: one record with no agent_session_id (lineage falls back to
   *   the record id) and a suspended (never exited) end.
   * - task-uncosted: only a NULL-cost session (excluded everywhere).
   */
  function seedFixture(): void {
    insertTask('task-resumed', '2026-01-01T08:00:00.000Z');
    insertTask('task-single', '2026-01-02T08:00:00.000Z');
    insertTask('task-uncosted', '2026-01-03T08:00:00.000Z');

    // Lineage A, older record: stale cumulative tokens that MUST NOT count.
    insertSession({
      id: 'record-a1',
      taskId: 'task-resumed',
      agentSessionId: 'lineage-a',
      startedAt: '2026-01-01T09:00:00.000Z',
      exitedAt: '2026-01-01T10:00:00.000Z',
      exitCode: 0,
      totalCostUsd: 1.25,
      totalInputTokens: 1000,
      totalOutputTokens: 100,
      totalDurationMs: 60_000,
      toolCallCount: 5,
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
      toolBreakdown: JSON.stringify([
        { toolName: 'Bash', callCount: 2, totalDurationMs: 500, interruptedCount: 0 },
      ]),
      compactionCount: 1,
      modelDisplayName: 'Old Model',
    });
    // Lineage A, resumed (latest for the lineage AND the task): its cumulative
    // tokens supersede record-a1's; its scalars win for the whole task.
    insertSession({
      id: 'record-a2',
      taskId: 'task-resumed',
      agentSessionId: 'lineage-a',
      startedAt: '2026-01-01T11:00:00.000Z',
      exitedAt: '2026-01-01T12:30:00.000Z',
      exitCode: 1,
      totalCostUsd: 2.5,
      totalInputTokens: 5000,
      totalOutputTokens: 700,
      totalDurationMs: 90_000,
      toolCallCount: 8,
      linesAdded: 20,
      linesRemoved: 4,
      filesChanged: 7,
      toolBreakdown: JSON.stringify([
        { toolName: 'Edit', callCount: 4, totalDurationMs: 900, interruptedCount: 1 },
      ]),
      compactionCount: 0,
      modelDisplayName: 'Latest Model',
    });
    // Lineage B (isolated-swimlane session): additive tokens, NULL metrics
    // exercise the ?? 0 / SUM-ignores-NULL equivalence.
    insertSession({
      id: 'record-b1',
      taskId: 'task-resumed',
      agentSessionId: 'lineage-b',
      startedAt: '2026-01-01T10:15:00.000Z',
      suspendedAt: '2026-01-01T10:45:00.000Z',
      totalCostUsd: 0.75,
      totalInputTokens: 300,
      totalOutputTokens: 30,
      totalDurationMs: null,
      toolCallCount: null,
      linesAdded: null,
      linesRemoved: null,
      filesChanged: null,
      compactionCount: null,
    });

    insertSession({
      id: 'record-single',
      taskId: 'task-single',
      agentSessionId: null,
      startedAt: '2026-01-02T09:00:00.000Z',
      suspendedAt: '2026-01-02T09:30:00.000Z',
      exitCode: null,
      totalCostUsd: 0.1,
      totalInputTokens: 42,
      totalOutputTokens: 7,
      totalDurationMs: 1000,
      toolCallCount: 1,
      linesAdded: 1,
      linesRemoved: 0,
      filesChanged: 1,
      compactionCount: 0,
      modelDisplayName: 'Solo Model',
    });

    // Never finalized with cost: invisible to summaries.
    insertSession({
      id: 'record-uncosted',
      taskId: 'task-uncosted',
      agentSessionId: 'lineage-c',
      startedAt: '2026-01-03T09:00:00.000Z',
      totalCostUsd: null,
      totalInputTokens: 999,
      totalOutputTokens: 999,
    });
  }

  it('deep-equals getSummaryForTask for every task (parity with the per-task oracle)', () => {
    seedFixture();
    const summaries = repository.listAllSummaries();

    expect(Object.keys(summaries).sort()).toEqual(['task-resumed', 'task-single']);
    for (const taskId of Object.keys(summaries)) {
      expect(summaries[taskId]).toEqual(repository.getSummaryForTask(taskId));
    }
    expect(repository.getSummaryForTask('task-uncosted')).toBeNull();
  });

  it('dedups tokens per session lineage and sums across lineages', () => {
    seedFixture();
    const summary = repository.listAllSummaries()['task-resumed'];

    // Lineage A contributes only record-a2 (its latest); lineage B adds on top.
    expect(summary.totalInputTokens).toBe(5000 + 300);
    expect(summary.totalOutputTokens).toBe(700 + 30);
    // Cost/duration/tools/lines/compactions are flat SUMs across every record.
    expect(summary.totalCostUsd).toBeCloseTo(1.25 + 2.5 + 0.75, 10);
    expect(summary.durationMs).toBe(60_000 + 90_000);
    expect(summary.toolCallCount).toBe(5 + 8);
    expect(summary.linesAdded).toBe(10 + 20);
    expect(summary.linesRemoved).toBe(2 + 4);
    expect(summary.compactionCount).toBe(1 + 0);
    // files_changed is MAX, not SUM (branch-cumulative snapshot).
    expect(summary.filesChanged).toBe(7);
  });

  it('takes scalars from the latest record and spans the full timeline', () => {
    seedFixture();
    const summary = repository.listAllSummaries()['task-resumed'];

    expect(summary.sessionId).toBe('lineage-a');
    expect(summary.modelDisplayName).toBe('Latest Model');
    expect(summary.exitCode).toBe(1);
    expect(summary.toolBreakdown).toEqual([
      { toolName: 'Edit', callCount: 4, totalDurationMs: 900, interruptedCount: 1 },
    ]);
    expect(summary.taskCreatedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(summary.startedAt).toBe('2026-01-01T09:00:00.000Z');
    // Latest end across the task: record-a2 exited later than record-b1
    // suspended; suspended_at stands in for exited_at when a run never exited.
    expect(summary.exitedAt).toBe('2026-01-01T12:30:00.000Z');
  });

  it('falls back to the record id as the lineage key and session id when agent_session_id is NULL', () => {
    seedFixture();
    const summary = repository.listAllSummaries()['task-single'];

    expect(summary.sessionId).toBe('record-single');
    expect(summary.totalInputTokens).toBe(42);
    expect(summary.totalOutputTokens).toBe(7);
    // A suspended-only session still closes the timeline.
    expect(summary.exitedAt).toBe('2026-01-02T09:30:00.000Z');
    expect(summary.exitCode).toBeNull();
    expect(summary.toolBreakdown).toEqual([]);
  });

  it('returns an empty record when no session has cost data', () => {
    insertTask('task-empty', '2026-01-05T08:00:00.000Z');
    insertSession({
      id: 'record-empty',
      taskId: 'task-empty',
      startedAt: '2026-01-05T09:00:00.000Z',
      totalCostUsd: null,
    });

    expect(repository.listAllSummaries()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Skip-notice for environments where better-sqlite3 cannot load.
// ---------------------------------------------------------------------------

describe.runIf(!CAN_RUN)('SessionRepository.listAllSummaries tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
