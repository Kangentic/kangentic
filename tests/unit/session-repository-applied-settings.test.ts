/**
 * Tests for `SessionRepository.updateAppliedSettings` and the `applied_model` /
 * `applied_effort` defaults returned by `insert`.
 *
 * These columns record what model/effort a session is actually running at, and
 * are the ground truth `prepareInjectionPlan` diffs against so a column move
 * does not redundantly re-inject `/model` / `/effort`. The partial-update
 * semantics are load-bearing: a switch that changes only effort must not clobber
 * the recorded model.
 *
 * These use a capturing mock DB (the same approach as
 * session-repository-metrics.test.ts), so the tests pin the statements issued
 * rather than a database's contents.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type Database from 'better-sqlite3';

/**
 * A mock DB that captures every prepared SQL string and the params passed to
 * `.run()`, so we can assert which columns an UPDATE touches.
 */
function createCapturingMockDb(): {
  db: Database.Database;
  prepared: string[];
  runParams: unknown[][];
} {
  const prepared: string[] = [];
  const runParams: unknown[][] = [];

  const db = {
    prepare: vi.fn((sql: string) => {
      prepared.push(sql);
      return {
        run: vi.fn((...params: unknown[]) => {
          runParams.push(params);
          return { changes: 1 };
        }),
        get: vi.fn(),
        all: vi.fn(() => []),
      };
    }),
  } as unknown as Database.Database;

  return { db, prepared, runParams };
}

describe('SessionRepository.updateAppliedSettings', () => {
  it('writes only applied_model when only model is provided', () => {
    const { db, prepared, runParams } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    repo.updateAppliedSettings('session-1', { model: 'opus' });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toContain('applied_model = ?');
    expect(prepared[0]).not.toContain('applied_effort');
    // params: [model, id]
    expect(runParams[0]).toEqual(['opus', 'session-1']);
  });

  it('writes only applied_effort when only effort is provided', () => {
    const { db, prepared, runParams } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    repo.updateAppliedSettings('session-1', { effort: 'xhigh' });

    expect(prepared[0]).toContain('applied_effort = ?');
    expect(prepared[0]).not.toContain('applied_model');
    expect(runParams[0]).toEqual(['xhigh', 'session-1']);
  });

  it('writes both columns when both are provided', () => {
    const { db, prepared, runParams } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    repo.updateAppliedSettings('session-1', { model: 'opus', effort: 'xhigh' });

    expect(prepared[0]).toContain('applied_model = ?');
    expect(prepared[0]).toContain('applied_effort = ?');
    // params: [model, effort, id]
    expect(runParams[0]).toEqual(['opus', 'xhigh', 'session-1']);
  });

  it('persists null (agent default) rather than skipping it', () => {
    const { db, runParams } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    repo.updateAppliedSettings('session-1', { model: null, effort: null });

    expect(runParams[0]).toEqual([null, null, 'session-1']);
  });

  it('is a no-op (no SQL prepared) when neither field is provided', () => {
    const { db, prepared } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    repo.updateAppliedSettings('session-1', {});

    expect(prepared).toHaveLength(0);
  });

  it('distinguishes an absent field from a null one (partial update)', () => {
    const { db, prepared, runParams } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    // effort absent -> not written; model explicitly null -> written as null.
    repo.updateAppliedSettings('session-1', { model: null });

    expect(prepared[0]).toContain('applied_model = ?');
    expect(prepared[0]).not.toContain('applied_effort');
    expect(runParams[0]).toEqual([null, 'session-1']);
  });
});

describe('SessionRepository.insert applied_* defaults', () => {
  it('returns applied_model and applied_effort as null (set later via updateAppliedSettings)', () => {
    const { db } = createCapturingMockDb();
    const repo = new SessionRepository(db);

    const record = repo.insert({
      id: 'session-1',
      task_id: 'task-1',
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: 'agent-1',
      command: 'claude',
      cwd: '/project',
      permission_mode: null,
      prompt: null,
      status: 'running',
      exit_code: null,
      started_at: '2026-06-12T00:00:00Z',
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
    });

    expect(record.applied_model).toBeNull();
    expect(record.applied_effort).toBeNull();
  });
});
