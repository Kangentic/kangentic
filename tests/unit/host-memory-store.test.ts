/**
 * Unit tests for the host memory store (`src/renderer/stores/host-memory-store.ts`):
 * the Windows low-memory warning (Sentry DESKTOP-16) and the list of agents
 * low memory paused, with the toast that counts them.
 *
 * The REAL toast store runs here (only the config store is stubbed), because
 * the paused list follows its toast: an update in place, and a dismissal that
 * clears the list, are both observed through the toast store itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostMemoryAgentPausedEvent, HostMemoryPressureEvent, HostMemorySample } from '../../src/shared/types';

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

import { pausedToastCopy, useHostMemoryStore } from '../../src/renderer/stores/host-memory-store';
import { useToastStore } from '../../src/renderer/stores/toast-store';

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

beforeEach(() => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismissToast(toast.id);
  useHostMemoryStore.setState({ lastEvent: null, pressureToastId: null, pausedAgents: [], pausedToastId: null, reviewOpen: false });
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

  it('closes an open Review list when the toast is dismissed, since the list it shows is gone', () => {
    useHostMemoryStore.getState().receiveAgentPaused(makePaused('task-1'));
    const toastId = useHostMemoryStore.getState().pausedToastId;
    useHostMemoryStore.getState().openReview();
    expect(useHostMemoryStore.getState().reviewOpen).toBe(true);

    useToastStore.getState().dismissToast(toastId ?? '');

    expect(useHostMemoryStore.getState().reviewOpen).toBe(false);
    expect(useHostMemoryStore.getState().pausedAgents).toEqual([]);
    expect(useHostMemoryStore.getState().pausedToastId).toBeNull();
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
