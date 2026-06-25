/**
 * Unit tests for the auto-name scheduler module
 * (`src/renderer/lib/auto-name-scheduler.ts`).
 *
 * Covers items #12-#15 from the prior coverage audit:
 *   - `markAutoNameAsked` (idempotent + persistence call shape)
 *   - `scheduleAutoNameSuggestion` (every precheck + timer body)
 *   - `maybeLabelTransientSession` (event-type filter, dedupe, capability gate)
 *
 * Strategy: mock all the Zustand stores and `window.electronAPI` directly. The
 * scheduler module reads stores via `getState()` and writes via `addToast`, so
 * we replace each store's `getState` to return our fixture. We also clear the
 * scheduler's module-level state between tests via `cancelAutoNameTimersAndClear`.
 *
 * The test file uses `vi.useFakeTimers` for the 30-second timer paths so the
 * full suite stays under 1 second.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, SessionEvent, AppConfig, AgentDetectionInfo } from '../../src/shared/types';
import { EventType } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted store mocks - declared via vi.hoisted so the factory closures below
// (which run before the test file's top-level body) can see them.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  useProjectStore: { getState: vi.fn() },
  useBoardStore: { getState: vi.fn() },
  useConfigStore: { getState: vi.fn() },
  useSessionStore: { getState: vi.fn() },
  useToastStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: mocks.useProjectStore }));
vi.mock('../../src/renderer/stores/board-store', () => ({ useBoardStore: mocks.useBoardStore }));
vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: mocks.useConfigStore }));
vi.mock('../../src/renderer/stores/session-store', () => ({ useSessionStore: mocks.useSessionStore }));
vi.mock('../../src/renderer/stores/toast-store', () => ({ useToastStore: mocks.useToastStore }));

const { useProjectStore, useBoardStore, useConfigStore, useSessionStore, useToastStore } = mocks;

// Imported AFTER mocks. Pulls in the scheduler module which reads `import.meta.hot`
// (undefined in vitest, harmless).
import {
  scheduleAutoNameSuggestion,
  maybeLabelTransientSession,
  markAutoNameAsked,
  projectAgentCanSummarize,
  cancelAutoNameTimersAndClear,
  autoNameTimers,
  autoNameAsked,
  autoNameLabeledTransient,
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
    ...overrides,
  };
}

interface ConfigFixture {
  autoNameAskedTaskIds?: string[];
}

function setupStores(options: {
  task?: ReturnType<typeof makeTask> | null;
  session?: Session | null;
  /** Subsequent reads return successive snapshots, simulating board mutations during the timer. */
  taskSequence?: Array<ReturnType<typeof makeTask> | null>;
  sessionSequence?: Array<Session | null>;
  agents?: AgentDetectionInfo[];
  projects?: Array<{ id: string; default_agent: string | null }>;
  transientSessions?: Record<string, { projectId: string; slot: string; sessionId: string; branch: string | null; label?: string }>;
  config?: ConfigFixture;
  updateConfig?: ReturnType<typeof vi.fn>;
  setTransientSessionLabel?: ReturnType<typeof vi.fn>;
  addToast?: ReturnType<typeof vi.fn>;
  updateTask?: ReturnType<typeof vi.fn>;
}) {
  const taskSeq = options.taskSequence ?? (options.task !== undefined ? [options.task] : [makeTask()]);
  const sessionSeq = options.sessionSequence ?? (options.session !== undefined ? [options.session] : [makeSession()]);
  let taskCallIndex = 0;
  let sessionCallIndex = 0;

  useBoardStore.getState.mockImplementation(() => ({
    tasks: (() => {
      const snapshot = taskSeq[Math.min(taskCallIndex, taskSeq.length - 1)];
      taskCallIndex += 1;
      return snapshot ? [snapshot] : [];
    })(),
    updateTask: options.updateTask ?? vi.fn(async () => {}),
  }));

  useSessionStore.getState.mockImplementation(() => ({
    sessions: (() => {
      const snapshot = sessionSeq[Math.min(sessionCallIndex, sessionSeq.length - 1)];
      sessionCallIndex += 1;
      return snapshot ? [snapshot] : [];
    })(),
    transientSessions: options.transientSessions ?? {},
    setTransientSessionLabel: options.setTransientSessionLabel ?? vi.fn(),
  }));

  useConfigStore.getState.mockReturnValue({
    config: {
      autoNameAskedTaskIds: options.config?.autoNameAskedTaskIds ?? [],
    } as Partial<AppConfig>,
    agentList: options.agents ?? [makeAdapter()],
    updateConfig: options.updateConfig ?? vi.fn(async () => {}),
  });

  useProjectStore.getState.mockReturnValue({
    projects: options.projects ?? [{ id: 'project-1', default_agent: 'claude' }],
  });

  useToastStore.getState.mockReturnValue({
    addToast: options.addToast ?? vi.fn(),
  });
}

function setupSummarizeApi(impl: (input: { prompt: string }) => Promise<unknown> | unknown): void {
  // The scheduler reads `window.electronAPI.agent.summarize` directly. In the
  // node test env vitest provides no `window`, so we attach to globalThis (which
  // is the same object the production code's `window` resolves to under jsdom).
  (globalThis as unknown as { window: Record<string, unknown> }).window = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
    agent: {
      summarize: vi.fn(async (input: { prompt: string }) => impl(input)),
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  cancelAutoNameTimersAndClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// #15: markAutoNameAsked
// ---------------------------------------------------------------------------

describe('markAutoNameAsked', () => {
  it('adds the taskId to the in-memory set and persists via updateConfig', () => {
    const updateConfig = vi.fn(async () => {});
    setupStores({ updateConfig, config: { autoNameAskedTaskIds: ['existing-1'] } });

    markAutoNameAsked('task-1');

    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith({
      autoNameAskedTaskIds: ['existing-1', 'task-1'],
    });
  });

  it('is idempotent: a second call for the same taskId does NOT call updateConfig again', () => {
    const updateConfig = vi.fn(async () => {});
    setupStores({ updateConfig });

    markAutoNameAsked('task-1');
    markAutoNameAsked('task-1');
    markAutoNameAsked('task-1');

    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('skips updateConfig when the persisted list already contains the taskId', () => {
    // Simulates the boot path: in-memory set is empty (post-clear) but the
    // persisted config already has the taskId from a prior app run.
    const updateConfig = vi.fn(async () => {});
    setupStores({
      updateConfig,
      config: { autoNameAskedTaskIds: ['task-1'] },
    });

    markAutoNameAsked('task-1');

    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #12: scheduleAutoNameSuggestion - prechecks
// ---------------------------------------------------------------------------

describe('scheduleAutoNameSuggestion - prechecks', () => {
  it('returns early when session is transient', () => {
    setupStores({});
    scheduleAutoNameSuggestion(makeSession({ transient: true }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when session.status is not running', () => {
    setupStores({});
    scheduleAutoNameSuggestion(makeSession({ status: 'queued' }));
    scheduleAutoNameSuggestion(makeSession({ status: 'suspended' }));
    scheduleAutoNameSuggestion(makeSession({ status: 'exited' }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when session has no taskId', () => {
    setupStores({});
    scheduleAutoNameSuggestion(makeSession({ taskId: '' }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the taskId is already in the asked set', () => {
    setupStores({});
    autoNameAsked.add('task-1');
    scheduleAutoNameSuggestion(makeSession({ taskId: 'task-1' }));
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when a timer for the taskId is already scheduled', () => {
    setupStores({ task: makeTask({ title: 'fix bug', description: 'real desc' }) });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(1);

    // Second call for the same taskId is a no-op.
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(1);
  });

  it('seeds the in-memory asked set from persisted config and returns early', () => {
    setupStores({ config: { autoNameAskedTaskIds: ['task-1'] } });
    scheduleAutoNameSuggestion(makeSession({ taskId: 'task-1' }));
    expect(autoNameAsked.has('task-1')).toBe(true);
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the task is not found on the board', () => {
    setupStores({ task: null });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the task title is NOT a placeholder', () => {
    setupStores({ task: makeTask({ title: 'A real meaningful task title' }) });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the task description is empty', () => {
    setupStores({ task: makeTask({ title: 'fix bug', description: '   ' }) });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the project default agent does not support summarize', () => {
    setupStores({
      task: makeTask({ title: 'fix bug' }),
      agents: [makeAdapter({ supportsSummarize: false })],
    });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('returns early when the project default agent is not found on disk', () => {
    setupStores({
      task: makeTask({ title: 'fix bug' }),
      agents: [makeAdapter({ found: false })],
    });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(0);
  });

  it('schedules a 30-second timer when all gates pass', () => {
    setupStores({ task: makeTask({ title: 'fix bug' }) });
    scheduleAutoNameSuggestion(makeSession());
    expect(autoNameTimers.size).toBe(1);
    expect(autoNameTimers.has('task-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #13: scheduleAutoNameSuggestion - timer body
// ---------------------------------------------------------------------------

describe('scheduleAutoNameSuggestion - timer body', () => {
  it('fires the rename toast when title is still placeholder and session is still running at 30s', async () => {
    const addToast = vi.fn();
    setupStores({
      task: makeTask({ title: 'fix bug', description: 'real description' }),
      addToast,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'Suggested Title' }));

    scheduleAutoNameSuggestion(makeSession());
    await vi.advanceTimersByTimeAsync(30_000);
    // Allow the async IPC promise + addToast to flush.
    await vi.runAllTimersAsync();

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining('Suggested Title'),
      action: expect.objectContaining({ label: 'Rename' }),
    });
  });

  it('skips the toast when the user manually renamed the task before the timer fired', async () => {
    const addToast = vi.fn();
    setupStores({
      // First read at schedule time: placeholder. Second read inside timer: real title.
      taskSequence: [
        makeTask({ title: 'fix bug', description: 'real description' }),
        makeTask({ title: 'User Manually Renamed' }),
      ],
      addToast,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'Should Not Toast' }));

    scheduleAutoNameSuggestion(makeSession());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();

    expect(addToast).not.toHaveBeenCalled();
  });

  it('skips the toast when the session is no longer running at 30s', async () => {
    const addToast = vi.fn();
    setupStores({
      task: makeTask({ title: 'fix bug' }),
      // Session crashed/suspended in the 30-second window.
      sessionSequence: [makeSession({ status: 'exited' })],
      addToast,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'Should Not Toast' }));

    scheduleAutoNameSuggestion(makeSession());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();

    expect(addToast).not.toHaveBeenCalled();
  });

  it('marks the task as asked even when the toast is skipped (so we do not retry next session)', async () => {
    const addToast = vi.fn();
    setupStores({
      taskSequence: [
        makeTask({ title: 'fix bug' }),
        makeTask({ title: 'Renamed' }),
      ],
      addToast,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'Title' }));

    scheduleAutoNameSuggestion(makeSession());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();

    expect(autoNameAsked.has('task-1')).toBe(true);
  });

  it('swallows summarize IPC errors silently (no toast)', async () => {
    const addToast = vi.fn();
    setupStores({ task: makeTask({ title: 'fix bug' }), addToast });
    setupSummarizeApi(() => { throw new Error('boom'); });

    scheduleAutoNameSuggestion(makeSession());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();

    expect(addToast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #14: maybeLabelTransientSession
// ---------------------------------------------------------------------------

describe('maybeLabelTransientSession', () => {
  function makePromptEvent(detail: string): SessionEvent {
    return { ts: Date.now(), type: EventType.Prompt, detail };
  }

  it('only fires for EventType.Prompt - other event types are ignored', () => {
    const setTransientSessionLabel = vi.fn();
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'transient-1', branch: null } },
      setTransientSessionLabel,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'should not fire' }));

    const nonPromptEvent: SessionEvent = { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' };
    maybeLabelTransientSession('transient-1', nonPromptEvent);

    expect(autoNameLabeledTransient.has('transient-1')).toBe(false);
    expect(setTransientSessionLabel).not.toHaveBeenCalled();
  });

  it('skips sessions already in the labeled set (first prompt wins)', async () => {
    const setTransientSessionLabel = vi.fn();
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'transient-1', branch: null } },
      setTransientSessionLabel,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'derived' }));

    autoNameLabeledTransient.add('transient-1');
    maybeLabelTransientSession('transient-1', makePromptEvent('hello'));
    await vi.runAllTimersAsync();

    expect(setTransientSessionLabel).not.toHaveBeenCalled();
  });

  it('skips when sessionId is not in the transient sessions map', () => {
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'other-session', branch: null } },
    });
    maybeLabelTransientSession('unknown-session', makePromptEvent('hello'));

    expect(autoNameLabeledTransient.has('unknown-session')).toBe(false);
  });

  it('skips when prompt detail is empty/whitespace', () => {
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'transient-1', branch: null } },
    });
    maybeLabelTransientSession('transient-1', makePromptEvent('   '));
    maybeLabelTransientSession('transient-1', makePromptEvent(''));

    expect(autoNameLabeledTransient.has('transient-1')).toBe(false);
  });

  it('skips when the owning project agent does not support summarize', () => {
    const setTransientSessionLabel = vi.fn();
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'transient-1', branch: null } },
      agents: [makeAdapter({ supportsSummarize: false })],
      setTransientSessionLabel,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'should not fire' }));

    maybeLabelTransientSession('transient-1', makePromptEvent('hello world'));

    expect(autoNameLabeledTransient.has('transient-1')).toBe(false);
    expect(setTransientSessionLabel).not.toHaveBeenCalled();
  });

  it('calls setTransientSessionLabel with the suggested title on summarize success', async () => {
    const setTransientSessionLabel = vi.fn();
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'transient-1', branch: null } },
      setTransientSessionLabel,
    });
    setupSummarizeApi(() => ({ ok: true, title: 'Add Logging To Auth Module' }));

    maybeLabelTransientSession('transient-1', makePromptEvent('add logging to the auth module'));
    await vi.runAllTimersAsync();

    expect(setTransientSessionLabel).toHaveBeenCalledTimes(1);
    expect(setTransientSessionLabel).toHaveBeenCalledWith('transient-1', 'Add Logging To Auth Module');
    expect(autoNameLabeledTransient.has('transient-1')).toBe(true);
  });

  it('does not call setTransientSessionLabel when summarize returns ok:false', async () => {
    const setTransientSessionLabel = vi.fn();
    setupStores({
      transientSessions: { 'project-1::slot-1': { projectId: 'project-1', slot: 'slot-1', sessionId: 'transient-1', branch: null } },
      setTransientSessionLabel,
    });
    setupSummarizeApi(() => ({ ok: false, reason: 'rate limited' }));

    maybeLabelTransientSession('transient-1', makePromptEvent('test prompt'));
    await vi.runAllTimersAsync();

    expect(setTransientSessionLabel).not.toHaveBeenCalled();
    // The session is still added to the labeled set so we don't retry on the next prompt.
    expect(autoNameLabeledTransient.has('transient-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projectAgentCanSummarize - direct unit test (used by both schedulers)
// ---------------------------------------------------------------------------

describe('projectAgentCanSummarize', () => {
  it('returns false when projectId is null/undefined/empty', () => {
    setupStores({});
    expect(projectAgentCanSummarize(null)).toBe(false);
    expect(projectAgentCanSummarize(undefined)).toBe(false);
    expect(projectAgentCanSummarize('')).toBe(false);
  });

  it('returns false when project is not found', () => {
    setupStores({ projects: [] });
    expect(projectAgentCanSummarize('project-1')).toBe(false);
  });

  it('returns false when the project has no default_agent', () => {
    setupStores({ projects: [{ id: 'project-1', default_agent: null }] });
    expect(projectAgentCanSummarize('project-1')).toBe(false);
  });

  it('returns false when the agent is not in the agent list', () => {
    setupStores({
      projects: [{ id: 'project-1', default_agent: 'unknown-agent' }],
    });
    expect(projectAgentCanSummarize('project-1')).toBe(false);
  });

  it('returns false when the agent is in the list but not detected on disk', () => {
    setupStores({ agents: [makeAdapter({ found: false })] });
    expect(projectAgentCanSummarize('project-1')).toBe(false);
  });

  it('returns false when the agent is detected but does not support summarize', () => {
    setupStores({ agents: [makeAdapter({ supportsSummarize: false })] });
    expect(projectAgentCanSummarize('project-1')).toBe(false);
  });

  it('returns true when project default agent is detected and supports summarize', () => {
    setupStores({});
    expect(projectAgentCanSummarize('project-1')).toBe(true);
  });
});
