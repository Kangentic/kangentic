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
/**
 * Live usage keyed by session id, read by `resolveLiveEffort`. Empty by default,
 * which means the agent reports no effort and the delta sources from the session
 * record exactly as it did before live telemetry was consulted.
 */
let mockUsageCache: Record<string, { model: { id: string; displayName: string; effort?: string } }> = {};

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    updateAppliedSettings = (...args: unknown[]) => mockUpdateAppliedSettings(...args);
  },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(() => ({})) } }));
vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
  prepareInjectionPlan: (...args: unknown[]) => mockPrepareInjectionPlan(...args),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  restartSessionForSettingsChange: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn(async (_id: string, fn: () => Promise<void>) => fn()),
}));
// Stubbed for its own sake AND to keep the real module's `agent-spawn` import
// (and the electron it drags in) out of this suite. What the reconcile DOES is
// pinned in auto-spawn-reconcile.test.ts; what matters here is that the
// chokepoint reaches it, from both authoring surfaces, with the right arguments.
const mockReconcileAutoSpawnChange = vi.fn();
vi.mock('../../src/main/ipc/handlers/auto-spawn-reconcile', () => ({
  reconcileAutoSpawnChange: (...args: unknown[]) => mockReconcileAutoSpawnChange(...args),
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
  buildColumnStrategyChanges,
} from '../../src/main/ipc/handlers/strategy-propagation';
import { restartSessionForSettingsChange } from '../../src/main/ipc/handlers/session-reconcile';
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
    sessionManager: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUsageCache: () => mockUsageCache,
    },
    terminalSubmitScheduler: { scheduleKeystrokes: (...args: unknown[]) => mockScheduleKeystrokes(...args) },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    boardConfigManager: {},
  } as never;
}

/**
 * Variant of makeContext() whose projectRepo.getById row carries an explicit
 * `path`, deliberately different from `currentProjectPath` ('/mock/project'),
 * so a restart that reads the wrong source is caught by exact literal
 * comparison rather than by coincidence.
 */
function makeContextWithProjectRowPath(path: string | undefined) {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path, default_model: null, default_effort: null })) },
    sessionManager: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUsageCache: () => mockUsageCache,
    },
    terminalSubmitScheduler: { scheduleKeystrokes: (...args: unknown[]) => mockScheduleKeystrokes(...args) },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    boardConfigManager: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUsageCache = {};
  mockGetSession.mockReturnValue({ status: 'running' });
  mockPrepareInjectionPlan.mockReturnValue({
    sequence: [{ text: '/effort high', verify: 'command-match' }],
    verifier: null,
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
    }], 'proj-1');

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
    }], 'proj-1');

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
    }], 'proj-1');

    expect(mockScheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('hands prepareInjectionPlan the AFTER lane, so the delta targets the new value', () => {
    const after = makeLane({ effort_override: 'high' });

    propagateStrategyToLiveSessions(makeContext(), 'TEST', [{
      task: makeTask(),
      before: makeLane({ effort_override: 'low' }),
      after,
      sourceName: 'Executing',
    }], 'proj-1');

    expect(mockPrepareInjectionPlan.mock.calls[0][0]).toMatchObject({ toLane: after });
  });

  it('hands prepareInjectionPlan the liveEffort resolved for the task\'s own session', () => {
    // A decoy entry under a different session id proves the lookup keys off
    // the task's OWN session_id ('sess-1'), not just any populated entry.
    mockUsageCache = {
      'sess-other': { model: { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', effort: 'low' } },
      'sess-1': { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'medium' } },
    };

    propagateStrategyToLiveSessions(makeContext(), 'TEST', [{
      task: makeTask(),
      before: makeLane({ effort_override: 'low' }),
      after: makeLane({ effort_override: 'high' }),
      sourceName: 'Executing',
    }], 'proj-1');

    expect(mockPrepareInjectionPlan.mock.calls[0][0]).toMatchObject({ liveEffort: 'medium' });
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
    propagateBoardProfileChange(makeContext(), [profile('low')], [profile('high')], 'proj-1');

    expect(mockScheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(mockScheduleKeystrokes.mock.calls[0][0]).toBe('task-riding');
  });

  it('leaves tasks on Default alone - a profile write cannot change their settings', () => {
    propagateBoardProfileChange(makeContext(), [profile('low')], [profile('high')], 'proj-1');

    const touchedTaskIds = mockScheduleKeystrokes.mock.calls.map((call) => call[0]);
    expect(touchedTaskIds).not.toContain('task-default');
  });

  it('injects nothing when the rewrite leaves the task\'s column unchanged', () => {
    propagateBoardProfileChange(makeContext(), [profile('high')], [profile('high')], 'proj-1');

    expect(mockScheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('treats a deleted profile as a change back to the column\'s own settings', () => {
    // The task's profile_id now dangles, so it resolves to Default. That IS a
    // settings change for a running session and must propagate.
    propagateBoardProfileChange(makeContext(), [profile('high')], [], 'proj-1');

    expect(mockScheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(mockScheduleKeystrokes.mock.calls[0][0]).toBe('task-riding');
  });
});

/**
 * `buildColumnStrategyChanges` is the one place a column edit's before/after
 * gets folded per task, for both the UI's SWIMLANE_UPDATE handler and the MCP
 * update_column tool. It must fold the SAME task's profile over `before` AND
 * `after` independently - not just `after` - or a profiled task's `before`
 * stays the column's raw (unfolded) value while `after` is correctly folded,
 * which manufactures a phantom delta on every cosmetic save of a column a
 * profile retunes. That phantom delta is no longer just a spurious `/model` or
 * `/effort` injection: since this diff, the SAME before/after pair also feeds
 * `flipsAutoSpawn` (auto-spawn-reconcile.ts), so an unfolded `before` can make
 * a colour or name edit look like a real auto_spawn transition and spawn a
 * worktree + branch checkout for every profiled task in the column.
 */
describe('buildColumnStrategyChanges', () => {
  function makeContextWithProfiles(profiles: BoardProfile[]) {
    return {
      ...makeContext(),
      boardConfigManager: { getBoardProfiles: vi.fn(() => profiles) },
    } as never;
  }

  it('folds the profile over BOTH before and after, not just after', () => {
    const ridingTask = makeTask({ id: 'task-riding', profile_id: 'p1' });
    mockSwimlaneList.mockReturnValue([makeLane({ effort_override: null })]);
    mockTaskList.mockReturnValue([ridingTask]);
    const profile: BoardProfile = {
      id: 'p1',
      name: 'Heavy',
      columns: { [LANE_ID]: { effortOverride: 'xhigh' } },
    };

    const changes = buildColumnStrategyChanges({
      context: makeContextWithProfiles([profile]),
      projectId: 'proj-1',
      before: makeLane({ effort_override: null }),
      after: makeLane({ effort_override: null }),
    });

    expect(changes).toHaveLength(1);
    // Both the column's before AND after here carry effort_override: null - the
    // profile is what supplies 'xhigh'. If only `after` were folded, `before`
    // would still read null and this assertion would catch it.
    expect(changes[0].before).toMatchObject({ effort_override: 'xhigh' });
    expect(changes[0].after).toMatchObject({ effort_override: 'xhigh' });
  });

  it('returns an empty list without a resolved project', () => {
    const changes = buildColumnStrategyChanges({
      context: makeContext(),
      projectId: null,
      before: makeLane(),
      after: makeLane(),
    });

    expect(changes).toEqual([]);
  });
});

/**
 * An auto_spawn flip has to reach the tasks already in the column, live.
 *
 * It cannot ride the injection loop above, which bails on `!task.session_id` and
 * so can only ever touch a session that already exists. It is delegated to the
 * reconcile instead - but it has to be delegated from HERE, because this is the
 * one place both authoring surfaces (a column edit and a Board Profile edit)
 * already converge with their before/after folded per task. Reconciling only the
 * column path would recreate the exact split-brain this chokepoint was extracted
 * to kill, since `auto_spawn` is profile-scoped.
 */
describe('auto_spawn reconcile', () => {
  it('reaches the reconcile on a column edit, with the explicit project', () => {
    // The project is a parameter, never `context.currentProjectId`: a
    // mis-targeted keystroke injection is cosmetic, a mis-targeted SPAWN is not.
    propagateStrategyToLiveSessions(makeContext(), 'SWIMLANE_UPDATE', [{
      task: makeTask(),
      before: makeLane({ auto_spawn: false }),
      after: makeLane({ auto_spawn: true }),
      sourceName: 'Executing',
    }], 'proj-1');

    expect(mockReconcileAutoSpawnChange).toHaveBeenCalledTimes(1);
    const [, , label, changes] = mockReconcileAutoSpawnChange.mock.calls[0];
    expect(mockReconcileAutoSpawnChange.mock.calls[0][1]).toBe('proj-1');
    expect(label).toBe('SWIMLANE_UPDATE');
    expect(changes).toMatchObject([{ before: { auto_spawn: false }, after: { auto_spawn: true } }]);
  });

  it('reaches the reconcile on a Board Profile edit too', () => {
    // The profile twin. `auto_spawn` is profile-scoped (column-strategy line
    // 181), so a profile can flip it for a task without the column changing.
    mockSwimlaneList.mockReturnValue([makeLane({ auto_spawn: false })]);
    mockTaskList.mockReturnValue([makeTask({ id: 'task-riding', profile_id: 'p1' })]);
    const withAutoSpawn = (autoSpawn: boolean): BoardProfile => ({
      id: 'p1',
      name: 'Heavy',
      columns: { [LANE_ID]: { autoSpawn } },
    });

    propagateBoardProfileChange(makeContext(), [withAutoSpawn(false)], [withAutoSpawn(true)], 'proj-1');

    expect(mockReconcileAutoSpawnChange).toHaveBeenCalledTimes(1);
    expect(mockReconcileAutoSpawnChange.mock.calls[0][3]).toMatchObject([
      { task: { id: 'task-riding' }, before: { auto_spawn: false }, after: { auto_spawn: true } },
    ]);
  });

  it('hands over the change even when no model or effort moved', () => {
    // The injection gate returns early for an auto_spawn-only edit, so the
    // reconcile must be dispatched BEFORE it, not from inside the loop.
    propagateStrategyToLiveSessions(makeContext(), 'SWIMLANE_UPDATE', [{
      task: makeTask({ session_id: null }),
      before: makeLane({ auto_spawn: false }),
      after: makeLane({ auto_spawn: true }),
      sourceName: 'Executing',
    }], 'proj-1');

    expect(mockPrepareInjectionPlan).not.toHaveBeenCalled();
    expect(mockReconcileAutoSpawnChange).toHaveBeenCalledTimes(1);
  });
});

/**
 * A MODEL-change restart resolves `projectPath` from the resolved project row
 * (`context.projectRepo.getById(projectId)?.path`), never from ambient
 * `context.currentProjectPath`. A mis-resolved path here targets the restart
 * at the wrong project's checkout, not just a cosmetic keystroke injection -
 * the same reasoning that makes `projectId` an explicit parameter rather than
 * a read of `context.currentProjectId`.
 */
describe('propagateStrategyToLiveSessions - model-restart project path resolution', () => {
  it('skips the restart when the resolved project row carries no path', () => {
    mockPrepareInjectionPlan.mockReturnValue({
      sequence: [],
      verifier: null,
      needsRestartForModel: true,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    propagateStrategyToLiveSessions(makeContextWithProjectRowPath(undefined), 'TEST', [{
      task: makeTask(),
      before: makeLane({ model_override: 'sonnet-4' }),
      after: makeLane({ model_override: 'opus-5' }),
      sourceName: 'Executing',
    }], 'proj-1');

    expect(restartSessionForSettingsChange).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('restarts with the resolved project row\'s path, not context.currentProjectPath', () => {
    mockPrepareInjectionPlan.mockReturnValue({
      sequence: [],
      verifier: null,
      needsRestartForModel: true,
    });

    propagateStrategyToLiveSessions(makeContextWithProjectRowPath('/mock/from-project-row'), 'TEST', [{
      task: makeTask(),
      before: makeLane({ model_override: 'sonnet-4' }),
      after: makeLane({ model_override: 'opus-5' }),
      sourceName: 'Executing',
    }], 'proj-1');

    expect(restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(), 'proj-1', '/mock/from-project-row', 'task-1',
    );
  });
});
