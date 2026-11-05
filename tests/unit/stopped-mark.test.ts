/**
 * The read `agent-stopped` is drawn from (src/main/automations/stopped-mark.ts).
 * A person loses a stopped card if this reads no, and trusts the pennant less if
 * it reads yes on a card that recovery can still clear. The run log is the real
 * repository on a real database, so a restart reads what a live pass wrote.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { openTestDatabase } from './helpers/test-database';

const hoisted = vi.hoisted(() => ({ repos: null as unknown }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn(() => hoisted.repos) }));

const { refreshStoppedMark } = await import('../../src/main/automations/stopped-mark');

const TASK_ID = 'task-1';
const COLUMN_ID = 'lane-1';
const WORKFLOW_ID = 'workflow-1';

describe('refreshStoppedMark', () => {
  let directory: string;
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let task: { id: string; swimlane_id: string; archived_at: string | null; workflow_id: string | null };
  let visitStartedAt: string | null;
  const setTaskStopped = vi.fn();
  const context = { sessionManager: { setTaskStopped } } as unknown as IpcContext;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-mark-'));
    database = openTestDatabase(path.join(directory, 'project.db'));
    runProjectMigrations(database);
    database.pragma('foreign_keys = OFF');
    runs = new AutomationRunRepository(database);
  });

  beforeEach(() => {
    database.prepare('DELETE FROM automation_runs').run();
    setTaskStopped.mockClear();
    task = { id: TASK_ID, swimlane_id: COLUMN_ID, archived_at: null, workflow_id: null };
    visitStartedAt = null;
    hoisted.repos = {
      tasks: { getById: () => task },
      taskMoves: { visitStartedAt: () => visitStartedAt },
      automationRuns: runs,
    };
  });

  afterAll(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const refresh = () => refreshStoppedMark(context, 'project-1', TASK_ID);

  it('reads no for a card nothing stopped', () => {
    refresh();
    expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, null);
  });

  it('reads yes for a stop in this visit, from the log alone, as a restart does', () => {
    runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: COLUMN_ID, cause: 'spent-row', reason: 'Spent.' });
    refresh();
    expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, 'visit');
  });

  it('reads no once the card has left the column the stop was in', () => {
    runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: COLUMN_ID, cause: 'spent-row', reason: 'Spent.' });
    task.swimlane_id = 'lane-2';
    refresh();
    expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, null);
  });

  it('reads no in a later visit to the same column', () => {
    runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: COLUMN_ID, cause: 'spent-row', reason: 'Spent.' });
    visitStartedAt = new Date(Date.now() + 60_000).toISOString();
    refresh();
    expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, null);
  });

  it('reads no for an archived task', () => {
    runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: COLUMN_ID, cause: 'spent-row', reason: 'Spent.' });
    task.archived_at = new Date().toISOString();
    refresh();
    expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, null);
  });

  describe('a workflow task', () => {
    beforeEach(() => {
      task.workflow_id = WORKFLOW_ID;
    });

    it('reads yes while it waits on its owner', () => {
      runs.recordWorkflowWaiting({ taskId: TASK_ID, swimlaneId: COLUMN_ID, workflowId: WORKFLOW_ID, reason: 'Which database?' });
      refresh();
      expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, 'turn');
    });

    it('reads yes once its recovery ran out', () => {
      database.prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(TASK_ID, 'A stalled task', '', COLUMN_ID, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      runs.recordWorkflowStall({ taskId: TASK_ID, swimlaneId: COLUMN_ID, workflowId: WORKFLOW_ID, reason: 'It stopped.', countedNudges: 4 });
      refresh();
      expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, 'turn');
      database.prepare('DELETE FROM tasks WHERE id = ?').run(TASK_ID);
    });

    it('reads no while recovery can still clear it: nothing recorded a wait or a stall', () => {
      runs.recordWorkflowStep({ taskId: TASK_ID, swimlaneId: COLUMN_ID, workflowId: WORKFLOW_ID, met: false, reason: 'Not done.', detail: 'Not done.' });
      refresh();
      expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, null);
    });

    it('never asks a task that is not a workflow\'s whether it waits or stalled', () => {
      task.workflow_id = null;
      runs.recordWorkflowWaiting({ taskId: TASK_ID, swimlaneId: COLUMN_ID, workflowId: WORKFLOW_ID, reason: 'Old.' });
      refresh();
      expect(setTaskStopped).toHaveBeenCalledWith(TASK_ID, null);
    });
  });

  it('leaves the mark alone when the read fails, since a move must not fail on it', () => {
    hoisted.repos = { tasks: { getById: () => { throw new Error('closed'); } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(refresh).not.toThrow();
    expect(setTaskStopped).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
