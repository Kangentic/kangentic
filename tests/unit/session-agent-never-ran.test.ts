/**
 * `sessions.agent_never_ran_at` marks the record whose fresh launch minted its
 * agent session id and ended, or waits queued, with its CLI never run (Sentry
 * DESKTOP-2M). No conversation exists under that id, so the resume check starts
 * it fresh instead of a `--resume` that prints "No conversation found".
 *
 * Runs the real migrations, the real `SessionRepository` and the real resume
 * check over an in-memory database, with the lineage read from the rows the way
 * both spawn chokepoints read it (`resolveResumeLineage`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { promoteRecord, retireRecord } from '../../src/main/transition-engine/session-lifecycle';
import {
  assessResumeConversationWithEvidence,
  resolveResumeLineage,
} from '../../src/main/transition-engine/resume-conversation-guard';
import { proveClaudeConversationGone } from '../../src/main/agent/adapters/claude/conversation-gone';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { runProjectMigrations } from '../../src/main/db/migrations';
import {
  NEVER_RAN_AGENT_SESSION_ID as AGENT_SESSION_ID,
  neverRanBaseRow,
  openProjectDatabase,
  readNeverRanAt,
} from './helpers/never-ran-project-db';

const BASE_ROW = neverRanBaseRow('running');

describe('sessions.agent_never_ran_at', () => {
  it('is added in place to a sessions table made before it, and a second run changes nothing', () => {
    const database = openProjectDatabase();
    new SessionRepository(database).insert({ ...BASE_ROW, id: 'session-old' });
    database.exec('ALTER TABLE sessions DROP COLUMN agent_never_ran_at');

    runProjectMigrations(database);
    const columns = (database.pragma('table_info(sessions)') as Array<{ name: string; type: string; dflt_value: string | null }>)
      .filter((column) => column.name === 'agent_never_ran_at');
    expect(columns).toEqual([expect.objectContaining({ type: 'TEXT', dflt_value: 'NULL' })]);
    expect(readNeverRanAt(database, 'session-old')).toBeNull();

    expect(() => runProjectMigrations(database)).not.toThrow();
  });

  it('reads null on a new record', () => {
    const inserted = new SessionRepository(openProjectDatabase()).insert({ ...BASE_ROW, id: 'session-new' });
    expect(inserted.agent_never_ran_at).toBeNull();
  });
});

describe('SessionRepository.markAgentNeverRan', () => {
  it('marks the record that minted its id, with a UTC ISO time', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-fresh' });

    expect(repository.markAgentNeverRan('session-fresh')).toBe(true);
    const stamp = readNeverRanAt(database, 'session-fresh');
    expect(new Date(stamp as string).toISOString()).toBe(stamp);
  });

  it('never marks a record that shares its id with another, as every resume does', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-fresh' });
    repository.insert({ ...BASE_ROW, id: 'session-resume', started_at: '2026-01-01T00:00:05.000Z' });

    expect(repository.markAgentNeverRan('session-resume')).toBe(false);
    expect(readNeverRanAt(database, 'session-resume')).toBeNull();
  });

  it('still marks a record when a row of a different task holds the same agent session id', () => {
    const database = openProjectDatabase();
    database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-2', 2, 'Other', '', 'lane-1', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-other-task', task_id: 'task-2' });
    repository.insert({ ...BASE_ROW, id: 'session-fresh' });

    expect(repository.markAgentNeverRan('session-fresh')).toBe(true);
    expect(readNeverRanAt(database, 'session-fresh')).not.toBeNull();
  });

  it('never marks a record with no agent session id', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-no-id', agent_session_id: null });

    expect(repository.markAgentNeverRan('session-no-id')).toBe(false);
  });

  it('keeps the first time on a second mark', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-fresh' });
    repository.markAgentNeverRan('session-fresh');
    const first = readNeverRanAt(database, 'session-fresh');

    expect(repository.markAgentNeverRan('session-fresh')).toBe(false);
    expect(readNeverRanAt(database, 'session-fresh')).toBe(first);
  });

  it('comes off when a queued record is promoted, since its CLI is starting', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-queued', status: 'queued' });
    repository.markAgentNeverRan('session-queued');

    expect(promoteRecord(repository, 'session-queued')).toBe(true);
    expect(readNeverRanAt(database, 'session-queued')).toBeNull();
  });

  it('stays on when the promotion does not happen', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-suspended', status: 'suspended' });
    repository.markAgentNeverRan('session-suspended');

    expect(promoteRecord(repository, 'session-suspended')).toBe(false);
    expect(readNeverRanAt(database, 'session-suspended')).not.toBeNull();
  });
});

// A crash runs no exit listener and no quit path, so the orphan sweeps are not a
// place the mark is written or lost. They only change the status.
describe('the crash recovery orphan sweeps', () => {
  function statusOf(database: ReturnType<typeof openProjectDatabase>, id: string): string {
    return (database.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string }).status;
  }

  it('keep the mark a queued record was written with, so a crash leaves it never-ran', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-queued', status: 'queued' });
    repository.markAgentNeverRan('session-queued');
    const stamp = readNeverRanAt(database, 'session-queued');

    repository.markAllRunningAsOrphaned();

    expect(statusOf(database, 'session-queued')).toBe('orphaned');
    expect(readNeverRanAt(database, 'session-queued')).toBe(stamp);
  });

  it('do not mark a running record, whose CLI may have run before the crash', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-running' });

    repository.markAllRunningAsOrphaned();

    expect(statusOf(database, 'session-running')).toBe('orphaned');
    expect(readNeverRanAt(database, 'session-running')).toBeNull();
  });

  it('do not mark through the exclusion form either, and keep a mark already there', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-running' });
    database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-2', 2, 'Other', '', 'lane-1', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    repository.insert({ ...BASE_ROW, id: 'session-queued', task_id: 'task-2', status: 'queued' });
    repository.markAgentNeverRan('session-queued');

    repository.markRunningAsOrphanedExcluding(new Set(['task-3']));

    expect(statusOf(database, 'session-running')).toBe('orphaned');
    expect(readNeverRanAt(database, 'session-running')).toBeNull();
    expect(statusOf(database, 'session-queued')).toBe('orphaned');
    expect(readNeverRanAt(database, 'session-queued')).not.toBeNull();
  });
});

describe('the resume check over real rows', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-never-ran-'));
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  const claudeShapedAdapter = {
    runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
    proveConversationGone: proveClaudeConversationGone,
  } as unknown as AgentAdapter;

  function assessFor(repository: SessionRepository, retiringRecordId: string) {
    const { lineage } = resolveResumeLineage({
      taskRecords: repository.listForTaskNewestFirst('task-1'),
      retiringRecordId,
      resumedAgentSessionId: AGENT_SESSION_ID,
    });
    return assessResumeConversationWithEvidence({
      adapter: claudeShapedAdapter,
      agentSessionId: AGENT_SESSION_ID,
      records: lineage,
      cwd: path.join(projectPath, 'worktree'),
      projectPath,
    });
  }

  // The shape the Ubuntu event fits: a fresh launch that ended before its typed
  // line ran, no path on any row and no session folder, then a Resume.
  it('starts a suspended never-ran launch fresh, owing its prompt', async () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-fresh', status: 'suspended', suspended_by: 'system' });
    repository.markAgentNeverRan('session-fresh');

    const assessment = await assessFor(repository, 'session-fresh');
    expect(assessment).toMatchObject({ verdict: 'never-started', promptOwed: true });
    expect(assessment.evidence).toMatchObject({ turns: 'no', agentReport: 'none', transcript: 'not_reported' });
  });

  // The heal: a resume of it that failed before this fix left a newer record.
  it('starts it fresh past a resume of it that failed since', async () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-fresh', status: 'suspended' });
    repository.markAgentNeverRan('session-fresh');
    retireRecord(repository, 'session-fresh');
    repository.insert({ ...BASE_ROW, id: 'session-resume', prompt: null, status: 'suspended', started_at: '2026-01-01T00:00:05.000Z' });

    expect((await assessFor(repository, 'session-resume')).verdict).toBe('never-started');
  });

  it('still resumes the same rows with no mark', async () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-fresh', status: 'suspended' });

    expect((await assessFor(repository, 'session-fresh')).verdict).toBe('unknown');
  });
});
