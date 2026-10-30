/**
 * `resumeTaskSession` (src/main/ipc/handlers/session-resume.ts), the Resume
 * button's and the phone's resume of a paused task: what did not ride the
 * resume's command line is typed in, and messages held for the task while it
 * was paused go out in the resume's opening message.
 *
 * Before the fix the engine's outcome was not read here at all, so a command
 * from the task's Commands menu was lost on a CLI whose resume takes no prompt.
 *
 * Runs the REAL resumeTaskSession and its task lock; the repositories, the
 * engine and the held-message store stand in, and `composeOpeningMessage` is
 * the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, Task } from '../../src/shared/types';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';

const TASK_ID = 'task-resume';
const PROJECT_ID = 'proj-1';
const LANE = { id: 'lane-executing', name: 'Executing', role: null, permission_mode: null, auto_spawn: true, is_ghost: false };
const HELD_TEXT = 'Lower the cap to 3 and rethrow the last error.';

let storedTask: Task;
let outcome: SpawnOutcome;

const engine = {
  resumeSuspendedSession: vi.fn(async (): Promise<SpawnOutcome> => {
    storedTask = { ...storedTask, session_id: 'sess-resumed', agent: 'codex' };
    return outcome;
  }),
};

const repos = {
  tasks: { getById: vi.fn(() => storedTask), update: vi.fn() },
  swimlanes: { getById: vi.fn(() => LANE), list: vi.fn(() => [LANE]) },
  automations: {},
  automationRuns: {},
  attachments: {},
};

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  // Paused before the task's last entry into its column, so the Resume continues the conversation.
  SessionRepository: class {
    getLatestForTask() { return { status: 'suspended', suspended_at: '2026-10-28T13:00:00.000Z' }; }
  },
}));
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    currentVisit() { return { at: '2026-10-28T03:00:00.000Z', origin: 'user', from_swimlane_id: null }; }
  },
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: () => repos,
  ensureTaskWorktree: vi.fn(async (): Promise<void> => {}),
  createTransitionEngine: () => engine,
  resolveSpawnOverrides: () => ({}),
  spawnAgent: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: vi.fn(() => null),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: '/mock/project' }),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: () => (storedTask.session_id === 'sess-resumed'
    ? { task: storedTask, liveSession: { id: 'sess-resumed', taskId: TASK_ID, status: 'running' } }
    : { task: { ...storedTask, session_id: null }, liveSession: null }),
}));
vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: (lane: unknown) => lane,
}));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: () => null,
}));

const mockClaimHeldMessages = vi.hoisted(() => vi.fn<(...callArguments: unknown[]) => unknown>(() => null));
const mockDeliverOpeningRemainder = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/held-messages/held-messages')>();
  return {
    composeOpeningMessage: original.composeOpeningMessage,
    claimHeldMessages: mockClaimHeldMessages,
    deliverOpeningRemainder: mockDeliverOpeningRemainder,
  };
});

import { resumeTaskSession } from '../../src/main/ipc/handlers/session-resume';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function fakeContext(): IpcContext {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
    sessionManager: {
      getSession: (id: string) => (id === 'sess-resumed' ? ({ id, taskId: TASK_ID, status: 'running' } as Session) : undefined),
    },
  } as unknown as IpcContext;
}

function fakeHeldClaim() {
  return { projectId: PROJECT_ID, taskId: TASK_ID, ids: ['held-1'], text: HELD_TEXT, release: vi.fn(), commit: vi.fn(), fail: vi.fn(), isSettled: () => false };
}

/** The prompt the engine was asked to resume with. */
function resumedWith(): unknown {
  return (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[3];
}

describe('resumeTaskSession: what the resume could not carry, and held messages', () => {
  beforeEach(() => {
    engine.resumeSuspendedSession.mockClear();
    mockDeliverOpeningRemainder.mockReset();
    mockClaimHeldMessages.mockReset();
    mockClaimHeldMessages.mockReturnValue(null);
    storedTask = { id: TASK_ID, title: 'Retry the sync', swimlane_id: LANE.id, session_id: null, archived_at: null } as Task;
    outcome = { startOver: null, recapOnly: false, unsentPrompt: null };
  });

  it('types a Commands-menu command the resume could not carry on its command line', async () => {
    // Red before the fix: the outcome was not read, so the command was lost.
    outcome = { startOver: null, recapOnly: false, unsentPrompt: '/code-review' };

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, resumePrompt: '/code-review' });

    expect(resumedWith()).toBe('/code-review');
    expect(mockDeliverOpeningRemainder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: TASK_ID,
      sessionId: 'sess-resumed',
      unsentPrompt: '/code-review',
      held: null,
    }));
  });

  it('opens a plain Resume with the held messages as its whole opening message', async () => {
    const claim = fakeHeldClaim();
    mockClaimHeldMessages.mockReturnValue(claim);

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(resumedWith()).toBe(HELD_TEXT);
    expect(mockDeliverOpeningRemainder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      held: claim,
      heldInPrompt: true,
      heldAfterTurn: false,
      unsentPrompt: null,
    }));
  });

  it('puts held messages after a carried prompt, and after a slash command\'s turn', async () => {
    const claim = fakeHeldClaim();
    mockClaimHeldMessages.mockReturnValue(claim);

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, resumePrompt: '/code-review' });

    expect(resumedWith()).toBe('/code-review');
    expect(mockDeliverOpeningRemainder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      held: claim,
      heldInPrompt: false,
      heldAfterTurn: true,
    }));
  });

  it('keeps them held when the resume opened on an expired conversation\'s recap', async () => {
    const claim = fakeHeldClaim();
    mockClaimHeldMessages.mockReturnValue(claim);
    outcome = { startOver: 'expired', recapOnly: true, unsentPrompt: null };

    await resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID });

    expect(mockDeliverOpeningRemainder).not.toHaveBeenCalled();
    expect(claim.release).toHaveBeenCalledWith();
  });

  it('keeps them held when the resume fails', async () => {
    const claim = fakeHeldClaim();
    mockClaimHeldMessages.mockReturnValue(claim);
    engine.resumeSuspendedSession.mockRejectedValueOnce(new Error('pty host down'));

    await expect(resumeTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID })).rejects.toThrow('pty host down');

    expect(claim.release).toHaveBeenCalled();
    expect(mockDeliverOpeningRemainder).not.toHaveBeenCalled();
  });
});
