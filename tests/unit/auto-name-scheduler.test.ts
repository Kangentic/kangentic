/**
 * Unit tests for the auto-name scheduler module
 * (`src/renderer/lib/auto-name-scheduler.ts`).
 *
 * Covers:
 *   - `markAutoNameAsked` (idempotent + persistence call shape)
 *   - `scheduleAutoNameSuggestion` (every precheck)
 *   - the timer body: generate a title, then apply it at the session's next
 *     idle edge (now when it already waits on the user, else when it starts
 *     to), re-checking that the title is still a placeholder, saving to the
 *     session's own project, and toasting only for the project on screen.
 *
 * A Command Terminal is named in main now; that namer's tests are in
 * tests/unit/command-terminal-namer.test.ts.
 *
 * Strategy: mock all the Zustand stores and `window.electronAPI` directly. The
 * stores read one mutable `world` on every `getState()`, so a test changes the
 * world between steps (the user renames the task, the agent finishes its turn)
 * and fires the session store's captured listeners to deliver the change. The
 * scheduler's module-level state is cleared between tests via
 * `cancelAutoNameTimersAndClear`.
 *
 * The test file uses `vi.useFakeTimers` for the 30-second timer so the full
 * suite stays under 1 second.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, AppConfig, AgentDetectionInfo, ActivityState } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted store mocks - declared via vi.hoisted so the factory closures below
// (which run before the test file's top-level body) can see them.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  useProjectStore: { getState: vi.fn() },
  useBoardStore: { getState: vi.fn(), setState: vi.fn() },
  useConfigStore: { getState: vi.fn() },
  useSessionStore: { getState: vi.fn(), subscribe: vi.fn() },
  useToastStore: { getState: vi.fn() },
  invalidateProject: vi.fn(),
  openTaskFromNotification: vi.fn(),
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: mocks.useProjectStore }));
vi.mock('../../src/renderer/stores/board-store', () => ({ useBoardStore: mocks.useBoardStore }));
vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: mocks.useConfigStore }));
vi.mock('../../src/renderer/stores/session-store', () => ({ useSessionStore: mocks.useSessionStore }));
vi.mock('../../src/renderer/stores/toast-store', () => ({ useToastStore: mocks.useToastStore }));
vi.mock('../../src/renderer/stores/project-cache', () => ({ invalidateProject: mocks.invalidateProject }));
vi.mock('../../src/renderer/utils/open-task-from-notification', () => ({
  openTaskFromNotification: mocks.openTaskFromNotification,
}));

const { useProjectStore, useBoardStore, useConfigStore, useSessionStore, useToastStore } = mocks;

// Imported AFTER mocks. Pulls in the scheduler module which reads `import.meta.hot`
// (undefined in vitest, harmless).
import {
  scheduleAutoNameSuggestion,
  markAutoNameAsked,
  automationAgentCanName,
  cancelAutoNameTimersAndClear,
  autoNameTimers,
  autoNameAsked,
  autoRenamesAwaitingIdle,
} from '../../src/renderer/lib/auto-name-scheduler';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    taskId: 'task-1',
    projectId: 'project-1',
    pid: 100,
    status: 'running',
    shell: 'bash',
    cwd: '/repo',
    startedAt: '2026-04-30T00:00:00Z',
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

type TaskFixture = ReturnType<typeof makeTask>;

function makeTask(overrides: { id?: string; title?: string; description?: string } = {}) {
  return {
    id: overrides.id ?? 'task-1',
    display_id: 1,
    title: overrides.title ?? 'fix bug',
    description: overrides.description ?? 'A real description that needs summarizing',
    swimlane_id: 'swim-1',
    position: 0,
    agent: null,
    session_id: 'session-1',
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2026-04-30T00:00:00Z',
    updated_at: '2026-04-30T00:00:00Z',
  };
}

/** An agent that can be the Automation agent: it answers, takes a model, and summarizes. */
function makeAdapter(overrides: Partial<AgentDetectionInfo> = {}): AgentDetectionInfo {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    found: true,
    path: '/usr/bin/claude',
    version: '1.0.0',
    permissions: [{ mode: 'default', label: 'Default' }],
    defaultPermission: 'default',
    supportsSummarize: true,
    supportsAnswerFromContext: true,
    answerCapabilities: { streaming: true, search: true, model: true, effort: true, defaultEffort: 'low' },
    ...overrides,
  };
}

const READY_AUTOMATION = { agent: 'claude', model: 'claude-haiku-5-5', effort: null };

/**
 * Everything the mocked stores and IPC read. Tests mutate it between steps;
 * every `getState()` reads it afresh.
 */
interface World {
  /** The open project's id; null with no project open. */
  currentProjectId: string | null;
  /** The open board's tasks. */
  boardTasks: TaskFixture[];
  /** Main's copy of each project's tasks, served by `monitor.getTaskDetail`. */
  mainTasks: Record<string, TaskFixture[]>;
  sessions: Session[];
  activity: Record<string, ActivityState>;
  agents: AgentDetectionInfo[];
  automation: AppConfig['automation'] | undefined;
  askedTaskIds: string[];
}

let world: World;
let addToast: ReturnType<typeof vi.fn>;
let updateConfig: ReturnType<typeof vi.fn>;
let sessionListeners: Set<(state: unknown) => void>;
let boardWrites: Array<{ tasks: TaskFixture[] }>;
let summarize: ReturnType<typeof vi.fn>;
let tasksUpdate: ReturnType<typeof vi.fn>;
let getTaskDetail: ReturnType<typeof vi.fn>;

function sessionState() {
  return { sessions: world.sessions, sessionActivity: world.activity };
}

/** Deliver a session store change to every listener, as zustand's `set` does. */
function emitSessionChange(): void {
  for (const listener of [...sessionListeners]) listener(sessionState());
}

function installStores(): void {
  useBoardStore.getState.mockImplementation(() => ({
    tasks: world.boardTasks,
    archivedTasks: [],
  }));
  useBoardStore.setState.mockImplementation((updater: (state: { tasks: TaskFixture[]; archivedTasks: TaskFixture[] }) => { tasks: TaskFixture[] }) => {
    const next = updater({ tasks: world.boardTasks, archivedTasks: [] });
    boardWrites.push(next);
    world.boardTasks = next.tasks;
  });

  useSessionStore.getState.mockImplementation(() => sessionState());
  useSessionStore.subscribe.mockImplementation((listener: (state: unknown) => void) => {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  });

  useConfigStore.getState.mockImplementation(() => ({
    config: { autoNameAskedTaskIds: world.askedTaskIds } as Partial<AppConfig>,
    globalConfig: { automation: world.automation } as Partial<AppConfig>,
    agentList: world.agents,
    updateConfig,
  }));

  useProjectStore.getState.mockImplementation(() => ({
    currentProject: world.currentProjectId ? { id: world.currentProjectId } : null,
    projects: [{ id: 'project-1', default_agent: 'claude' }],
  }));

  useToastStore.getState.mockImplementation(() => ({ addToast }));
}

function installElectronApi(options: {
  summarizeResult?: () => unknown;
  updateImpl?: (input: { id: string; title: string }, projectId: string | null) => unknown;
} = {}): void {
  // The scheduler reads `window.electronAPI` directly. In the node test env
  // vitest provides no `window`, so we attach to globalThis.
  (globalThis as unknown as { window: Record<string, unknown> }).window = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  summarize = vi.fn(async () => (options.summarizeResult ?? (() => ({ ok: true, title: 'Fix OAuth redirect loop' })))());
  tasksUpdate = vi.fn(async (input: { id: string; title: string }, projectId: string | null) => {
    if (options.updateImpl) return options.updateImpl(input, projectId);
    const owner = projectId ?? 'project-1';
    const source = owner === world.currentProjectId ? world.boardTasks : (world.mainTasks[owner] ?? []);
    const existing = source.find((entry) => entry.id === input.id) ?? makeTask({ id: input.id });
    return { ...existing, title: input.title };
  });
  getTaskDetail = vi.fn(async (projectId: string, taskId: string) => {
    const task = (world.mainTasks[projectId] ?? []).find((entry) => entry.id === taskId);
    return task ? { task, projectId } : null;
  });
  (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
    agent: { summarize },
    tasks: { update: tasksUpdate },
    monitor: { getTaskDetail },
  };
}

/** Schedule, then run the 30-second timer and every promise it starts. */
async function scheduleAndFire(session: Session = makeSession()): Promise<void> {
  scheduleAutoNameSuggestion(session);
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.runAllTimersAsync();
}

/** Flush the promises an idle edge starts (the re-read, the save, the toast). */
async function flush(): Promise<void> {
  await vi.runAllTimersAsync();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  world = {
    currentProjectId: 'project-1',
    boardTasks: [makeTask()],
    mainTasks: {},
    sessions: [makeSession()],
    activity: { 'session-1': 'thinking' },
    agents: [makeAdapter()],
    automation: READY_AUTOMATION,
    askedTaskIds: [],
  };
  addToast = vi.fn();
  updateConfig = vi.fn(async () => {});
  sessionListeners = new Set();
  boardWrites = [];
  installStores();
  installElectronApi();
  cancelAutoNameTimersAndClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// markAutoNameAsked
// ---------------------------------------------------------------------------

describe('markAutoNameAsked', () => {
  it('adds the taskId to the in-memory set and persists via updateConfig', () => {
    world.askedTaskIds = ['existing-1'];

    markAutoNameAsked('task-1');

    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith({
      autoNameAskedTaskIds: ['existing-1', 'task-1'],
    });
  });

  it('is idempotent: a second call for the same taskId does NOT call updateConfig again', () => {
    markAutoNameAsked('task-1');
    markAutoNameAsked('task-1');
    markAutoNameAsked('task-1');

    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('skips updateConfig when the persisted list already contains the taskId', () => {
    // Simulates the boot path: in-memory set is empty (post-clear) but the
    // persisted config already has the taskId from a prior app run.
    world.askedTaskIds = ['task-1'];

    markAutoNameAsked('task-1');

    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduleAutoNameSuggestion - prechecks
// ---------------------------------------------------------------------------

describe('scheduleAutoNameSuggestion - prechecks', () => {
  it('returns early when session is transient', () => {
    scheduleAutoNameSuggestion(makeSession({ transient: true }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when session.status is not running', () => {
    scheduleAutoNameSuggestion(makeSession({ status: 'queued' }));
    scheduleAutoNameSuggestion(makeSession({ status: 'suspended' }));
    scheduleAutoNameSuggestion(makeSession({ status: 'exited' }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when session has no taskId', () => {
    scheduleAutoNameSuggestion(makeSession({ taskId: '' }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the taskId is already in the asked set', () => {
    autoNameAsked.add('task-1');
    scheduleAutoNameSuggestion(makeSession({ taskId: 'task-1' }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when a timer for the taskId is already scheduled', () => {
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(1);

    // Second call for the same taskId is a no-op.
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(1);
  });

  it('seeds the in-memory asked set from persisted config and returns early', () => {
    world.askedTaskIds = ['task-1'];
    scheduleAutoNameSuggestion(makeSession({ taskId: 'task-1' }));
    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the task is not found on the open board', () => {
    world.boardTasks = [];
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the task title is NOT a placeholder', () => {
    world.boardTasks = [makeTask({ title: 'A real meaningful task title' })];
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the task description is empty', () => {
    world.boardTasks = [makeTask({ title: 'fix bug', description: '   ' })];
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the Automation agent does not support summarize', () => {
    world.agents = [makeAdapter({ supportsSummarize: false })];
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the Automation agent is not found on disk', () => {
    world.agents = [makeAdapter({ found: false })];
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when no Automation agent is set', () => {
    world.automation = undefined;
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('schedules a 30-second timer when all gates pass', () => {
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(1);
    expect(autoNameTimers.has('task-1')).toBe(true);
  });

  it('schedules a timer for a task of another project without reading the open board', () => {
    // The open board holds project-2's tasks; the session's task lives in
    // project-1, which is not on screen. Its gates run when the timer fires.
    world.currentProjectId = 'project-2';
    world.boardTasks = [];
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.has('task-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The timer body: generate a title
// ---------------------------------------------------------------------------

describe('scheduleAutoNameSuggestion - generating the title', () => {
  it('asks the Automation agent for a title with the task description, project and task', async () => {
    world.boardTasks = [makeTask({ title: 'fix bug', description: 'real description' })];

    await scheduleAndFire();

    // The project and task travel with the request: by the time it fires
    // another project may be open, and the call is recorded against this one.
    expect(summarize).toHaveBeenCalledWith({ prompt: 'real description', projectId: 'project-1', taskId: 'task-1' });
  });

  it('skips when the user manually renamed the task before the timer fired', async () => {
    scheduleAutoNameSuggestion(makeSession());
    world.boardTasks = [makeTask({ title: 'User Manually Renamed' })];
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(summarize).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('skips when the session is no longer running at 30s', async () => {
    scheduleAutoNameSuggestion(makeSession());
    // Session crashed/suspended in the 30-second window.
    world.sessions = [makeSession({ status: 'exited' })];
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(summarize).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('marks the task as asked even when it is skipped (so we do not retry next session)', async () => {
    scheduleAutoNameSuggestion(makeSession());
    world.boardTasks = [makeTask({ title: 'Renamed' })];
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(autoNameAsked.has('task-1')).toBe(true);
  });

  it('persists the asked set once the task proves nameable, before asking for a title', async () => {
    await scheduleAndFire();

    expect(updateConfig).toHaveBeenCalledWith({ autoNameAskedTaskIds: ['task-1'] });
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(summarize.mock.invocationCallOrder[0]);
  });

  it('does not persist a task that was never a placeholder (a background project\'s timer starts ungated)', async () => {
    world.currentProjectId = 'project-2';
    world.boardTasks = [];
    world.mainTasks = { 'project-1': [makeTask({ title: 'A real meaningful task title' })] };

    await scheduleAndFire();

    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(updateConfig).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('swallows summarize IPC errors silently (no save, no toast)', async () => {
    installElectronApi({ summarizeResult: () => { throw new Error('boom'); } });
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(tasksUpdate).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('does nothing when the agent returns no title', async () => {
    installElectronApi({ summarizeResult: () => ({ ok: false, reason: 'not signed in' }) });
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(tasksUpdate).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Applying the title at the session's idle edge
// ---------------------------------------------------------------------------

describe('scheduleAutoNameSuggestion - applying the title at an idle edge', () => {
  it('applies the title at once when the session already waits on the user', async () => {
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(tasksUpdate).toHaveBeenCalledWith({ id: 'task-1', title: 'Fix OAuth redirect loop' }, 'project-1');
    expect(sessionListeners.size).toBe(0);
  });

  it('treats a permission prompt as waiting on the user, too', async () => {
    world.activity = { 'session-1': 'permission' };

    await scheduleAndFire();

    expect(tasksUpdate).toHaveBeenCalledTimes(1);
  });

  it('waits while the agent works, then applies at the next idle edge', async () => {
    await scheduleAndFire();

    // Mid-turn: main would skip the branch rename, so nothing is saved yet.
    expect(tasksUpdate).not.toHaveBeenCalled();
    expect(autoRenamesAwaitingIdle.has('task-1')).toBe(true);

    // Unrelated store churn while still thinking changes nothing.
    emitSessionChange();
    await flush();
    expect(tasksUpdate).not.toHaveBeenCalled();

    world.activity = { 'session-1': 'idle' };
    emitSessionChange();
    await flush();

    expect(tasksUpdate).toHaveBeenCalledTimes(1);
    expect(tasksUpdate).toHaveBeenCalledWith({ id: 'task-1', title: 'Fix OAuth redirect loop' }, 'project-1');
    expect(autoRenamesAwaitingIdle.size).toBe(0);
    expect(sessionListeners.size).toBe(0);

    // A later idle edge does not save again.
    emitSessionChange();
    await flush();
    expect(tasksUpdate).toHaveBeenCalledTimes(1);
  });

  it('updates the open board and toasts "Task renamed" with a card that opens the task', async () => {
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(world.boardTasks.find((entry) => entry.id === 'task-1')?.title).toBe('Fix OAuth redirect loop');
    expect(addToast).toHaveBeenCalledTimes(1);
    const toast = addToast.mock.calls[0][0];
    expect(toast).toMatchObject({
      title: 'Task renamed',
      message: '"Fix OAuth redirect loop" replaces the placeholder title.',
      variant: 'info',
      durationMs: 12_000,
    });
    // A timed toast: no button. The card opens the task instead.
    expect(toast.action).toBeUndefined();
    expect(toast.persistent).toBeUndefined();
    toast.onOpen();
    expect(mocks.openTaskFromNotification).toHaveBeenCalledWith('project-1', 'task-1');
  });

  it('skips the save when the user named the task while the agent worked', async () => {
    await scheduleAndFire();
    world.boardTasks = [makeTask({ title: 'Named by the user' })];

    world.activity = { 'session-1': 'idle' };
    emitSessionChange();
    await flush();

    expect(tasksUpdate).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
    expect(world.boardTasks[0].title).toBe('Named by the user');
  });

  it('drops the wait, without saving, when the session leaves the store', async () => {
    await scheduleAndFire();
    expect(sessionListeners.size).toBe(1);

    world.sessions = [];
    emitSessionChange();
    await flush();

    expect(sessionListeners.size).toBe(0);
    expect(autoRenamesAwaitingIdle.size).toBe(0);
    expect(tasksUpdate).not.toHaveBeenCalled();
  });

  it('drops the wait when the session is suspended mid-turn', async () => {
    await scheduleAndFire();

    world.sessions = [makeSession({ status: 'suspended' })];
    emitSessionChange();
    await flush();

    expect(sessionListeners.size).toBe(0);
    expect(tasksUpdate).not.toHaveBeenCalled();
  });

  it('stops listening when the module state is cleared (HMR dispose, tests)', async () => {
    await scheduleAndFire();
    expect(sessionListeners.size).toBe(1);

    cancelAutoNameTimersAndClear();

    expect(sessionListeners.size).toBe(0);
    expect(autoRenamesAwaitingIdle.size).toBe(0);
  });

  it('toasts "Couldn\'t rename task" with the reason when the save fails', async () => {
    installElectronApi({ updateImpl: () => { throw new Error("Error invoking remote method 'task:update': Error: task not found"); } });
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toEqual({
      title: "Couldn't rename task",
      message: 'Task not found.',
      variant: 'error',
    });
    expect(world.boardTasks[0].title).toBe('fix bug');
  });

  it('falls back to a plain body when the failed save carries no reason', async () => {
    installElectronApi({ updateImpl: () => { throw 'refused'; } });
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(addToast.mock.calls[0][0]).toMatchObject({
      title: "Couldn't rename task",
      message: 'The new title was not saved.',
    });
  });
});

// ---------------------------------------------------------------------------
// A task in a project that is not on screen
// ---------------------------------------------------------------------------

describe('scheduleAutoNameSuggestion - a task of another project', () => {
  beforeEach(() => {
    // project-2 is on screen; the session's task lives in project-1.
    world.currentProjectId = 'project-2';
    world.boardTasks = [makeTask({ id: 'other-task', title: 'Unrelated board task' })];
    world.mainTasks = { 'project-1': [makeTask({ title: 'fix bug', description: 'background description' })] };
  });

  it('reads the task from its own project and saves to that project', async () => {
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(getTaskDetail).toHaveBeenCalledWith('project-1', 'task-1');
    expect(summarize).toHaveBeenCalledWith({ prompt: 'background description', projectId: 'project-1', taskId: 'task-1' });
    expect(tasksUpdate).toHaveBeenCalledWith({ id: 'task-1', title: 'Fix OAuth redirect loop' }, 'project-1');
  });

  it('does not toast or touch the open board, and drops the project\'s warm snapshot', async () => {
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(addToast).not.toHaveBeenCalled();
    expect(boardWrites).toEqual([]);
    expect(world.boardTasks).toEqual([makeTask({ id: 'other-task', title: 'Unrelated board task' })]);
    expect(mocks.invalidateProject).toHaveBeenCalledWith('project-1');
  });

  it('skips a task of another project whose title is no longer a placeholder', async () => {
    world.mainTasks = { 'project-1': [makeTask({ title: 'Named in the other project' })] };
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(summarize).not.toHaveBeenCalled();
    expect(tasksUpdate).not.toHaveBeenCalled();
  });

  it('does not toast a failed save for a project that is not on screen', async () => {
    installElectronApi({ updateImpl: () => { throw new Error('task not found'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    world.activity = { 'session-1': 'idle' };

    await scheduleAndFire();

    expect(tasksUpdate).toHaveBeenCalledTimes(1);
    expect(addToast).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('toasts when the user switched to the task\'s project before the idle edge', async () => {
    await scheduleAndFire();
    expect(tasksUpdate).not.toHaveBeenCalled();

    // The user opens project-1; its board now holds the task.
    world.currentProjectId = 'project-1';
    world.boardTasks = [makeTask({ title: 'fix bug', description: 'background description' })];
    world.activity = { 'session-1': 'idle' };
    emitSessionChange();
    await flush();

    expect(tasksUpdate).toHaveBeenCalledWith({ id: 'task-1', title: 'Fix OAuth redirect loop' }, 'project-1');
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toMatchObject({ title: 'Task renamed' });
    expect(mocks.invalidateProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// automationAgentCanName - direct unit test
// ---------------------------------------------------------------------------

describe('automationAgentCanName', () => {
  it('returns false when no Automation agent is set', () => {
    world.automation = undefined;
    expect(automationAgentCanName()).toBe(false);
    world.automation = { agent: null, model: null, effort: null };
    expect(automationAgentCanName()).toBe(false);
  });

  it('returns false when the Automation agent is not in the agent list', () => {
    world.automation = { agent: 'unknown-agent', model: 'm', effort: null };
    expect(automationAgentCanName()).toBe(false);
  });

  it('returns false when the Automation agent is not detected on disk', () => {
    world.agents = [makeAdapter({ found: false })];
    expect(automationAgentCanName()).toBe(false);
  });

  it('returns false when the Automation agent does not support summarize', () => {
    world.agents = [makeAdapter({ supportsSummarize: false })];
    expect(automationAgentCanName()).toBe(false);
  });

  it('returns false when the Automation agent takes a model and none is chosen', () => {
    world.automation = { agent: 'claude', model: null, effort: null };
    expect(automationAgentCanName()).toBe(false);
  });

  it('returns true when the Automation agent is ready, whatever the project default agent is', () => {
    expect(automationAgentCanName()).toBe(true);
  });
});
