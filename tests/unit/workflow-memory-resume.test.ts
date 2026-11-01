/**
 * The workflow's memory resume (src/main/workflows/workflow-memory-resume.ts):
 * a running workflow's memory-paused tasks come back by themselves once memory
 * recovers, one at a time, through the Resume button's own path. Overnight two
 * idle workflow agents paused for memory sat until morning with memory long back.
 *
 * Real SQLite (the session, task and run rows), the real gate; the resume
 * itself is mocked, since it spawns an agent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { registerResumeController, releaseResumeController } from '../../src/main/ipc/handlers/session-resume-controllers';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Swimlane } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';
import { GIBIBYTE, windowsSample } from './helpers/host-memory-sample';

const hoisted = vi.hoisted(() => ({
  database: null as unknown,
  workflowState: 'running',
  resumeTaskSession: vi.fn(),
  announceWorkflowStall: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({ getOpenProjectDb: vi.fn(() => hoisted.database) }));
vi.mock('../../src/main/ipc/handlers/session-resume', () => ({ resumeTaskSession: hoisted.resumeTaskSession }));
vi.mock('../../src/main/workflows/workflow-recovery', () => ({
  announceWorkflowStall: hoisted.announceWorkflowStall,
  workflowTaskGateKey: (taskId: string) => `task:${taskId}`,
}));
vi.mock('../../src/main/workflows/workflow-step', () => ({
  workflowStepApplies: vi.fn((task: { workflow_id: string | null }) => task.workflow_id !== null && hoisted.workflowState === 'running'),
}));

const { resumeMemoryPausedWorkflowTasks, resetWorkflowMemoryResumeForTests, MAX_AUTO_RESUMES_PER_DAY } = await import('../../src/main/workflows/workflow-memory-resume');
const { workflowMemoryGate, PACE_MS } = await import('../../src/main/workflows/workflow-memory-gate');

const PROJECT_ID = 'project-1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('resumeMemoryPausedWorkflowTasks', () => {
  let database: DatabaseType.Database;
  let workingLane: Swimlane;
  let context: IpcContext;
  let freeSlots: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T04:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.workflowState = 'running';
    hoisted.resumeTaskSession.mockReset();
    // As the real resume does, the task's paused session runs again.
    hoisted.resumeTaskSession.mockImplementation(async (_context: unknown, taskId: string) => {
      database.prepare("UPDATE sessions SET status = 'running', suspended_by = NULL WHERE task_id = ?").run(taskId);
      return { id: `resumed-${taskId}` };
    });
    hoisted.announceWorkflowStall.mockReset();
    resetWorkflowMemoryResumeForTests();
    workflowMemoryGate.resetForTests();

    database = openTestDatabase();
    runProjectMigrations(database);
    hoisted.database = database;
    workingLane = new SwimlaneRepository(database).list().find((lane) => lane.role === null)!;
    freeSlots = 4;
    context = {
      projectRepo: { list: () => [{ id: PROJECT_ID }] },
      sessionManager: { getFreeAgentSlots: () => freeSlots },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** One sampler tick's pass over the paused tasks. */
  function tick(): Promise<void> {
    return resumeMemoryPausedWorkflowTasks(context);
  }

  function laneWithRole(role: 'todo' | 'done'): Swimlane {
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.role === role);
    if (!lane) throw new Error(`The test board has no ${role} column.`);
    return lane;
  }

  /** The task's session paused for memory again, as of the fake clock's now. */
  function pauseForMemoryNow(taskId: string): void {
    database
      .prepare("UPDATE sessions SET status = 'suspended', suspended_by = 'low_memory', suspended_at = ? WHERE task_id = ?")
      .run(new Date(Date.now()).toISOString(), taskId);
  }

  /** A task whose latest session was paused for memory at `pausedAt`. */
  function memoryPausedTask(
    taskId: string,
    pausedAt: string,
    options: { workflowId?: string | null; suspendedBy?: string; swimlaneId?: string; archivedAt?: string } = {},
  ): void {
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, workflow_id, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, `Task ${taskId}`, '', options.swimlaneId ?? workingLane.id, 0, options.workflowId === undefined ? 'workflow-1' : options.workflowId, options.archivedAt ?? null, pausedAt, pausedAt);
    database
      .prepare(`INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at, suspended_at, suspended_by)
        VALUES (?, ?, 'claude_agent', ?, 'claude', '/work', 'suspended', ?, ?, ?)`)
      .run(`session-${taskId}`, taskId, `agent-${taskId}`, '2026-10-31T00:00:00.000Z', pausedAt, options.suspendedBy ?? 'low_memory');
  }

  it('resumes the task paused longest, through the Resume path, marked as a memory resume', async () => {
    memoryPausedTask('task-late', '2026-10-31T02:00:00.000Z');
    memoryPausedTask('task-early', '2026-10-31T01:00:00.000Z');

    await resumeMemoryPausedWorkflowTasks(context);

    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);
    expect(hoisted.resumeTaskSession).toHaveBeenCalledWith(context, 'task-early', expect.objectContaining({ projectId: PROJECT_ID, resumedBy: 'memory' }));
  });

  it('brings them back one at a time: the next waits for the gate', async () => {
    memoryPausedTask('task-a', '2026-10-31T01:00:00.000Z');
    memoryPausedTask('task-b', '2026-10-31T01:05:00.000Z');

    await resumeMemoryPausedWorkflowTasks(context);
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);

    // Its turn is under way, and a sampler tick later the next one goes.
    workflowMemoryGate.noteThinking('resumed-task-a');
    vi.advanceTimersByTime(MINUTE);
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-b', expect.anything());
  });

  it('resumes nothing while memory reads low, or with no agent slot free', async () => {
    memoryPausedTask('task-a', '2026-10-31T01:00:00.000Z');
    workflowMemoryGate.onSample(windowsSample(1 * GIBIBYTE));
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();

    workflowMemoryGate.onSample(windowsSample(8 * GIBIBYTE));
    freeSlots = 0;
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();

    freeSlots = 1;
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);
  });

  it('keeps #873\'s rule outside a workflow, and for a paused workflow or another kind of pause', async () => {
    memoryPausedTask('task-alone', '2026-10-31T01:00:00.000Z', { workflowId: null });
    memoryPausedTask('task-idle-timeout', '2026-10-31T01:00:00.000Z', { suspendedBy: 'auto' });
    memoryPausedTask('task-user', '2026-10-31T01:00:00.000Z', { suspendedBy: 'user' });
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();

    memoryPausedTask('task-in-workflow', '2026-10-31T01:00:00.000Z');
    hoisted.workflowState = 'paused';
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();
  });

  it('leaves a task waiting on the owner paused: it would only idle again', async () => {
    memoryPausedTask('task-asks', '2026-10-31T01:00:00.000Z');
    database
      .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), 'task-asks', null, workingLane.id, 'workflow', null, '2026-10-31T00:30:00.000Z');
    new AutomationRunRepository(database).recordWorkflowWaiting({
      taskId: 'task-asks', swimlaneId: workingLane.id, workflowId: 'workflow-1', reason: 'keep the old export?',
    });

    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();
  });

  it('backs off a task paused again soon after an auto-resume, and stops after a day\'s worth', async () => {
    memoryPausedTask('task-a', '2026-10-31T04:00:00.000Z');
    let resumes = 0;
    const pauseAgainSoon = (): void => {
      workflowMemoryGate.resetForTests();
      database
        .prepare("UPDATE sessions SET status = 'suspended', suspended_by = 'low_memory', suspended_at = ? WHERE task_id = 'task-a'")
        .run(new Date(Date.now() + 5 * MINUTE).toISOString());
      vi.advanceTimersByTime(5 * MINUTE);
    };

    await resumeMemoryPausedWorkflowTasks(context);
    resumes += 1;
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(resumes);

    // Paused again five minutes on: it waits half an hour from that pause.
    pauseAgainSoon();
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(resumes);
    vi.advanceTimersByTime(30 * MINUTE);
    await resumeMemoryPausedWorkflowTasks(context);
    resumes += 1;
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(resumes);

    // Again: an hour this time, then the third and last.
    pauseAgainSoon();
    vi.advanceTimersByTime(60 * MINUTE);
    await resumeMemoryPausedWorkflowTasks(context);
    resumes += 1;
    expect(resumes).toBe(MAX_AUTO_RESUMES_PER_DAY);
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(resumes);

    // Past the day's count it stays paused for the user, with one notice.
    pauseAgainSoon();
    vi.advanceTimersByTime(4 * 60 * MINUTE);
    await resumeMemoryPausedWorkflowTasks(context);
    await resumeMemoryPausedWorkflowTasks(context);
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(resumes);
    expect(hoisted.announceWorkflowStall).toHaveBeenCalledTimes(1);
    expect(hoisted.announceWorkflowStall).toHaveBeenCalledWith(context, expect.objectContaining({
      taskId: 'task-a',
      reason: expect.stringContaining('stays paused until you resume it'),
    }));
  });

  it('lets a task past its day\'s limit come back once its oldest auto-resume is a day old, and tells the owner again at the next limit', async () => {
    const startMs = Date.now();
    memoryPausedTask('task-a', new Date(startMs).toISOString());

    // The day's worth: one auto-resume an hour apart, each paused again an hour on.
    await tick();
    for (let resume = 2; resume <= MAX_AUTO_RESUMES_PER_DAY; resume += 1) {
      vi.advanceTimersByTime(HOUR);
      pauseForMemoryNow('task-a');
      await tick();
    }
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(MAX_AUTO_RESUMES_PER_DAY);

    // At the limit it stays paused, and the owner is told once.
    vi.advanceTimersByTime(HOUR);
    pauseForMemoryNow('task-a');
    await tick();
    await tick();
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(MAX_AUTO_RESUMES_PER_DAY);
    expect(hoisted.announceWorkflowStall).toHaveBeenCalledTimes(1);

    // A minute short of a day after the first auto-resume: still the day's worth.
    vi.setSystemTime(startMs + 24 * HOUR - MINUTE);
    await tick();
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(MAX_AUTO_RESUMES_PER_DAY);

    // The first has aged out: the task comes back.
    vi.setSystemTime(startMs + 24 * HOUR + MINUTE);
    await tick();
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(MAX_AUTO_RESUMES_PER_DAY + 1);

    // And the next time it reaches the limit the owner is told again: the notice
    // was only held back until a day's resumes aged out.
    vi.advanceTimersByTime(MINUTE);
    pauseForMemoryNow('task-a');
    await tick();
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(MAX_AUTO_RESUMES_PER_DAY + 1);
    expect(hoisted.announceWorkflowStall).toHaveBeenCalledTimes(2);
  });

  describe('a resume that did not run', () => {
    /** The next resume fails the way a real one does: it throws, or it resolves null (cancelled, or no agent started). */
    const FAILURES = [
      ['throws', () => hoisted.resumeTaskSession.mockRejectedValueOnce(new Error('The worktree is missing.'))],
      ['resolves nothing', () => hoisted.resumeTaskSession.mockResolvedValueOnce(null)],
    ] as const;

    it('waits half an hour before the next try, doubled for each failure in a row, and never counts toward the day\'s limit', async () => {
      memoryPausedTask('task-a', '2026-10-31T04:00:00.000Z');
      hoisted.resumeTaskSession
        .mockRejectedValueOnce(new Error('The worktree is missing.'))
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('The worktree is missing.'));

      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);

      // After the first failure: half an hour.
      vi.advanceTimersByTime(29 * MINUTE);
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2 * MINUTE);
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(2);

      // After a second in a row: an hour.
      vi.advanceTimersByTime(59 * MINUTE);
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(2 * MINUTE);
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(3);

      // After a third: two hours.
      vi.advanceTimersByTime(119 * MINUTE);
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(2 * MINUTE);
      await tick();

      // Three failures counted as resumes would have reached the day's limit and
      // told the owner it stays paused. They did not: the fourth try ran.
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(4);
      expect(hoisted.announceWorkflowStall).not.toHaveBeenCalled();
    });

    it.each(FAILURES)('frees the gate at once when the resume %s, so the next task\'s resume is not held behind it', async (_label, failNextResume) => {
      memoryPausedTask('task-a', '2026-10-31T01:00:00.000Z');
      memoryPausedTask('task-b', '2026-10-31T02:00:00.000Z');
      failNextResume();

      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-a', expect.anything());

      // No time has passed: task-a waits out its retry, and task-b goes at once.
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(2);
      expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-b', expect.anything());
    });
  });

  describe('a resume that found the task\'s session already live', () => {
    /** A person's Resume got there first: the session runs, and this one started nothing. */
    function resumeFindsSessionLive(): void {
      hoisted.resumeTaskSession.mockImplementation(async (_context: unknown, taskId: string, options: { onAccepted?: (acceptance: 'live') => void }) => {
        options.onAccepted?.('live');
        return { id: `live-${taskId}` };
      });
    }

    it('counts nothing: the same task is tried again, past the day\'s limit, with no notice', async () => {
      memoryPausedTask('task-a', '2026-10-31T04:00:00.000Z');
      resumeFindsSessionLive();

      // Were these counted, the second would wait out the backoff of a pause soon
      // after an auto-resume, and the day's limit would end it with a notice.
      for (let attempt = 1; attempt <= MAX_AUTO_RESUMES_PER_DAY + 1; attempt += 1) {
        await tick();
        expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(attempt);
      }
      expect(hoisted.announceWorkflowStall).not.toHaveBeenCalled();
    });

    it('frees the gate at once, so the next task\'s resume is not held behind it', async () => {
      memoryPausedTask('task-a', '2026-10-31T01:00:00.000Z');
      memoryPausedTask('task-b', '2026-10-31T04:00:00.000Z');
      resumeFindsSessionLive();

      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-a', expect.anything());

      // Task-a's session is running, which is what live means, so task-b is next.
      // It goes at once if the gate is free, and would queue behind a held gate.
      database.prepare("UPDATE sessions SET status = 'running', suspended_by = NULL WHERE task_id = 'task-a'").run();
      await tick();
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(2);
      expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-b', expect.anything());
    });
  });

  it('skips a task whose Resume a person has under way, and takes it once that Resume has settled', async () => {
    memoryPausedTask('task-person', '2026-10-31T01:00:00.000Z');
    memoryPausedTask('task-other', '2026-10-31T02:00:00.000Z');
    const personsResume = new AbortController();
    registerResumeController('task-person', personsResume);
    try {
      await tick();

      // The older task is theirs: the other one goes, and their Resume is left alone.
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);
      expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-other', expect.anything());
      expect(personsResume.signal.aborted).toBe(false);
    } finally {
      releaseResumeController('task-person', personsResume);
    }

    // Their Resume settled and the task is still paused: it is the workflow's to bring back.
    workflowMemoryGate.noteThinking('resumed-task-other');
    vi.advanceTimersByTime(PACE_MS);
    await tick();
    expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(2);
    expect(hoisted.resumeTaskSession).toHaveBeenLastCalledWith(context, 'task-person', expect.anything());
  });

  // A resume waits its turn in the workflow's one queue, behind whatever is
  // loading the machine. A place it keeps there for a task it no longer wants
  // would hold the line until the gate dropped it unasked-for (three minutes).
  describe('a place in line the resume no longer asks for', () => {
    it.each([
      ['the task was resumed meanwhile', () => {
        database.prepare("UPDATE sessions SET status = 'running', suspended_by = NULL WHERE task_id = 'task-a'").run();
      }],
      ['the agent slots filled', () => {
        freeSlots = 0;
      }],
    ] as const)('leaves the line at once when %s, so the next in line goes', async (_label, makePlaceUnwanted) => {
      memoryPausedTask('task-a', '2026-10-31T01:00:00.000Z');
      // Another item, a recovery nudge, holds the gate: the resume has to wait in line.
      expect(workflowMemoryGate.tryAcquire('nudge:holder')).toEqual({ go: true });
      workflowMemoryGate.begin('nudge:holder', 'session-holder');
      await tick();
      expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();
      // Another task's place, behind the resume's.
      expect(workflowMemoryGate.tryAcquire('task:task-b')).toEqual({ go: false, why: 'queued' });

      makePlaceUnwanted();
      await tick();

      // The holder's turn is under way and the pace has passed. Within three
      // minutes, so a place kept in line would still be asked for and still first.
      workflowMemoryGate.noteThinking('session-holder');
      vi.advanceTimersByTime(PACE_MS);
      expect(workflowMemoryGate.tryAcquire('task:task-b')).toEqual({ go: true });
      expect(hoisted.resumeTaskSession).not.toHaveBeenCalled();
    });
  });

  describe('which paused tasks may come back', () => {
    const unwantedPlaces = [
      ['sits in a To Do column', () => ({ swimlaneId: laneWithRole('todo').id })],
      ['sits in a Done column', () => ({ swimlaneId: laneWithRole('done').id })],
      ['is archived', () => ({ archivedAt: '2026-10-31T02:00:00.000Z' })],
    ] as const;

    it.each(unwantedPlaces)('never resumes a task that %s, however long it has been paused', async (_label, placement) => {
      memoryPausedTask('task-unwanted', '2026-10-31T01:00:00.000Z', placement());
      memoryPausedTask('task-working', '2026-10-31T02:00:00.000Z');

      await tick();

      // The control is in a working column and was paused later: it is the one that goes.
      expect(hoisted.resumeTaskSession).toHaveBeenCalledTimes(1);
      expect(hoisted.resumeTaskSession).toHaveBeenCalledWith(context, 'task-working', expect.anything());
    });
  });
});
