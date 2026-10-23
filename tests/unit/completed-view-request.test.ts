/**
 * The session store's one-shot "show a completed task's view" request:
 * `requestCompletedView` and `clearCompletedViewRequest` in
 * task-changes-panel-slice.ts.
 *
 * Whatever opens a completed task from outside (the archived card menu's Show
 * changes and View conversation) posts a request naming the task and the tab.
 * The completed view applies it when it mounts or when one arrives for its task,
 * then clears it. The contract that keeps two views from stealing each other's
 * request is on the clear side: a view only clears the request that is still the
 * one for ITS task.
 *
 * Pinned:
 *
 * 1. A clear for ANOTHER task leaves the pending request in place (the same
 *    object, untouched).
 *    Red condition: drop the `get().completedViewRequest?.taskId !== taskId`
 *    guard from `clearCompletedViewRequest` and this fails - any view's clear
 *    wipes a request that was meant for someone else.
 * 2. A clear for the matching task sets the request to null.
 * 3. A second `requestCompletedView` replaces the first outright, and a clear for
 *    the REPLACED task's id then leaves the newer request alone. There is no
 *    queue: the latest request wins.
 *
 * Drives the real Zustand store with `window.electronAPI` stubbed, the way
 * session-store-remove-session.test.ts does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      reconcile: async () => null,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
      getFirstOutput: async () => ({}),
      getMessageTrails: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';
import type { CompletedViewRequest } from '../../src/renderer/stores/session-store/task-changes-panel-slice';

beforeEach(() => {
  useSessionStore.setState({ completedViewRequest: null });
});

describe('requestCompletedView', () => {
  it('starts with no pending request', () => {
    expect(useSessionStore.getState().completedViewRequest).toBeNull();
  });

  it('stores the request, including the Conversation tab target, for the view to apply', () => {
    const request: CompletedViewRequest = {
      taskId: 'task-1',
      tab: 'conversation',
      conversationTab: { swimlaneId: 'lane-review' },
    };

    useSessionStore.getState().requestCompletedView(request);

    expect(useSessionStore.getState().completedViewRequest).toEqual(request);
  });

  it('replaces a pending request for another task with the newer one', () => {
    const first: CompletedViewRequest = { taskId: 'task-1', tab: 'changes' };
    const second: CompletedViewRequest = { taskId: 'task-2', tab: 'conversation' };

    useSessionStore.getState().requestCompletedView(first);
    useSessionStore.getState().requestCompletedView(second);

    expect(useSessionStore.getState().completedViewRequest).toBe(second);
  });

  it('replaces a pending request for the same task, so the newest tab wins', () => {
    useSessionStore.getState().requestCompletedView({ taskId: 'task-1', tab: 'changes' });
    useSessionStore.getState().requestCompletedView({ taskId: 'task-1', tab: 'summary' });

    expect(useSessionStore.getState().completedViewRequest).toEqual({ taskId: 'task-1', tab: 'summary' });
  });
});

describe('clearCompletedViewRequest', () => {
  it('leaves the pending request in place when the clear is for another task', () => {
    const request: CompletedViewRequest = { taskId: 'task-1', tab: 'changes' };
    useSessionStore.getState().requestCompletedView(request);

    useSessionStore.getState().clearCompletedViewRequest('task-2');

    expect(useSessionStore.getState().completedViewRequest).toBe(request);
  });

  it('sets the request to null when the clear is for the matching task', () => {
    useSessionStore.getState().requestCompletedView({ taskId: 'task-1', tab: 'changes' });

    useSessionStore.getState().clearCompletedViewRequest('task-1');

    expect(useSessionStore.getState().completedViewRequest).toBeNull();
  });

  it('is harmless when no request is pending', () => {
    expect(() => useSessionStore.getState().clearCompletedViewRequest('task-1')).not.toThrow();

    expect(useSessionStore.getState().completedViewRequest).toBeNull();
  });

  it('does not let a clear for the task a newer request replaced erase that newer request', () => {
    const first: CompletedViewRequest = { taskId: 'task-1', tab: 'changes' };
    const second: CompletedViewRequest = { taskId: 'task-2', tab: 'conversation' };
    useSessionStore.getState().requestCompletedView(first);
    useSessionStore.getState().requestCompletedView(second);

    // task-1's view finishes applying its (now replaced) request and clears it.
    useSessionStore.getState().clearCompletedViewRequest('task-1');

    expect(useSessionStore.getState().completedViewRequest).toBe(second);
  });
});
