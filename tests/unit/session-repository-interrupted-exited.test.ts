/**
 * Tests for SessionRepository.getInterruptedExited() - the OS-killed ("hard
 * shutdown") session gather used by startup recovery.
 *
 * A hard shutdown (OS restart, power loss, SIGKILL) kills the PTY before the
 * clean-quit path marks the record 'suspended', so the onExit handler records
 * it 'exited' with an abnormal code (Windows 1073807364, Unix 137/143/130).
 * Those rows are invisible to getResumable()/getOrphaned(); getInterruptedExited
 * surfaces them so recovery resumes the conversation instead of spawning a fresh
 * empty session.
 *
 * This is the authoritative guard for the CROSS-PLATFORM abnormal-exit
 * predicate: it must treat every OS's kill code uniformly via `exit_code != 0`
 * and must NOT be keyed to any specific code (the 2026-06-06 incident recorded
 * the Windows code 1073807364, but the same fix must catch Unix 137/143/130).
 *
 * Uses a mock database that tracks the executed SQL (the same approach as
 * session-repository-orphan.test.ts), so the tests pin the statements issued.
 * `tests/unit/helpers/test-database.ts` opens a real database if one is wanted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type Database from 'better-sqlite3';

/** Create a mock better-sqlite3 Database that tracks executed SQL. */
function createMockDb() {
  const executedStatements: Array<{ sql: string; params: unknown[] }> = [];

  const mockStatement = {
    run: vi.fn((...params: unknown[]) => {
      executedStatements[executedStatements.length - 1].params = params;
      return { changes: 1 };
    }),
    get: vi.fn(),
    all: vi.fn((...params: unknown[]) => {
      executedStatements[executedStatements.length - 1].params = params;
      return [];
    }),
  };

  const mockDb = {
    prepare: vi.fn((sql: string) => {
      executedStatements.push({ sql, params: [] });
      return mockStatement;
    }),
  } as unknown as Database.Database;

  return { mockDb, executedStatements, mockStatement };
}

describe('SessionRepository.getInterruptedExited', () => {
  let mockDb: Database.Database;
  let executedStatements: Array<{ sql: string; params: unknown[] }>;
  let repo: SessionRepository;

  beforeEach(() => {
    const mock = createMockDb();
    mockDb = mock.mockDb;
    executedStatements = mock.executedStatements;
    repo = new SessionRepository(mockDb);
  });

  it('selects only abnormally-exited, resumable records', () => {
    repo.getInterruptedExited();

    expect(executedStatements).toHaveLength(1);
    const sql = executedStatements[0].sql;
    expect(sql).toContain("status = 'exited'");
    expect(sql).toContain("session_type != 'run_script'");
    expect(sql).toContain('agent_session_id IS NOT NULL');
  });

  it('uses the cross-platform abnormal predicate (exit_code != 0), not a hardcoded code', () => {
    repo.getInterruptedExited();
    const sql = executedStatements[0].sql;

    // Abnormal = any non-null, non-zero code. This treats every OS's kill code
    // uniformly, so it must be expressed as a comparison, never an enumeration.
    expect(sql).toContain('exit_code IS NOT NULL');
    expect(sql).toContain('exit_code != 0');

    // Regression guard: must NOT be keyed to the Windows code from the incident
    // or to any Unix signal code. If a future edit hardcodes a code, this fails.
    for (const code of ['1073807364', '137', '143', '130']) {
      expect(sql).not.toContain(code);
    }
  });

  it('clean exit 0 is excluded (startup never resurrects a deliberate /exit)', () => {
    repo.getInterruptedExited();
    const sql = executedStatements[0].sql;
    // The `!= 0` predicate is what excludes a clean exit; assert it is present
    // and that the query does not loosen to `>= 0` or drop the comparison.
    expect(sql).toContain('exit_code != 0');
    expect(sql).not.toContain('exit_code >= 0');
  });

  it('returns only the latest record per (task, session_type, isolation) group', () => {
    repo.getInterruptedExited();
    const sql = executedStatements[0].sql;
    // Latest-in-group subquery prevents resurrecting an older abnormal session
    // that a newer record of ANY status (e.g. a later clean exit) has shadowed.
    expect(sql).toContain('MAX(s2.started_at)');
    expect(sql).toContain('s2.task_id = s.task_id');
    expect(sql).toContain('s2.session_type = s.session_type');
    // `IS` (not `=`) for the isolation match so NULL (main) folds correctly.
    expect(sql).toContain('s2.isolated_swimlane_id IS s.isolated_swimlane_id');
  });
});
