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
 * 4. A DETACH THAT FAILS CLOSES ITS WINDOW. Opening the window already took the
 *    agent's in-app pane away, so giving up with the window left open stranded
 *    an untracked OS window and no surface. Every failure after the open closes
 *    it and names the surface that came back.
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
const markDeliberateClose = vi.fn();
const withGuest = vi.fn();
const applyViewport = vi.fn();
const openPaneForCallerTask = vi.fn();

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
    markDeliberateClose: (...args: unknown[]) => markDeliberateClose(...(args as [])),
  },
}));

vi.mock('../../src/main/browser/browser-pane-opener', () => ({
  openPaneForCallerTask: (...args: unknown[]) => openPaneForCallerTask(...(args as [])),
  PANE_OPEN_TIMEOUT_MS: 10_000,
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

/** A registry row as `list()` reports it. */
function status(handle: string, overrides: Record<string, unknown> = {}) {
  return { sessionId: handle, taskId: TASK, projectId: PROJECT, url: 'http://localhost:5173/', kind: 'pane', visibility: 'showing', alive: true, ...overrides };
}

/** A withGuest that runs its body, as the real driver does once the guest resolves. */
async function runBody(_options: unknown, fn: (webContents: unknown, entry: unknown) => Promise<unknown>) {
  return { ok: true, data: await fn({ id: 9 }, { sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset, not only cleared: the failure cases queue once-values, and a queue a
  // test did not drain must not reach the next one.
  waitForLivePane.mockReset();
  getByTaskId.mockReset().mockReturnValue([]);
  registryList.mockReset().mockReturnValue([]);
  openPaneForCallerTask.mockReset();
  withGuest.mockReset();
  popOutHas.mockReturnValue(false);
  resolveLiveGuest.mockReturnValue({ ok: true });
  popOutOpen.mockReturnValue({ maximize: vi.fn() });
  // withGuest runs the readiness probe body, as the real one does.
  withGuest.mockImplementation(runBody);
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
      expect.objectContaining({ taskId: TASK, projectId: PROJECT, excludeWebContentsIds: [7] }),
      expect.any(Number),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessionId).toBe('pane_new');
    expect(result.data.moved).toBe(true);
    // A detach that succeeded keeps its window.
    expect(popOutClose).not.toHaveBeenCalled();
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
    expect(popOutClose).not.toHaveBeenCalled();
  });

  it('refuses a connection bound to no task before touching a window', async () => {
    const result = await popOutPaneForCallerTask({ ...base(), callerTaskId: undefined });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-caller-task');
    expect(popOutOpen).not.toHaveBeenCalled();
    expect(popOutClose).not.toHaveBeenCalled();
  });

  it('points an already-open window that holds no page at dock, without closing anything itself', async () => {
    // The state a failed detach used to leave. Refused before any new window
    // opens, so it is not this call's to clean up: it names the tool that is.
    popOutHas.mockReturnValue(true);
    getByTaskId.mockReturnValue([]);

    const result = await popOutPaneForCallerTask(base());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('pane-destroyed');
    expect(result.error.detail).toContain('kangentic_browser_dock');
    expect(popOutClose).not.toHaveBeenCalled();
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

describe('pop_out that cannot finish', () => {
  const WINDOW = { projectId: PROJECT, taskId: TASK };

  beforeEach(() => {
    // The window manager tracks the window from the moment it opens, as the
    // real one does, so the cleanup finds it open.
    popOutOpen.mockImplementation(() => {
      popOutHas.mockReturnValue(true);
      return { maximize: vi.fn() };
    });
  });

  /** The in-app pane that registers again once the window closes. */
  function seedReturningPane(handle = 'pane_back', webContentsId = 13, visibility = 'showing') {
    waitForLivePane.mockResolvedValueOnce({ sessionId: handle, kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId });
    registryList.mockReturnValue([status(handle, { visibility })]);
  }

  it('closes the window and names the returning pane when the window never mounts one', async () => {
    // The window's own pane never registered, the wait gave up after 20s, and
    // the window used to stay open with nothing tracking it.
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce(null);
    seedReturningPane('pane_back', 13);

    const result = await popOutPaneForCallerTask(base());

    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('detach-timeout');
    expect(result.error.detail).toContain('The detached window was closed');
    expect(result.error.detail).toContain('back in the task window as pane_back');
    expect(result.error.detail).toContain('use pane_back from now on');
    // It used to send the agent to a tool that cannot see the window.
    expect(result.error.detail).not.toContain('list_panes');
  });

  it('closes the window BEFORE waiting for the pane to come back', async () => {
    // Closing the window is what docks the pane, so a wait started first could
    // only ever time out.
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce(null);
    seedReturningPane();

    await popOutPaneForCallerTask(base());

    const recoveryWaitOrder = waitForLivePane.mock.invocationCallOrder[1];
    expect(popOutClose.mock.invocationCallOrder[0]).toBeLessThan(recoveryWaitOrder);
  });

  it("marks the window's own pane a deliberate close and waits past it, when one did register", async () => {
    // The window's guest is still alive for a moment after close(), so a wait
    // that did not skip it would hand back the handle that is about to die. The
    // mark keeps the hand-off from standing a lane up for it.
    getByTaskId
      .mockReturnValueOnce([{ sessionId: 'pane_old', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 7 }])
      .mockReturnValue([{ sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 }]);
    waitForLivePane.mockResolvedValueOnce({ sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 });
    seedReturningPane('pane_back', 13);
    withGuest
      .mockResolvedValueOnce({ ok: false, error: { kind: 'pane-not-rendering', detail: 'The window is minimized.' } })
      .mockImplementation(runBody);

    const result = await popOutPaneForCallerTask(base());

    expect(markDeliberateClose).toHaveBeenCalledWith(['pane_new']);
    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(waitForLivePane).toHaveBeenLastCalledWith(
      expect.objectContaining({ excludeWebContentsIds: [7, 9] }),
      expect.any(Number),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('pane-not-rendering');
    expect(result.error.detail).toContain('pane_back');
  });

  it('closes the window when the pane registered and then vanished', async () => {
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce({ sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 });
    // The registry no longer lists the window's pane when the probe reads it.
    registryList.mockReturnValueOnce([]);
    seedReturningPane();

    const result = await popOutPaneForCallerTask(base());

    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('pane-destroyed');
  });

  it('closes the window when sizing it fails, even though the pane came up', async () => {
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce({ sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 });
    registryList.mockReturnValueOnce([status('pane_new')]);
    seedReturningPane();
    withGuest
      .mockImplementationOnce(runBody)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'viewport-failed', detail: 'The window could not be resized.' } })
      .mockImplementation(runBody);

    const result = await popOutPaneForCallerTask({ ...base(), width: 1440, height: 900 });

    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('viewport-failed');
    expect(result.error.detail).toContain('The detached window was closed');
  });

  it('falls back to the opener when the in-app pane does not come back, and says where the surface is', async () => {
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    openPaneForCallerTask.mockResolvedValue({
      ok: true,
      data: { opened: true, navigated: true, url: 'http://localhost:5173/', pane: status('lane_1234abcd', { kind: 'lane', visibility: 'offscreen' }) },
    });

    const result = await popOutPaneForCallerTask(base());

    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(openPaneForCallerTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, callerTaskId: TASK, capability: 'navigate' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain('offscreen as lane_1234abcd');
  });

  it('says no surface came back, and how to get one, when nothing does', async () => {
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    openPaneForCallerTask.mockResolvedValue({ ok: false, error: { kind: 'pane-open-timeout', detail: 'did not come up' } });
    getByTaskId.mockReturnValueOnce([{ sessionId: 'pane_old', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 7 }]).mockReturnValue([]);

    const result = await popOutPaneForCallerTask(base());

    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain('no Browser surface came back');
    expect(result.error.detail).toContain('pane-open-timeout');
    expect(result.error.detail).toContain('kangentic_browser_open_pane');
  });

  describe('when neither the in-app pane nor the opener brings a surface back', () => {
    /** The task's registry rows at the end of the ladder: only a lane is left. */
    function seedLeftoverLane(handle: string) {
      getByTaskId
        .mockReturnValueOnce([{ sessionId: 'pane_old', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 7 }])
        .mockReturnValue([{ sessionId: handle, kind: 'lane', taskId: TASK, projectId: PROJECT, webContentsId: 21 }]);
      waitForLivePane.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      openPaneForCallerTask.mockResolvedValue({ ok: false, error: { kind: 'pane-open-timeout', detail: 'did not come up' } });
    }

    it('names the live surface the task still has and tells the agent to use it', async () => {
      // A hand-off lane stood up for a window the user closed is a real,
      // driveable surface. Reporting "no surface came back" would send the agent
      // to open a second one, which the lane manager refuses as surface-exists.
      seedLeftoverLane('lane_keep');
      registryList.mockReturnValue([status('lane_keep', { kind: 'lane', visibility: 'offscreen' })]);

      const result = await popOutPaneForCallerTask(base());

      expect(openPaneForCallerTask).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('detach-timeout');
      expect(result.error.detail).toContain("your task's Browser surface is offscreen as lane_keep, which the user cannot see");
      // Capital U: this is the leftover-surface wording, not the opener's "use ... from now on".
      expect(result.error.detail).toContain('Use lane_keep from now on');
      expect(result.error.detail).not.toContain('no Browser surface came back');
    });

    it('does not offer a surface whose guest is no longer alive', async () => {
      // A dead row still in the registry is not something to drive. It must fall
      // through to "open one", not hand the agent a handle that answers surface-gone.
      seedLeftoverLane('lane_dead');
      registryList.mockReturnValue([status('lane_dead', { kind: 'lane', visibility: 'offscreen', alive: false })]);

      const result = await popOutPaneForCallerTask(base());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.detail).toContain('no Browser surface came back');
      expect(result.error.detail).toContain('kangentic_browser_open_pane');
      expect(result.error.detail).not.toContain('lane_dead');
    });
  });

  it.each([
    { visibility: 'hidden', wording: 'back in the task window as pane_back, hidden behind the terminal' },
    { visibility: 'parked', wording: 'back in the task window as pane_back, in a window the user closed' },
    { visibility: 'offscreen', wording: 'offscreen as pane_back, which the user cannot see' },
    // No qualifier: the sentence ends at the handle.
    { visibility: 'showing', wording: 'back in the task window as pane_back. The page reloaded' },
  ])('tells the agent where a returning $visibility pane is', async ({ visibility, wording }) => {
    // The agent repeats this to the user, so a pane the user cannot see must not
    // be described the same as one they can.
    seedDockedPane(7);
    waitForLivePane.mockResolvedValueOnce(null);
    seedReturningPane('pane_back', 13, visibility);

    const result = await popOutPaneForCallerTask(base());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain(wording);
    expect(result.error.detail).toContain('use pane_back from now on');
  });

  it("marks the window's pane a deliberate close, before closing, when sizing fails after the pane registered", async () => {
    // Sizing is the one abandon path that runs after the readiness probe passed,
    // so the window's pane (guest 9) is registered and alive when it is closed.
    // It has to be marked, or the hand-off stands a lane up for a page that is
    // about to come back, and the recovery wait has to skip it as well as the
    // docked guest (7), or it resolves against the guest that is about to die.
    getByTaskId
      .mockReturnValueOnce([{ sessionId: 'pane_old', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 7 }])
      .mockReturnValue([{ sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 }]);
    waitForLivePane.mockResolvedValueOnce({ sessionId: 'pane_new', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 9 });
    registryList.mockReturnValueOnce([status('pane_new')]);
    seedReturningPane('pane_back', 13);
    withGuest
      .mockImplementationOnce(runBody)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'viewport-failed', detail: 'The window could not be resized.' } })
      .mockImplementation(runBody);

    const result = await popOutPaneForCallerTask({ ...base(), width: 1440, height: 900 });

    expect(markDeliberateClose).toHaveBeenCalledTimes(1);
    expect(markDeliberateClose).toHaveBeenCalledWith(['pane_new']);
    expect(popOutClose).toHaveBeenCalledWith('browser', WINDOW);
    expect(markDeliberateClose.mock.invocationCallOrder[0]).toBeLessThan(popOutClose.mock.invocationCallOrder[0]);
    // The window wait skipped only the docked guest; the recovery wait skips both.
    expect(waitForLivePane.mock.calls[0][0]).toMatchObject({ excludeWebContentsIds: [7] });
    expect(waitForLivePane).toHaveBeenLastCalledWith(
      expect.objectContaining({ excludeWebContentsIds: [7, 9] }),
      expect.any(Number),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('viewport-failed');
    expect(result.error.detail).toContain('use pane_back from now on');
  });

  it('closes nothing and skips only the docked guest when the user already closed the window', async () => {
    // The user closed the window during the wait. That close was the dock, so
    // the in-app pane (guest 13) is already back. It is not the window's pane:
    // marking it would hide it from the hand-off, and skipping it would make the
    // recovery wait ignore the very pane it is waiting for.
    getByTaskId
      .mockReturnValueOnce([{ sessionId: 'pane_old', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 7 }])
      .mockReturnValue([{ sessionId: 'pane_back', kind: 'pane', taskId: TASK, projectId: PROJECT, webContentsId: 13 }]);
    waitForLivePane.mockImplementationOnce(async () => {
      popOutHas.mockReturnValue(false);
      return null;
    });
    seedReturningPane('pane_back', 13);

    const result = await popOutPaneForCallerTask(base());

    expect(markDeliberateClose).not.toHaveBeenCalled();
    expect(popOutClose).not.toHaveBeenCalled();
    expect(waitForLivePane).toHaveBeenLastCalledWith(
      expect.objectContaining({ excludeWebContentsIds: [7] }),
      expect.any(Number),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('detach-timeout');
    expect(result.error.detail).toContain('back in the task window as pane_back');
    expect(result.error.detail).toContain('use pane_back from now on');
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
      expect.objectContaining({ excludeWebContentsIds: [9] }),
      expect.any(Number),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessionId).toBe('pane_docked');
  });

  it('closes a detached window that holds no page and returns the pane that comes back', async () => {
    // The state `pop_out` now points an agent at dock for: a window open with no
    // pane registered in it. There is no predecessor guest to skip, so the wait
    // takes the first live pane of the task, which is the returning in-app one.
    popOutHas.mockReturnValue(true);
    getByTaskId.mockReturnValue([]);
    seedSuccessor('pane_docked', 11);

    const result = await dockPaneForCallerTask(base());

    expect(popOutClose).toHaveBeenCalledWith('browser', { projectId: PROJECT, taskId: TASK });
    expect(waitForLivePane).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, projectId: PROJECT, excludeWebContentsIds: [] }),
      expect.any(Number),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessionId).toBe('pane_docked');
    expect(result.data.moved).toBe(true);
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
