/**
 * Detaching the Browser pane into its own window, and docking it back.
 *
 * Three properties matter more than the rest here, and each one failed
 * silently rather than loudly when it was missing:
 *
 * 1. THE HANDLE THE CALLER GETS BACK IS THE NEW ONE. A pop-out mounts a fresh
 *    `<webview>`, so the guest the agent held is destroyed. Returning before
 *    the successor registers, or returning the predecessor, hands back a
 *    handle that answers `surface-gone` on the very next call.
 * 2. THE WINDOW DOES NOT TAKE FOCUS. An agent action never moves the user's
 *    keyboard (`.claude/rules/agent-driven-focus.md`), and a window appearing
 *    over what someone is typing into is the loudest version of that.
 * 3. IT IS CALLER-SCOPED BY CONSTRUCTION. Neither tool takes a task argument,
 *    and both refuse before touching a window when the connection is bound to
 *    no task.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const popOutOpen = vi.fn();
const popOutClose = vi.fn();
const popOutHas = vi.fn(() => false);
const popOutWindowFor = vi.fn(() => ({ isDestroyed: () => false }));
const waitForLivePane = vi.fn();
const registryList = vi.fn(() => [] as unknown[]);
const getByTaskId = vi.fn(() => [] as unknown[]);
const resolveLiveGuest = vi.fn(() => ({ ok: true }));
const withGuest = vi.fn();
const applyViewport = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: {},
  screen: {
    getDisplayMatching: () => ({ workAreaSize: { width: 2560, height: 1392 } }),
    getPrimaryDisplay: () => ({ workAreaSize: { width: 2560, height: 1392 } }),
  },
  webContents: { fromId: () => null },
}));

vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: {
    open: (...args: unknown[]) => popOutOpen(...(args as [])),
    close: (...args: unknown[]) => popOutClose(...(args as [])),
    has: (...args: unknown[]) => popOutHas(...(args as [])),
    windowFor: (...args: unknown[]) => popOutWindowFor(...(args as [])),
  },
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    list: (...args: unknown[]) => registryList(...(args as [])),
    getByTaskId: (...args: unknown[]) => getByTaskId(...(args as [])),
    resolveLiveGuest: (...args: unknown[]) => resolveLiveGuest(...(args as [])),
    waitForLivePane: (...args: unknown[]) => waitForLivePane(...(args as [])),
  },
}));

vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  capabilityGate: vi.fn(() => null),
  withGuest: (...args: unknown[]) => withGuest(...(args as [])),
}));

vi.mock('../../src/main/browser/viewport-override', () => ({
  applyViewport: (...args: unknown[]) => applyViewport(...(args as [])),
  displayForWindow: () => ({ width: 2560, height: 1392 }),
}));

import {
  popOutPaneForCallerTask,
  dockPaneForCallerTask,
} from '../../src/main/browser/browser-pane-detach';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';

const PROJECT = 'project-1';
const TASK = 'task-1';

function config(): ResolvedBrowserAutomationConfig {
  return { enabled: true, allowInteraction: true, allowNavigation: true, allowEval: true, restrictNavigationToLocalhost: false };
}

function base() {
  return { projectId: PROJECT, callerSessionId: 'agent-1', callerTaskId: TASK, capability: 'navigate' as const, config: config() };
}

/** The in-app pane the agent holds before it detaches. */
function seedDockedPane(webContentsId = 7) {
  getByTaskId.mockReturnValue([
    { sessionId: 'pane_old', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId },
  ]);
}

/** The pane that registers inside the new window. */
function seedSuccessor(handle = 'pane_new', webContentsId = 9) {
  waitForLivePane.mockResolvedValue({ sessionId: handle, kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId });
  registryList.mockReturnValue([{ sessionId: handle, taskId: TASK, projectId: PROJECT, url: null, kind: 'pane' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  popOutHas.mockReturnValue(false);
  resolveLiveGuest.mockReturnValue({ ok: true });
  popOutOpen.mockReturnValue({ maximize: vi.fn() });
  // withGuest runs the readiness probe body, as the real one does.
  withGuest.mockImplementation(async (_options: unknown, fn: (wc: unknown, e: unknown) => Promise<unknown>) => ({
    ok: true,
    data: await fn({ id: 9 }, { sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT }),
  }));
});

describe('pop_out', () => {
  it('opens the window WITHOUT focus', async () => {
    seedDockedPane();
    seedSuccessor();

    await popOutPaneForCallerTask(base());

    expect(popOutOpen).toHaveBeenCalledWith(
      'browser',
      { projectId: PROJECT, taskId: TASK },
      { focus: false },
    );
  });

  it('waits for the SUCCESSOR guest and returns its handle, not the dead one', async () => {
    seedDockedPane(7);
    seedSuccessor('pane_new', 9);

    const result = await popOutPaneForCallerTask(base());

    // The wait must exclude the guest that is on its way out: both are briefly
    // registered, so without this it resolves instantly against the dying one.
    expect(waitForLivePane).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, projectId: PROJECT, excludeWebContentsId: 7 }),
      expect.any(Number),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessionId).toBe('pane_new');
    expect(result.data.moved).toBe(true);
  });

  it('reports the display, so sizing against the screen takes no extra call', async () => {
    // Observed in an agent's own transcript: "The pop-out response doesn't
    // return display dimensions directly. I'll use a viewport call to measure
    // the display." It was right, and that call was pure overhead.
    seedDockedPane();
    seedSuccessor();

    const result = await popOutPaneForCallerTask(base());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.display).toEqual({ width: 2560, height: 1392 });
  });

  it('says in the response that the page reloaded and the old handle is dead', async () => {
    seedDockedPane();
    seedSuccessor();

    const result = await popOutPaneForCallerTask(base());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.note).toContain('sessionStorage');
    expect(result.data.note).toContain('RELOADED');
  });

  it('refuses when there is no pane to detach, instead of opening an empty window', async () => {
    getByTaskId.mockReturnValue([]);

    const result = await popOutPaneForCallerTask(base());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-pane-open');
    expect(popOutOpen).not.toHaveBeenCalled();
  });

  it('refuses a connection bound to no task before touching a window', async () => {
    const result = await popOutPaneForCallerTask({ ...base(), callerTaskId: undefined });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-caller-task');
    expect(popOutOpen).not.toHaveBeenCalled();
  });

  it('resizes an already-detached window rather than opening a second one', async () => {
    popOutHas.mockReturnValue(true);
    seedDockedPane();
    registryList.mockReturnValue([{ sessionId: 'pane_old', taskId: TASK, projectId: PROJECT, url: null, kind: 'pane' }]);
    applyViewport.mockResolvedValue({ viewport: { width: 1600, height: 900 } });

    const result = await popOutPaneForCallerTask({ ...base(), width: 1600, height: 900 });

    expect(popOutOpen).not.toHaveBeenCalled();
    expect(applyViewport).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.moved).toBe(false);
    expect(result.data.viewport).toEqual({ width: 1600, height: 900 });
  });

  it('maximized alone does NOT trigger a resize', async () => {
    // Reported live: a maximized pop-out spanned two monitors. `maximized`
    // fell through into the resize path, where an absent width/height
    // defaulted to the CURRENT (maximized) viewport, the resize then
    // un-maximized the window, set that viewport as its CONTENT size, and the
    // chrome correction grew it past the display. Maximize is its own intent.
    seedDockedPane();
    seedSuccessor();

    await popOutPaneForCallerTask({ ...base(), maximized: true });

    expect(applyViewport).not.toHaveBeenCalled();
  });

  it('applies a requested size through the SAME path set_viewport uses', async () => {
    // Not a second implementation of "what a requested viewport means": the
    // two would drift on the chrome correction alone.
    seedDockedPane();
    seedSuccessor();
    applyViewport.mockResolvedValue({ viewport: { width: 1920, height: 1040 } });

    const result = await popOutPaneForCallerTask({ ...base(), width: 1920, height: 1080 });

    expect(applyViewport).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.viewport).toEqual({ width: 1920, height: 1040 });
  });
});

describe('dock', () => {
  it('closes the window and waits for the pane that comes back', async () => {
    popOutHas.mockReturnValue(true);
    getByTaskId.mockReturnValue([
      { sessionId: 'pane_detached', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 },
    ]);
    seedSuccessor('pane_docked', 11);

    const result = await dockPaneForCallerTask(base());

    expect(popOutClose).toHaveBeenCalledWith('browser', { projectId: PROJECT, taskId: TASK });
    expect(waitForLivePane).toHaveBeenCalledWith(
      expect.objectContaining({ excludeWebContentsId: 9 }),
      expect.any(Number),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessionId).toBe('pane_docked');
  });

  it('refuses with not-detached when the pane is already in the task window', async () => {
    popOutHas.mockReturnValue(false);

    const result = await dockPaneForCallerTask(base());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-detached');
    expect(popOutClose).not.toHaveBeenCalled();
  });

  it('refuses a connection bound to no task', async () => {
    const result = await dockPaneForCallerTask({ ...base(), callerTaskId: undefined });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-caller-task');
    expect(popOutClose).not.toHaveBeenCalled();
  });

  it('reports a timeout rather than a handle when the pane does not come back', async () => {
    popOutHas.mockReturnValue(true);
    getByTaskId.mockReturnValue([
      { sessionId: 'pane_detached', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 },
    ]);
    waitForLivePane.mockResolvedValue(null);

    const result = await dockPaneForCallerTask(base());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('detach-timeout');
  });
});
