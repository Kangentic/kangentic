/**
 * EMPIRICAL validation of SessionRepository.getInterruptedExited() against a
 * REAL SQLite engine (node:sqlite), executing the actual production method.
 *
 * session-repository-interrupted-exited.test.ts only string-asserts the SQL
 * (better-sqlite3 cannot load in vitest). This suite proves the SQL SEMANTICS -
 * the cross-platform predicate, the latest-in-group MAX(started_at) subquery,
 * and the null-safe `IS` isolation match - by running the same SQLite dialect
 * over incident-shaped rows.
 *
 * node:sqlite is built-in on Node 22.5+ but may need --experimental-sqlite on
 * some builds; this suite skips where it is unavailable (e.g. the Node 22 CI
 * runner without the flag). The string-assertion test is the CI regression
 * guard; this is the dev-machine semantic check.
 */

import { describe, it, expect } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

// id, task_id, session_type, isolated_swimlane_id, agent_session_id, status, exit_code, started_at
type SeedRow = [string, string, string, string | null, string | null, string, number | null, string];

const SEED_ROWS: SeedRow[] = [
  // Abnormal codes, latest in group, valid agent id -> RETURNED (cross-platform)
  ['rA', 'T1', 'claude', null, 'a1', 'exited', 1073807364, '2026-06-06T05:00:00Z'], // Windows hard-kill
  ['rB', 'T2', 'claude', null, 'a2', 'exited', 137, '2026-06-06T05:00:00Z'], // Unix SIGKILL
  ['rC', 'T3', 'claude', null, 'a3', 'exited', 143, '2026-06-06T05:00:00Z'], // Unix SIGTERM
  ['rD', 'T4', 'claude', null, 'a4', 'exited', 130, '2026-06-06T05:00:00Z'], // Unix SIGINT
  // Excluded by the predicate
  ['rE', 'T5', 'claude', null, 'a5', 'exited', 0, '2026-06-06T05:00:00Z'], // clean exit 0
  ['rF', 'T6', 'claude', null, 'a6', 'exited', null, '2026-06-06T05:00:00Z'], // null exit code
  ['rG', 'T7', 'claude', null, null, 'exited', 137, '2026-06-06T05:00:00Z'], // no agent_session_id
  ['rH', 'T8', 'run_script', null, 'a8', 'exited', 137, '2026-06-06T05:00:00Z'], // run_script
  // T9: older abnormal exited shadowed by a NEWER suspended record -> none returned
  ['rI1', 'T9', 'claude', null, 'i1', 'exited', 137, '2026-06-06T01:00:00Z'],
  ['rI2', 'T9', 'claude', null, 'i2', 'suspended', null, '2026-06-06T09:00:00Z'],
  // T10: older abnormal exited shadowed by a NEWER clean exit -> none returned
  ['rJ1', 'T10', 'claude', null, 'j1', 'exited', 137, '2026-06-06T01:00:00Z'],
  ['rJ2', 'T10', 'claude', null, 'j2', 'exited', 0, '2026-06-06T09:00:00Z'],
  // T11: main + isolated abnormal, each latest in its own group -> BOTH returned
  ['rK1', 'T11', 'claude', null, 'k1', 'exited', 137, '2026-06-06T05:00:00Z'],
  ['rK2', 'T11', 'claude', 'laneR', 'k2', 'exited', 137, '2026-06-06T05:00:00Z'],
  // T12: newer abnormal is latest (older clean exit ignored) -> newer returned
  ['rL1', 'T12', 'claude', null, 'l1', 'exited', 0, '2026-06-06T01:00:00Z'],
  ['rL2', 'T12', 'claude', null, 'l2', 'exited', 137, '2026-06-06T09:00:00Z'],
];

const EXPECTED_RETURNED = ['rA', 'rB', 'rC', 'rD', 'rK1', 'rK2', 'rL2'].sort();

describeWithSqlite('getInterruptedExited (real SQLite via node:sqlite)', () => {
  function seededRepo(): SessionRepository {
    const db = new sqlite!.DatabaseSync(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, task_id TEXT, session_type TEXT, isolated_swimlane_id TEXT,
      agent_session_id TEXT, command TEXT, cwd TEXT, status TEXT, exit_code INTEGER,
      started_at TEXT
    )`);
    const insert = db.prepare(`INSERT INTO sessions
      (id, task_id, session_type, isolated_swimlane_id, agent_session_id, command, cwd, status, exit_code, started_at)
      VALUES (?, ?, ?, ?, ?, 'c', '/p', ?, ?, ?)`);
    for (const row of SEED_ROWS) insert.run(...row);
    // The constructor only stores the db; getInterruptedExited uses
    // prepare(sql).all(), which node:sqlite supports identically.
    return new SessionRepository(db as never);
  }

  it('returns exactly the abnormal, resumable, latest-in-group records', () => {
    const ids = seededRepo()
      .getInterruptedExited()
      .map((record) => record.id)
      .sort();
    expect(ids).toEqual(EXPECTED_RETURNED);
  });

  it('excludes clean exit 0, null codes, missing agent id, and run_script', () => {
    const ids = new Set(seededRepo().getInterruptedExited().map((record) => record.id));
    expect(ids.has('rE')).toBe(false); // clean exit 0
    expect(ids.has('rF')).toBe(false); // null code
    expect(ids.has('rG')).toBe(false); // no agent_session_id
    expect(ids.has('rH')).toBe(false); // run_script
  });

  it('drops an older abnormal row shadowed by a newer record (suspended or clean exit)', () => {
    const ids = new Set(seededRepo().getInterruptedExited().map((record) => record.id));
    expect(ids.has('rI1')).toBe(false); // shadowed by newer suspended
    expect(ids.has('rJ1')).toBe(false); // shadowed by newer clean exit
    expect(ids.has('rL2')).toBe(true); // newer abnormal IS the latest -> returned
  });

  it('treats main and isolated tracks as separate groups (null-safe IS)', () => {
    const ids = new Set(seededRepo().getInterruptedExited().map((record) => record.id));
    expect(ids.has('rK1')).toBe(true); // main (isolation NULL)
    expect(ids.has('rK2')).toBe(true); // isolated (isolation 'laneR')
  });

  /**
   * The agent-absence sweep retires a session whose agent CLI exited while its
   * shell PTY survived, by force-killing that shell. A force-kill reports an
   * ABNORMAL code on every platform - which this query resumes on the next
   * launch. So `retireAgentlessSession` forces the reported code to 0
   * (`ManagedSession.overrideExitCode`), because the agent's own exit was
   * normal and Kangentic is only noticing it late.
   *
   * This proves the coupling rather than assuming it: the same retirement is
   * seeded under both designs, and only the un-overridden one comes back.
   * Without the override, the sweep would resurrect exactly the conversation
   * the user `/exit`-ed - the behavior the "clean exit 0 is excluded" rule
   * exists to prevent.
   */
  it('does not resurrect an agent-absence retirement, but WOULD at the raw force-kill code', () => {
    const db = new sqlite!.DatabaseSync(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, task_id TEXT, session_type TEXT, isolated_swimlane_id TEXT,
      agent_session_id TEXT, command TEXT, cwd TEXT, status TEXT, exit_code INTEGER,
      started_at TEXT
    )`);
    const insert = db.prepare(`INSERT INTO sessions
      (id, task_id, session_type, isolated_swimlane_id, agent_session_id, command, cwd, status, exit_code, started_at)
      VALUES (?, ?, 'claude', NULL, ?, 'c', '/p', 'exited', ?, '2026-08-17T05:00:00Z')`);
    // What the sweep actually writes: overrideExitCode = 0.
    insert.run('retired-with-override', 'TASK-A', 'agent-a', 0);
    // The counterfactual: the same retirement reporting the OS force-kill code.
    insert.run('retired-without-override', 'TASK-B', 'agent-b', 1073807364);

    const ids = new SessionRepository(db as never)
      .getInterruptedExited()
      .map((record) => record.id);

    expect(ids).toEqual(['retired-without-override']);
  });
});
