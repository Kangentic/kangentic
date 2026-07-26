/**
 * Live-session propagation of a settings edit.
 *
 * Two edits can change what a running session should be using - editing a column
 * and editing a Board Profile - and both must reach in-flight sessions the same
 * way. This file pins the two properties that were wrong before the propagation
 * was extracted to one chokepoint:
 *
 *   1. A profile edit reached live sessions NOT AT ALL. A task riding an edited
 *      profile kept its old model until the user moved it out and back.
 *   2. A column edit pushed the COLUMN's new value at every task in it, ignoring
 *      each task's profile - so retuning a column clobbered the running model of
 *      a task whose profile pins a different one there.
 *
 * Both are silent: the session keeps running, just on the wrong settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrepareInjectionPlan = vi.fn();
const mockScheduleKeystrokes = vi.fn();
const mockUpdateAppliedSettings = vi.fn();
const mockGetSession = vi.fn();
const mockSwimlaneList = vi.fn();
const mockTaskList = vi.fn();

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    updateAppliedSettings = (...args: unknown[]) => mockUpdateAppliedSettings(...args);
  },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(() => ({})) } }));
vi.mock('../../src/main/transition-engine/injection-plan', () => ({
  prepareInjectionPlan: (...args: unknown[]) => mockPrepareInjectionPlan(...args),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  restartSessionForSettingsChange: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_id: string, fn: () => Promise<void>) => fn()),
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({
    swimlanes: { list: () => mockSwimlaneList() },
    tasks: { list: () => mockTaskList() },
  })),
}));

import {
  propagateStrategyToLiveSessions,
  propagateBoardProfileChange,
} from '../../src/main/ipc/handlers/strategy-propagation';
import type { BoardProfile, Swimlane, Task } from '../../src/shared/types';

const LANE_ID = 'lane-executing';

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Executing',
    model_override: null,
    effort_override: null,
    agent_override: null,
    permission_mode: null,
    auto_command: null,
    auto_spawn: true,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    plan_exit_target_id: null,
    ...overrides,
  } as Swimlane;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    swimlane_id: LANE_ID,
    session_id: 'sess-1',
    agent: 'claude',
    profile_id: null,
    model_override: null,
    effort_override: null,
    ...overrides,
  } as Task;
}

function makeContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', default_model: null, default_effort: null })) },
    sessionManager: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    terminalSubmitScheduler: { scheduleKeystrokes: (...args: unknown[]) => mockScheduleKeystrokes(...args) },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    boardConfigManager: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockReturnValue({ status: 'running' });
  mockPrepareInjectionPlan.mockReturnValue({
    sequence: ['/effort high'],
    verifier: null,
    verifiedPrefixLength: 0,
    needsRestartForModel: false,
    appliedSettings: { effort: 'high' },
  });
});

describe('propagateStrategyToLiveSessions', () => {
  it('injects when the task\'s resolved effort changed', () => {
    propagateStrategyToLiveSessions(makeContext(), 'TEST', [{
      task: makeTask(),
      before: makeLane({ effort_override: 'low' }),
      after: makeLane({ effort_override: 'high' }),
      sourceName: 'Executing',
    }]);

    expect(mockScheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(mockUpdateAppliedSettings).toHaveBeenCalledWith('sess-1', { effort: 'high' });
  });

  it('injects nothing when the resolved values are unchanged', () => {
    // A colour/title/icon edit, or a re-save picking the same values, must not
    // disturb a running agent. Gating here rather than on the session's recorded
    // applied_* also protects records whose applied_* is stale (NULL on an old
    // session) from a phantom delta and a needless restart.
    propagateStrategyToLiveSessions(makeContext(), 'TEST', [{
      task: makeTask(),
      before: makeLane({ effort_override: 'high' }),
      after: makeLane({ effort_override: 'high' }),
      sourceName: 'Executing',
    }]);

    expect(mockPrepareInjectionPlan).not.toHaveBeenCalled();
    expect(mockScheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('skips a task with no live running session', () => {
    mockGetSession.mockReturnValue({ status: 'suspended' });

    propagateStrategyToLiveSessions(makeContext(), 'TEST', [{
      task: makeTask(),
      before: makeLane({ effort_override: 'low' }),
      after: makeLane({ effort_override: 'high' }),
      sourceName: 'Executing',
    }]);

    expect(mockScheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('hands prepareInjectionPlan the AFTER lane, so the delta targets the new value', () => {
    const after = makeLane({ effort_override: 'high' });

    propagateStrategyToLiveSessions(makeContext(), 'TEST', [{
      task: makeTask(),
      before: makeLane({ effort_override: 'low' }),
      after,
      sourceName: 'Executing',
    }]);

    expect(mockPrepareInjectionPlan.mock.calls[0][0]).toMatchObject({ toLane: after });
  });
});

describe('propagateBoardProfileChange', () => {
  const RIDING_TASK = makeTask({ id: 'task-riding', profile_id: 'p1' });
  const DEFAULT_TASK = makeTask({ id: 'task-default', profile_id: null, session_id: 'sess-2' });

  function profile(effort: string | null): BoardProfile {
    return { id: 'p1', name: 'Heavy', columns: { [LANE_ID]: { effortOverride: effort } } };
  }

  beforeEach(() => {
    mockSwimlaneList.mockReturnValue([makeLane()]);
    mockTaskList.mockReturnValue([RIDING_TASK, DEFAULT_TASK]);
  });

  it('reaches the live session of a task riding the retuned profile', () => {
    propagateBoardProfileChange(makeContext(), [profile('low')], [profile('high')]);

    expect(mockScheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(mockScheduleKeystrokes.mock.calls[0][0]).toBe('task-riding');
  });

  it('leaves tasks on Default alone - a profile write cannot change their settings', () => {
    propagateBoardProfileChange(makeContext(), [profile('low')], [profile('high')]);

    const touchedTaskIds = mockScheduleKeystrokes.mock.calls.map((call) => call[0]);
    expect(touchedTaskIds).not.toContain('task-default');
  });

  it('injects nothing when the rewrite leaves the task\'s column unchanged', () => {
    propagateBoardProfileChange(makeContext(), [profile('high')], [profile('high')]);

    expect(mockScheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('treats a deleted profile as a change back to the column\'s own settings', () => {
    // The task's profile_id now dangles, so it resolves to Default. That IS a
    // settings change for a running session and must propagate.
    propagateBoardProfileChange(makeContext(), [profile('high')], []);

    expect(mockScheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(mockScheduleKeystrokes.mock.calls[0][0]).toBe('task-riding');
  });
});
