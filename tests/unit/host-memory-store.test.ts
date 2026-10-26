/**
 * Unit tests for the host memory store (`src/renderer/stores/host-memory-store.ts`):
 * the Windows low-memory warning (Sentry DESKTOP-16) and the list of agents
 * low memory paused, with the toast that counts them.
 *
 * The REAL toast store runs here (only the config store is stubbed), because
 * the paused list follows its toast: an update in place, and a dismissal that
 * clears the list, are both observed through the toast store itself.
 *
 * The session store is a small real zustand store holding only `sessions`, so
 * its `subscribe` fires as the real one does when an agent comes back, without
 * loading the real store's project, config and terminal-focus imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostMemoryAgentPausedEvent, HostMemoryPressureEvent, HostMemorySample, Session, SessionStatus } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  setLastSettingsTab: vi.fn(),
  setSettingsOpen: vi.fn(),
}));

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({
      config: { notifications: { toasts: { durationSeconds: 4, maxCount: 5 } } },
      setLastSettingsTab: mocks.setLastSettingsTab,
      setSettingsOpen: mocks.setSettingsOpen,
    }),
  },
}));

vi.mock('../../src/renderer/stores/session-store', async () => {
  const { create } = await import('zustand');
  return { useSessionStore: create<{ sessions: Session[] }>(() => ({ sessions: [] })) };
});

import { pausedToastCopy, useHostMemoryStore } from '../../src/renderer/stores/host-memory-store';
import { useToastStore } from '../../src/renderer/stores/toast-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';

function makeSample(overrides: Partial<HostMemorySample> = {}): HostMemorySample {
  return {
    ts: '2026-09-16T14:24:24.000Z',
    platform: 'win32',
    commitLimitBytes: 96_432_717_824,
    commitRemainingBytes: 1.6 * 1024 * 1024 * 1024,
    physicalTotalBytes: 34_060_931_072,
    physicalFreeBytes: 5_005_045_760,
    physicalAvailableBytes: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<HostMemoryPressureEvent> = {}): HostMemoryPressureEvent {
  return { sample: makeSample(), activeAgentCount: 3, ...overrides };
}

function makePaused(taskId: string, overrides: Partial<HostMemoryAgentPausedEvent> = {}): HostMemoryAgentPausedEvent {
  return {
    pausedAt: '2026-10-21T12:00:00.000Z',
    taskId,
    projectId: 'proj-1',
    taskTitle: `Task ${taskId}`,
    projectName: 'kangentic',
    waitedMs: 20 * 60_000,
    ...overrides,
  };
}

function toastById(id: string | null) {
  return useToastStore.getState().toasts.find((toast) => toast.id === id);
}

/** The paused agents in these tests are paused at 12:00; these sessions start either side of it. */
const BEFORE_PAUSE = '2026-10-21T11:30:00.000Z';
const AFTER_PAUSE = '2026-10-21T12:30:00.000Z';

function makeSession(taskId: string, status: SessionStatus, startedAt: string): Session {
  return {
    id: `sess-${taskId}-${startedAt}`,
    taskId,
    projectId: 'proj-1',
    pid: 4242,
    status,
    shell: 'bash',
    cwd: '/mock/host-memory',
    startedAt,
    exitCode: null,
    resuming: true,
    agentSessionId: null,
  };
}

/** A session pushed into the replica, one row per task as `upsertSession` keeps it. */
function upsertSession(session: Session): void {
  useSessionStore.setState((state) => ({
    sessions: [...state.sessions.filter((existing) => existing.taskId !== session.taskId), session],
  }));
}

/** A session row leaving the replica: its task moved to To Do, or was deleted. */
function removeSession(taskId: string): void {
  useSessionStore.setState((state) => ({
    sessions: state.sessions.filter((existing) => existing.taskId !== taskId),
  }));
}

beforeEach(() => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismissToast(toast.id);
  useSessionStore.setState({ sessions: [] });
  useHostMemoryStore.setState({ lastEvent: null, pressureToastId: null, pausedAgents: [], pausedOutcomes: {}, pausedToastId: null, reviewOpen: false });
  mocks.setLastSettingsTab.mockClear();
  mocks.setSettingsOpen.mockClear();
});

describe('the low-memory warning', () => {
  it('raises a persistent warning titled Low on memory, with the headroom as its body', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());

    const toast = toastById(useHostMemoryStore.getState().pressureToastId);
    expect(toast?.title).toBe('Low on memory');
    expect(toast?.message).toBe('1.6 GB of memory reservations left.');
    expect(toast?.variant).toBe('warning');
    // A machine about to run out of memory must not have its warning vanish on its own.
    expect(toast?.persistent).toBe(true);
    expect(toast?.since).toBe('2026-09-16T14:24:24.000Z');
  });

  it('says how little is left without a wrong number when there is no commit reading', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent({ sample: makeSample({ commitRemainingBytes: null }) }));

    expect(toastById(useHostMemoryStore.getState().pressureToastId)?.message).toBe('Almost no memory reservations left.');
  });

  it('carries a Settings button that opens Settings on the Behavior tab, where Max concurrent sessions lives', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    const action = toastById(useHostMemoryStore.getState().pressureToastId)?.action;
    expect(action?.label).toBe('Settings');
    expect(action?.icon).toBe('settings');

    action?.onClick();

    expect(mocks.setLastSettingsTab).toHaveBeenCalledWith('behavior');
    expect(mocks.setSettingsOpen).toHaveBeenCalledWith(true);
    // The tab is chosen before the panel opens, so the panel's mount reads it.
    expect(mocks.setLastSettingsTab.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setSettingsOpen.mock.invocationCallOrder[0]);
  });

  it('replaces rather than stacks on a second pressure event', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    const firstToastId = useHostMemoryStore.getState().pressureToastId;

    useHostMemoryStore.getState().receivePressureEvent(makeEvent());

    expect(toastById(firstToastId)).toBeUndefined();
    expect(useToastStore.getState().toasts.filter((toast) => toast.title === 'Low on memory')).toHaveLength(1);
  });

  it('is dismissed on recovery, and the store clears', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    const toastId = useHostMemoryStore.getState().pressureToastId;

    useHostMemoryStore.getState().receiveRecovery();

    expect(toastById(toastId)).toBeUndefined();
    expect(useHostMemoryStore.getState().pressureToastId).toBeNull();
    expect(useHostMemoryStore.getState().lastEvent).toBeNull();
  });

  it('nulls a stale warning id on recovery even when nothing on screen matches', () => {
    useHostMemoryStore.setState({ pressureToastId: 'stale-toast-id' });
    expect(() => useHostMemoryStore.getState().receiveRecovery()).not.toThrow();
    expect(useHostMemoryStore.getState().pressureToastId).toBeNull();
  });
});

describe('the paused list and its toast', () => {
  it('raises one persistent info toast for the first pause, with a Review button and the pause time', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));

    const toast = toastById(useHostMemoryStore.getState().pausedToastId);
    expect(toast?.title).toBe('Idle agent paused');
    expect(toast?.message).toBe('Kangentic paused it to free memory.');
    expect(toast?.variant).toBe('info');
    expect(toast?.persistent).toBe(true);
    expect(toast?.since).toBe('2026-10-21T12:00:00.000Z');
    expect(toast?.action?.label).toBe('Review');
    expect(toast?.action?.icon).toBe('review');
  });

  it('updates the same toast in place as more agents are paused, rather than stacking', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2', { pausedAt: '2026-10-21T12:01:00.000Z' }));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-3', { pausedAt: '2026-10-21T12:02:00.000Z' }));

    expect(useHostMemoryStore.getState().pausedToastId).toBe(toastId);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    const toast = toastById(toastId);
    expect(toast?.title).toBe('3 idle agents paused');
    expect(toast?.message).toBe('Kangentic paused them to free memory.');
    // The age follows the latest pause.
    expect(toast?.since).toBe('2026-10-21T12:02:00.000Z');
    expect(useHostMemoryStore.getState().pausedAgents.map((entry) => entry.taskId)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('keeps one row per task when a task is paused again', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1', { waitedMs: 5 * 60_000 }));

    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(1);
    expect(toastById(useHostMemoryStore.getState().pausedToastId)?.title).toBe('Idle agent paused');
  });

  it('opens the Review list from the toast button', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    toastById(useHostMemoryStore.getState().pausedToastId)?.action?.onClick();
    expect(useHostMemoryStore.getState().reviewOpen).toBe(true);
  });

  it('clears the list when the toast is dismissed, so the next pause starts again at 1', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    useToastStore.getState().dismissToast(toastId ?? '');

    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);
    expect(useHostMemoryStore.getState().pausedToastId).toBeNull();

    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-3'));
    expect(toastById(useHostMemoryStore.getState().pausedToastId)?.title).toBe('Idle agent paused');
  });

  it('keeps an open Review list when the toast goes, and clears it when the list closes', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    useHostMemoryStore.getState().openReview();
    expect(useHostMemoryStore.getState().reviewOpen).toBe(true);

    useToastStore.getState().dismissToast(toastId ?? '');

    // The dialog stays under the user's pointer until they close it.
    expect(useHostMemoryStore.getState().reviewOpen).toBe(true);
    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(1);
    expect(useHostMemoryStore.getState().pausedToastId).toBeNull();

    useHostMemoryStore.getState().closeReview();

    expect(useHostMemoryStore.getState().reviewOpen).toBe(false);
    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);
  });

  it('keeps the list when the Review list closes while its toast is still up', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().openReview();

    useHostMemoryStore.getState().closeReview();

    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(1);
    expect(toastById(useHostMemoryStore.getState().pausedToastId)?.title).toBe('Idle agent paused');
  });

  it('leaves the paused toast up when memory recovers: the agents stay paused', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const pausedToastId = useHostMemoryStore.getState().pausedToastId;

    useHostMemoryStore.getState().receiveRecovery();

    expect(toastById(pausedToastId)?.title).toBe('Idle agent paused');
    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(1);
  });

  it('words the copy for one agent and for several', () => {
    expect(pausedToastCopy(1)).toEqual({ title: 'Idle agent paused', message: 'Kangentic paused it to free memory.' });
    expect(pausedToastCopy(2)).toEqual({ title: '2 idle agents paused', message: 'Kangentic paused them to free memory.' });
  });
});

describe('the paused toast as agents come back', () => {
  it('closes when the only paused agent is running again, and the list clears', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));

    expect(toastById(toastId)).toBeUndefined();
    expect(useHostMemoryStore.getState().pausedToastId).toBeNull();
    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);
  });

  it('counts down in place when one of several comes back', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-3'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    upsertSession(makeSession('task-2', 'running', AFTER_PAUSE));

    expect(useHostMemoryStore.getState().pausedToastId).toBe(toastId);
    expect(toastById(toastId)?.title).toBe('2 idle agents paused');
    expect(toastById(toastId)?.message).toBe('Kangentic paused them to free memory.');
    // The resumed row stays in the list, where it reads Running.
    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(3);

    upsertSession(makeSession('task-3', 'queued', AFTER_PAUSE));
    expect(toastById(toastId)?.title).toBe('Idle agent paused');
    expect(toastById(toastId)?.message).toBe('Kangentic paused it to free memory.');
  });

  it('stays up when the push lands while the replica still lists the paused session as running', () => {
    // The pause push and the suspend's status push travel separately.
    upsertSession(makeSession('task-1', 'running', BEFORE_PAUSE));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    // Any later change to the sessions runs the watch: an unrelated agent...
    upsertSession(makeSession('task-other', 'running', AFTER_PAUSE));
    expect(toastById(toastId)?.title).toBe('Idle agent paused');

    // ...and the suspend landing.
    upsertSession(makeSession('task-1', 'suspended', BEFORE_PAUSE));
    expect(toastById(toastId)?.title).toBe('Idle agent paused');
    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(1);
  });

  it('stays up for a paused session, however late it started', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    // A restart's placeholder: suspended, started after the pause.
    upsertSession(makeSession('task-1', 'suspended', AFTER_PAUSE));

    expect(toastById(toastId)?.title).toBe('Idle agent paused');
  });

  it('with Review open, takes the toast down when the last agent comes back but keeps the list until it closes', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    useHostMemoryStore.getState().openReview();

    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));

    expect(toastById(toastId)).toBeUndefined();
    expect(useHostMemoryStore.getState().reviewOpen).toBe(true);
    expect(useHostMemoryStore.getState().pausedAgents.map((entry) => entry.taskId)).toEqual(['task-1']);

    useHostMemoryStore.getState().closeReview();
    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);

    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2', { pausedAt: '2026-10-21T13:00:00.000Z' }));
    expect(toastById(useHostMemoryStore.getState().pausedToastId)?.title).toBe('Idle agent paused');
  });

  it('counts only the agents still paused when another is paused', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));

    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-3', { pausedAt: '2026-10-21T12:45:00.000Z' }));

    expect(toastById(useHostMemoryStore.getState().pausedToastId)?.title).toBe('2 idle agents paused');
  });

  it('counts a task paused again after it came back, even before its suspend reaches the replica', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    expect(toastById(toastId)?.title).toBe('Idle agent paused');

    // Paused again after its resumed session started; the replica still lists that session as running.
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1', { pausedAt: '2026-10-21T12:45:00.000Z' }));

    expect(toastById(toastId)?.title).toBe('2 idle agents paused');
  });
});

describe('what became of each paused agent', () => {
  it.each(['suspended', 'exited'] as const)('does not count an agent again that came back and then went %s', (stoppedStatus) => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    const toastId = useHostMemoryStore.getState().pausedToastId;

    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));
    expect(toastById(toastId)?.title).toBe('Idle agent paused');
    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('came-back');

    // The same session stops. A level test would count task-1 as paused again.
    upsertSession(makeSession('task-1', stoppedStatus, AFTER_PAUSE));
    expect(toastById(toastId)?.title).toBe('Idle agent paused');
    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('came-back');

    // task-2 is the only one still paused, so its return closes the toast.
    upsertSession(makeSession('task-2', 'running', AFTER_PAUSE));
    expect(toastById(toastId)).toBeUndefined();
  });

  it('drops a paused task from the count when its session leaves the replica', () => {
    // Both tasks have their paused (suspended) session in the replica before the pauses arrive.
    upsertSession(makeSession('task-1', 'suspended', BEFORE_PAUSE));
    upsertSession(makeSession('task-2', 'suspended', BEFORE_PAUSE));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    expect(toastById(toastId)?.title).toBe('2 idle agents paused');

    // task-1 is moved to To Do or deleted.
    removeSession('task-1');

    expect(toastById(toastId)?.title).toBe('Idle agent paused');
    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('gone');

    removeSession('task-2');

    expect(toastById(toastId)).toBeUndefined();
    expect(useHostMemoryStore.getState().pausedToastId).toBeNull();
    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);
    expect(useHostMemoryStore.getState().pausedOutcomes).toEqual({});
  });

  it('still notes a comeback when the toast was closed by hand and Review is open', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    useHostMemoryStore.getState().openReview();
    useToastStore.getState().dismissToast(toastId ?? '');
    // The list stays under the open dialog, with no toast beside it.
    expect(useHostMemoryStore.getState().pausedToastId).toBeNull();
    expect(useHostMemoryStore.getState().pausedAgents).toHaveLength(1);

    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));

    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('came-back');
    // Noting the outcome raises no toast of its own.
    expect(useToastStore.getState().toasts).toHaveLength(0);

    upsertSession(makeSession('task-1', 'suspended', AFTER_PAUSE));
    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('came-back');

    // Closing Review ends the list, and the outcomes with it.
    useHostMemoryStore.getState().closeReview();
    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);
    expect(useHostMemoryStore.getState().pausedOutcomes).toEqual({});
  });

  it('forgets the outcome of a task paused again after it came back, and counts it as paused', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-2'));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    upsertSession(makeSession('task-1', 'running', AFTER_PAUSE));
    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('came-back');
    expect(toastById(toastId)?.title).toBe('Idle agent paused');

    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1', { pausedAt: '2026-10-21T12:45:00.000Z' }));

    expect(useHostMemoryStore.getState().pausedOutcomes).not.toHaveProperty('task-1');
    expect(toastById(toastId)?.title).toBe('2 idle agents paused');

    // The suspend of the resumed session lands: still paused, still counted.
    upsertSession(makeSession('task-1', 'suspended', AFTER_PAUSE));
    expect(useHostMemoryStore.getState().pausedOutcomes).not.toHaveProperty('task-1');
    expect(toastById(toastId)?.title).toBe('2 idle agents paused');

    // A resume after the second pause is a fresh comeback.
    upsertSession(makeSession('task-1', 'running', '2026-10-21T13:00:00.000Z'));
    expect(useHostMemoryStore.getState().pausedOutcomes['task-1']).toBe('came-back');
    expect(toastById(toastId)?.title).toBe('Idle agent paused');
  });
});
