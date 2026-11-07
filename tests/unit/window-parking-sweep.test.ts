/**
 * The sweep that ends a park, for the windows the agent's `open_pane` creates. A
 * parked window with no guest is dropped, and a window born parked has none until
 * the page's `dom-ready`, so without the grace the sweep would eat it before its
 * page loaded and the agent's call would time out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { monitorWindowManager, useWindowStore } from '../../src/renderer/window-manager/store/window-store';
import { markLayerMounted } from '../../src/renderer/window-manager/store/layer-mount-registry';
import { monitorDetailAnchor } from '../../src/renderer/window-manager/store/monitor-anchor';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { monitorMountsDetail, startParkedWindowReaper, sweepHiddenPanes } from '../../src/renderer/window-manager/bridge/window-parking';
import type { Project, Session } from '../../src/shared/types';

const PROJECT = 'project-a';
const TASK = 'task-a';
const NOW = 1_000_000;

function resetStores(): void {
  useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null });
  monitorWindowManager.store.setState({ windows: {}, order: [], focusedWindowId: null });
  useProjectStore.setState({ currentProject: { id: PROJECT } as Project });
  const running = { id: 'session-a', taskId: TASK, status: 'running' } as Session;
  useSessionStore.setState({
    sessions: [running],
    _sessionByTaskId: new Map([[TASK, running]]),
    browserOpenTasks: new Set([TASK]),
    browserHeldTasks: new Set(),
    browserGuestTasks: new Set(),
  });
}

function openParked(guestPendingUntil?: number): string {
  return useWindowStore.getState().openWindow({
    anchor: TASK,
    sessionId: 'session-a',
    title: 'Task',
    parked: true,
    guestPendingUntil,
  });
}

function guestArrives(): void {
  useSessionStore.setState({ browserGuestTasks: new Set([TASK]) });
}

beforeEach(resetStores);

describe('sweepHiddenPanes', () => {
  it('keeps a window born parked until its grace ends, and says when that is', () => {
    const id = openParked(NOW + 500);

    expect(sweepHiddenPanes(NOW)).toBe(NOW + 500);

    expect(useWindowStore.getState().windows[id]).toBeDefined();
  });

  it('drops it after the grace if no guest ever came', () => {
    openParked(NOW + 500);

    expect(sweepHiddenPanes(NOW + 501)).toBeNull();

    expect(useWindowStore.getState().windows).toEqual({});
  });

  it('keeps it past the grace once a guest landed', () => {
    const id = openParked(NOW + 500);
    guestArrives();

    expect(sweepHiddenPanes(NOW + 501)).toBeNull();

    expect(useWindowStore.getState().windows[id]).toBeDefined();
  });

  it('still drops a window parked with no grace and no guest', () => {
    openParked();

    sweepHiddenPanes(NOW);

    expect(useWindowStore.getState().windows).toEqual({});
  });

  it('answers with the earliest grace among several', () => {
    useWindowStore.getState().openWindow({ anchor: 'task-later', sessionId: null, title: 'Later', parked: true, guestPendingUntil: NOW + 900 });
    openParked(NOW + 300);

    expect(sweepHiddenPanes(NOW)).toBe(NOW + 300);
  });
});

describe('a parked window held by a retained project', () => {
  let unmountMonitorLayer: (() => void) | null = null;

  afterEach(() => {
    unmountMonitorLayer?.();
    unmountMonitorLayer = null;
  });

  const openRetainedParked = (): string => {
    const id = openParked();
    const window = useWindowStore.getState().windows[id];
    useWindowStore.setState({ windows: { ...useWindowStore.getState().windows, [id]: { ...window, retainedProjectId: 'project-b' } } });
    guestArrives();
    return id;
  };

  const mountMonitorShowing = (projectId: string): void => {
    monitorWindowManager.store.getState().openWindow({
      kind: 'task-detail',
      anchor: monitorDetailAnchor(projectId, TASK),
      sessionId: null,
      title: 'Task',
    });
    unmountMonitorLayer = markLayerMounted(monitorWindowManager);
  };

  it('is judged against its own project: a Monitor showing that project drops it', () => {
    const id = openRetainedParked();
    mountMonitorShowing('project-b');

    sweepHiddenPanes(NOW);

    expect(useWindowStore.getState().windows[id]).toBeUndefined();
  });

  it('is not dropped by a Monitor showing the same task id under the current project', () => {
    const id = openRetainedParked();
    mountMonitorShowing(PROJECT);

    sweepHiddenPanes(NOW);

    expect(useWindowStore.getState().windows[id]).toBeDefined();
  });
});

describe('startParkedWindowReaper', () => {
  let stopReaper: (() => void) | null = null;
  let unmountMonitorLayer: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    stopReaper?.();
    stopReaper = null;
    unmountMonitorLayer?.();
    unmountMonitorLayer = null;
    vi.useRealTimers();
  });

  const monitorWindowFor = (): void => {
    monitorWindowManager.store.getState().openWindow({
      kind: 'task-detail',
      anchor: monitorDetailAnchor(PROJECT, TASK),
      sessionId: null,
      title: 'Task',
    });
  };

  it('drops a window born parked when its grace passes, with no store write to wake it', () => {
    const id = openParked(NOW + 500);
    stopReaper = startParkedWindowReaper();

    vi.advanceTimersByTime(499);
    expect(useWindowStore.getState().windows[id]).toBeDefined();

    vi.advanceTimersByTime(2);
    expect(useWindowStore.getState().windows[id]).toBeUndefined();
  });

  it('clears its timer when stopped, so time passing drops nothing', () => {
    const id = openParked(NOW + 500);
    stopReaper = startParkedWindowReaper();
    expect(vi.getTimerCount()).toBe(1);

    stopReaper();
    stopReaper = null;
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(useWindowStore.getState().windows[id]).toBeDefined();
  });

  it('leaves no orphan timer when its own drop re-enters the pass', () => {
    // The sweep's closeWindow comes back through the window store subscription
    // and arms a timer for the window still inside its grace. The outer pass must
    // replace that timer, not overwrite it.
    // The reaper subscribes after its first pass, so the re-entry only happens on
    // a pass the subscription starts: open the expiring window once it runs.
    const waiting = useWindowStore.getState().openWindow({ anchor: 'task-waiting', sessionId: null, title: 'Waiting', parked: true, guestPendingUntil: NOW + 500 });
    stopReaper = startParkedWindowReaper();
    useWindowStore.getState().openWindow({ anchor: 'task-expired', sessionId: null, title: 'Expired', parked: true, guestPendingUntil: NOW - 1 });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([waiting]);

    stopReaper();
    stopReaper = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a parked window when a Monitor window for its task opens in a mounted layer', () => {
    unmountMonitorLayer = markLayerMounted(monitorWindowManager);
    const id = openParked();
    guestArrives();
    stopReaper = startParkedWindowReaper();
    expect(useWindowStore.getState().windows[id]).toBeDefined();

    monitorWindowFor();

    expect(useWindowStore.getState().windows[id]).toBeUndefined();
  });

  it('drops a parked window when the Monitor layer mounts over a window it already holds', () => {
    monitorWindowFor();
    const id = openParked();
    guestArrives();
    stopReaper = startParkedWindowReaper();
    expect(useWindowStore.getState().windows[id]).toBeDefined();

    unmountMonitorLayer = markLayerMounted(monitorWindowManager);

    expect(useWindowStore.getState().windows[id]).toBeUndefined();
  });
});

describe('a parked window when the Agent Monitor takes its task', () => {
  let unmountMonitorLayer: (() => void) | null = null;

  afterEach(() => {
    unmountMonitorLayer?.();
    unmountMonitorLayer = null;
  });

  const mountMonitorWithTask = (): void => {
    monitorWindowManager.store.getState().openWindow({
      kind: 'task-detail',
      anchor: monitorDetailAnchor(PROJECT, TASK),
      sessionId: null,
      title: 'Task',
    });
    unmountMonitorLayer = markLayerMounted(monitorWindowManager);
  };

  it('is dropped, so the task never has two guests', () => {
    const id = openParked();
    guestArrives();
    mountMonitorWithTask();

    sweepHiddenPanes(NOW);

    expect(useWindowStore.getState().windows[id]).toBeUndefined();
  });

  it('survives a Monitor window with no layer mounted, which mounts no pane', () => {
    const id = openParked();
    guestArrives();
    monitorWindowManager.store.getState().openWindow({
      kind: 'task-detail',
      anchor: monitorDetailAnchor(PROJECT, TASK),
      sessionId: null,
      title: 'Task',
    });

    expect(monitorMountsDetail(PROJECT, TASK)).toBe(false);
    sweepHiddenPanes(NOW);

    expect(useWindowStore.getState().windows[id]).toBeDefined();
  });
});
