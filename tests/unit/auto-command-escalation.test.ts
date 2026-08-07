/**
 * Rung 3 of the auto_command delivery ladder, exercised against the REAL
 * `restartSessionForSettingsChange`.
 *
 * Every other test of escalation stubs the handler with `async () => true`,
 * which proves the scheduler calls it but says nothing about whether the
 * command actually gets delivered. The concrete risk this file closes:
 * `applySuspendDbWrites` CLEARS `task.session_id` before the respawn, and the
 * function then re-reads the task to decide resume-vs-fresh. If the
 * `resumePrompt` were dropped anywhere along that path, escalation would be a
 * silent no-op that still reported success - the exact failure class this
 * whole rebuild exists to remove.
 *
 * `resumePrompt` is the 4th argument of `resumeSuspendedSession`, so asserting
 * on it tells us the command survived the suspend/re-read/respawn round trip.
 * Same harness shape as `spawn-agent-isolated-auto-command.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  resumeSuspendedSession: vi.fn(async () => {}),
  executeTransition: vi.fn(async () => {}),
  getProjectRepos: vi.fn(),
  applyProfileToLane: vi.fn((lane: unknown) => lane),
  loadTaskProfile: vi.fn(() => null),
  resolveSpawnOverrides: vi.fn(() => ({})),
  captureSessionMetrics: vi.fn(),
  markRecordSuspended: vi.fn(),
  markRecordExited: vi.fn(),
  decideSuspendDbAction: vi.fn(() => 'suspend' as const),
  isLiveSession: vi.fn(() => true),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: hoisted.getProjectRepos,
  createTransitionEngine: () => ({
    resumeSuspendedSession: hoisted.resumeSuspendedSession,
    executeTransition: hoisted.executeTransition,
  }),
  resolveSpawnOverrides: hoisted.resolveSpawnOverrides,
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
  },
}));
vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: hoisted.captureSessionMetrics,
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'main'),
}));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: hoisted.markRecordExited,
  markRecordSuspended: hoisted.markRecordSuspended,
}));
vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: hoisted.applyProfileToLane,
}));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: hoisted.loadTaskProfile,
}));
vi.mock('../../src/main/pty/session-registry', () => ({
  decideSuspendDbAction: hoisted.decideSuspendDbAction,
  isLiveSession: hoisted.isLiveSession,
}));

import { restartSessionForSettingsChange } from '../../src/main/ipc/handlers/session-reconcile';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const TASK_ID = 'task-1';
const SESSION_ID = 'sess-1';
const AUTO_COMMAND = '/code-review';

function makeHarness(): { context: IpcContext; suspend: ReturnType<typeof vi.fn> } {
  // The live task starts WITH a session id; applySuspendDbWrites clears it, so
  // the re-read must see the cleared row exactly as production does.
  let sessionId: string | null = SESSION_ID;
  const task = {
    get session_id(): string | null { return sessionId; },
    id: TASK_ID,
    title: 'Rebuild injection',
    swimlane_id: 'lane-1',
  };

  hoisted.getProjectRepos.mockReturnValue({
    tasks: {
      getById: vi.fn(() => task),
      update: vi.fn(),
      clearSessionId: vi.fn(() => { sessionId = null; }),
    },
    swimlanes: { getById: vi.fn(() => ({ id: 'lane-1', permission_mode: null })) },
    actions: {},
    attachments: {},
  });

  const suspend = vi.fn(async () => { sessionId = null; });
  const context = {
    sessionManager: {
      suspend,
      markIdleAuthoritative: vi.fn(),
      getSession: vi.fn(() => ({ status: 'running' })),
    },
    projectRepo: { getById: vi.fn(() => null) },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  } as unknown as IpcContext;

  return { context, suspend };
}

/** `resumePrompt` is the 4th positional arg of resumeSuspendedSession. */
function resumePromptArg(): unknown {
  return hoisted.resumeSuspendedSession.mock.calls[0]?.[3];
}

describe('auto_command escalation (rung 3): restart with the command as the prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.applyProfileToLane.mockImplementation((lane: unknown) => lane);
    hoisted.loadTaskProfile.mockReturnValue(null);
    hoisted.resolveSpawnOverrides.mockReturnValue({});
    hoisted.decideSuspendDbAction.mockReturnValue('suspend');
    hoisted.isLiveSession.mockReturnValue(true);
  });

  it('delivers the auto_command as the resume prompt, surviving the session_id clear', async () => {
    const { context, suspend } = makeHarness();

    const result = await restartSessionForSettingsChange(
      context,
      'proj-1',
      '/mock/project',
      TASK_ID,
      { resumePrompt: AUTO_COMMAND },
    );

    expect(result).toEqual({ ok: true });
    expect(suspend).toHaveBeenCalledWith(SESSION_ID);
    // The whole point: the command reached the spawn, not just the suspend.
    expect(hoisted.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(resumePromptArg()).toBe(AUTO_COMMAND);
  });

  it('still resumes idle for an ordinary settings-change restart', async () => {
    // The pre-existing contract: no prompt, no auto_command, resume parked.
    const { context } = makeHarness();

    await restartSessionForSettingsChange(context, 'proj-1', '/mock/project', TASK_ID);

    expect(resumePromptArg()).toBeUndefined();
  });

  it('does not assert idle-authoritative when a prompt was supplied', async () => {
    // That assertion exists because a promptless `--resume` runs a hook-less
    // context reload the heartbeat would misread as thinking. A resume WITH a
    // prompt starts a real turn, so asserting idle would paint a working agent
    // as parked.
    const { context } = makeHarness();
    const markIdleAuthoritative = (context.sessionManager as unknown as {
      markIdleAuthoritative: ReturnType<typeof vi.fn>;
    }).markIdleAuthoritative;

    await restartSessionForSettingsChange(
      context,
      'proj-1',
      '/mock/project',
      TASK_ID,
      { resumePrompt: AUTO_COMMAND },
    );

    expect(markIdleAuthoritative).not.toHaveBeenCalled();
  });

  it('reports a failure instead of throwing when the suspend fails', async () => {
    // The scheduler treats a false return as "escalation did not run" and
    // records `failed`, so this must never unwind as an exception.
    const { context } = makeHarness();
    (context.sessionManager as unknown as { suspend: ReturnType<typeof vi.fn> }).suspend
      .mockRejectedValue(new Error('pty is gone'));

    const result = await restartSessionForSettingsChange(
      context,
      'proj-1',
      '/mock/project',
      TASK_ID,
      { resumePrompt: AUTO_COMMAND },
    );

    expect(result.ok).toBe(false);
    expect(hoisted.resumeSuspendedSession).not.toHaveBeenCalled();
  });
});
