/**
 * Unit tests for the Browser pane opener in
 * src/main/browser/browser-pane-opener.ts - the orchestration behind
 * `kangentic_browser_open_pane` and `kangentic_browser_close_pane`.
 *
 * What matters here:
 * - Every refusal is decided in MAIN, before anything is pushed. That is what
 *   lets the push stay fire-and-forget instead of needing an acknowledgement
 *   channel, so a precondition that stops checking would silently degrade every
 *   error into a 10s timeout.
 * - Open seeds the URL BEFORE pushing (a pane with no URL registers no guest),
 *   and never re-seeds a live pane (its <webview> src is locked at mount).
 * - Close reports what it ACTUALLY closed, and its scope, so "close all
 *   browsers" cannot be reported as complete when it was partial.
 *
 * The registry, the driver, and the URL sidecar are mocked, so this is pure Node
 * with no Electron, no filesystem, and no database.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    list: vi.fn(() => []),
    listForProject: vi.fn(() => ({ panes: [], otherProjectPaneCount: 0, unknownProjectPaneCount: 0 })),
    getByTaskId: vi.fn(() => []),
    resolveTarget: vi.fn(),
    resolveLiveGuest: vi.fn(() => ({ ok: true })),
    waitForLivePane: vi.fn(async () => null),
    waitForPanesGone: vi.fn(async () => []),
  },
}));
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(async () => ({ ok: true, data: null })),
  capabilityGate: vi.fn(() => null),
  validateNavigationUrl: vi.fn((url: string) => ({ ok: true, url })),
  // The opener loads through the driver's BOUNDED navigate helper rather than
  // a bare loadURL, so that an unbounded load cannot hold the guest's drive
  // lock against every other caller.
  navigateGuest: vi.fn(async (webContents: { loadURL: (url: string) => Promise<void> }, url: string) => {
    await webContents.loadURL(url);
  }),
}));
vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: { get: vi.fn(() => null), set: vi.fn() },
}));

// The lane manager owns real Electron windows and has its own suite
// (browser-lane-manager.test.ts). Here it is a seam, so these tests can assert
// the opener's ROUTING - which branch runs, and what it does or does not touch.
vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  openLane: vi.fn(async () => ({ ok: true, laneId: 'lane_abc12345', webContents: {} })),
  destroyLane: vi.fn(() => true),
}));

import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import { withGuest, capabilityGate, validateNavigationUrl } from '../../src/main/browser/browser-pane-driver';
import { browserUrlStore } from '../../src/main/browser/browser-url-store';
import {
  openPaneForCallerTask,
  closePanes,
  setBrowserPaneOpenerHost,
  type BrowserPaneOpenerHost,
} from '../../src/main/browser/browser-pane-opener';
import { IPC } from '../../src/shared/ipc-channels';

const PROJECT = 'proj-1';
const CALLER_TASK = 'task-1';
const CALLER_SESSION = 'sess-a';

const CONFIG = {
  enabled: true,
  allowInteraction: true,
  allowNavigation: true,
  allowEval: false,
  restrictNavigationToLocalhost: false,
};

function pane(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: CALLER_SESSION,
    taskId: CALLER_TASK,
    projectId: PROJECT,
    webContentsId: 11,
    url: 'http://localhost:5173',
    registeredAt: 0,
    alive: true,
    debuggerAttached: false,
    ...overrides,
  };
}

let sent: { channel: string; args: unknown[] }[] = [];
/** Stands in for the guest webContents withGuest hands the body. */
let loadedUrls: string[] = [];
const fakeGuest = { loadURL: async (url: string) => { loadedUrls.push(url); } };

/** Run the withGuest body against the fake guest, as the real driver would. */
function runWithGuestBody(): void {
  vi.mocked(withGuest).mockImplementation(async (_options, fn) => ({
    ok: true,
    data: await fn(fakeGuest as never),
  }));
}

/** A host with every precondition satisfied; individual tests break one. */
function installHost(overrides: Partial<BrowserPaneOpenerHost> = {}): void {
  setBrowserPaneOpenerHost(() => ({
    currentProjectId: PROJECT,
    currentProjectPath: '/projects/app',
    taskExists: () => true,
    browserOverrides: () => ({ defaultUrl: 'http://localhost:3000' }),
    send: (channel, ...args) => {
      sent.push({ channel, args });
      return true;
    },
    ...overrides,
  }));
}

const openInput = (url?: string) => ({
  projectId: PROJECT,
  callerSessionId: CALLER_SESSION,
  callerTaskId: CALLER_TASK,
  url,
  capability: 'navigate' as const,
  config: CONFIG,
});

describe('openPaneForCallerTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent = [];
    loadedUrls = [];
    installHost();
    vi.mocked(browserPaneRegistry.list).mockReturnValue([]);
    vi.mocked(browserPaneRegistry.getByTaskId).mockReturnValue([]);
    vi.mocked(browserPaneRegistry.resolveLiveGuest).mockReturnValue({ ok: true } as never);
    vi.mocked(validateNavigationUrl).mockImplementation((url: string) => ({ ok: true, url }) as never);
    vi.mocked(capabilityGate).mockReturnValue(null);
    vi.mocked(browserUrlStore.get).mockReturnValue(null);
  });

  describe('refusals decided in main, before any push', () => {
    it('refuses with no-caller-task when the connection is not bound to a task', async () => {
      const result = await openPaneForCallerTask({ ...openInput('http://localhost:5173'), callerTaskId: undefined });
      expect(result).toMatchObject({ ok: false, error: { kind: 'no-caller-task' } });
      expect(sent).toEqual([]);
    });

    it('refuses with project-not-open when the caller project is backgrounded', async () => {
      // The board window layer renders the OPEN project's tasks, so no window
      // could be mounted for this task even if the push landed.
      installHost({ currentProjectId: 'other-project' });
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'project-not-open' } });
      expect(sent).toEqual([]);
    });

    it('refuses with browser-pane-disabled when the project turned the pane off', async () => {
      // Not policy purity: TaskDetailBody renders the pane on its open flag
      // alone, so a pane opened here would show with no Browser pill - and the
      // pill is the user's only way to close it.
      installHost({ browserOverrides: () => ({ enabled: false }) });
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'browser-pane-disabled' } });
      expect(sent).toEqual([]);
    });

    it('refuses with task-not-found when the task is not on the board', async () => {
      installHost({ taskExists: () => false });
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'task-not-found' } });
      expect(sent).toEqual([]);
    });

    it('refuses with no-url when no url is passed and no fallback exists', async () => {
      // A pane with no URL renders the empty state and registers no guest, so
      // opening one would strand the agent in a state no tool can act on.
      installHost({ browserOverrides: () => null });
      const result = await openPaneForCallerTask(openInput(undefined));
      expect(result).toMatchObject({ ok: false, error: { kind: 'no-url' } });
      expect(result.ok === false && result.error.detail).toContain('url');
      expect(sent).toEqual([]);
      expect(browserUrlStore.set).not.toHaveBeenCalled();
    });

    it('refuses a gated-off capability BEFORE opening anything', async () => {
      // The gate has to run ahead of the side effects, not inside the closing
      // withGuest call: this tool seeds a URL and opens a window before any
      // guest exists, so gating at the end would let "Allow navigation: off"
      // still put a pane on the user's screen and only then refuse.
      vi.mocked(capabilityGate).mockReturnValue({
        kind: 'navigation-disabled',
        detail: 'Navigation is turned off.',
      } as never);
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'navigation-disabled' } });
      expect(browserUrlStore.set).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(withGuest).not.toHaveBeenCalled();
    });

    it('gates the already-open no-op path too, which never reaches withGuest', async () => {
      vi.mocked(browserPaneRegistry.getByTaskId).mockReturnValue([
        { sessionId: CALLER_SESSION, taskId: CALLER_TASK, projectId: PROJECT, webContentsId: 11, url: null, registeredAt: 0 },
      ] as never);
      vi.mocked(browserPaneRegistry.list).mockReturnValue([pane()] as never);
      vi.mocked(capabilityGate).mockReturnValue({
        kind: 'navigation-disabled',
        detail: 'Navigation is turned off.',
      } as never);
      const result = await openPaneForCallerTask(openInput(undefined));
      expect(result).toMatchObject({ ok: false, error: { kind: 'navigation-disabled' } });
    });

    it('surfaces a navigation-policy refusal verbatim', async () => {
      vi.mocked(validateNavigationUrl).mockReturnValue({
        ok: false,
        error: { kind: 'navigation-host-blocked', detail: 'blocked' },
      } as never);
      const result = await openPaneForCallerTask(openInput('http://example.com'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'navigation-host-blocked' } });
      expect(sent).toEqual([]);
    });

    it('refuses with app-not-ready when the app has no host installed yet', async () => {
      // Reachable during startup: the MCP server can field a call before
      // registerBrowserHandlers has wired setBrowserPaneOpenerHost.
      setBrowserPaneOpenerHost(() => null);
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'app-not-ready' } });
      expect(sent).toEqual([]);
    });
  });

  describe('URL resolution', () => {
    it("prefers the explicit url over the task's saved override", async () => {
      vi.mocked(browserUrlStore.get).mockReturnValue('http://localhost:9999');
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue(null as never);
      await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(browserUrlStore.set).toHaveBeenCalledWith('/projects/app', CALLER_TASK, 'http://localhost:5173');
    });

    it('falls back to the task override, then the project default', async () => {
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue(null as never);
      vi.mocked(browserUrlStore.get).mockReturnValue('http://localhost:9999');
      await openPaneForCallerTask(openInput(undefined));
      expect(browserUrlStore.set).toHaveBeenLastCalledWith('/projects/app', CALLER_TASK, 'http://localhost:9999');

      vi.mocked(browserUrlStore.get).mockReturnValue(null);
      await openPaneForCallerTask(openInput(undefined));
      expect(browserUrlStore.set).toHaveBeenLastCalledWith('/projects/app', CALLER_TASK, 'http://localhost:3000');
    });

    it('seeds the URL BEFORE pushing, so the pane mounts active', async () => {
      // Ordering is load-bearing: the pane resolves its URL on mount, so a seed
      // that landed after the push would race the mount and leave the pane on
      // its empty state, registering nothing.
      const order: string[] = [];
      vi.mocked(browserUrlStore.set).mockImplementation(() => { order.push('seed'); });
      installHost({
        send: (channel, ...args) => { order.push('push'); sent.push({ channel, args }); return true; },
      });
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue(null as never);
      await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(order).toEqual(['seed', 'push']);
      expect(sent[0]).toMatchObject({ channel: IPC.BROWSER_PANE_OPEN_REQUEST, args: [PROJECT, CALLER_TASK] });
    });

    it('refuses with url-seed-failed when the sidecar write throws, and never pushes', async () => {
      // mockImplementationOnce so the throw does not leak into later tests -
      // clearAllMocks() in beforeEach resets calls, not implementations.
      vi.mocked(browserUrlStore.set).mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'url-seed-failed' } });
      expect(result.ok === false && result.error.detail).toContain('disk full');
      expect(sent).toEqual([]);
    });
  });

  describe('cold open', () => {
    it('returns the pane once it registers, and only after withGuest proves it driveable', async () => {
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue({ sessionId: CALLER_SESSION } as never);
      vi.mocked(browserPaneRegistry.list).mockReturnValue([pane()] as never);
      runWithGuestBody();

      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: true, data: { opened: true, navigated: true } });
      expect(result.ok === true && result.data.pane.sessionId).toBe(CALLER_SESSION);
      expect(withGuest).toHaveBeenCalled();
    });

    it('scopes its withGuest selector to the caller project', async () => {
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue({ sessionId: CALLER_SESSION } as never);
      vi.mocked(browserPaneRegistry.list).mockReturnValue([pane()] as never);
      runWithGuestBody();

      await openPaneForCallerTask(openInput('http://localhost:5173'));
      const selector = vi.mocked(withGuest).mock.calls[0][0].selector;
      expect(selector.projectId).toBe(PROJECT);
      expect(vi.mocked(withGuest).mock.calls[0][0].capability).toBe('navigate');
    });

    it('fails with a bounded pane-open-timeout when nothing registers', async () => {
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue(null as never);
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'pane-open-timeout' } });
    });

    it('leaves the pane open when the window is minimized, so restoring it is the whole fix', async () => {
      vi.mocked(browserPaneRegistry.waitForLivePane).mockResolvedValue({ sessionId: CALLER_SESSION } as never);
      vi.mocked(withGuest).mockResolvedValue({
        ok: false,
        error: { kind: 'pane-not-rendering', detail: 'minimized' },
      } as never);
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'pane-not-rendering' } });
      // No rollback push: the pane stays open on purpose.
      expect(sent.filter((entry) => entry.channel === IPC.BROWSER_PANE_CLOSE_REQUEST)).toEqual([]);
    });

    it('refuses with app-not-ready when the Kangentic window is unavailable to push to', async () => {
      // Distinct from the "no host installed" refusal above: the host exists
      // (every earlier precondition passes, and the URL is already seeded),
      // but send() itself reports no live window - the same signal a closed
      // or destroyed BrowserWindow would produce.
      installHost({ send: () => false });
      const result = await openPaneForCallerTask(openInput('http://localhost:5173'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'app-not-ready' } });
      // The seed still happened - only the push failed.
      expect(browserUrlStore.set).toHaveBeenCalledWith('/projects/app', CALLER_TASK, 'http://localhost:5173');
    });
  });

  describe('already-open pane (idempotence)', () => {
    beforeEach(() => {
      vi.mocked(browserPaneRegistry.getByTaskId).mockReturnValue([
        { sessionId: CALLER_SESSION, taskId: CALLER_TASK, projectId: PROJECT, webContentsId: 11, url: null, registeredAt: 0 },
      ] as never);
      vi.mocked(browserPaneRegistry.list).mockReturnValue([pane()] as never);
    });

    it('opens an isolated LANE for a backgrounded project, with no pane and no window', async () => {
      // The reported real-world dead end (#542), reproduced live: close a task's
      // detail window and its <webview> guest is destroyed - correctly, the node
      // unmounted; the registry log names it `reason=guest-destroyed`. Switch
      // projects too and the agent still running in the backgrounded project has
      // no pane AND no way to get one: every drive returns `no-pane-open`, whose
      // hint says to call open_pane, which refused with `project-not-open`.
      //
      // A lane is the way out precisely because it needs no task-detail window,
      // so it must sit AHEAD of that guard rather than behind it.
      installHost({ currentProjectId: 'other-project', currentProjectPath: null });
      vi.mocked(browserPaneRegistry.getByTaskId).mockReturnValue([]);
      // openLane registers the lane for real; the mock stands in for that.
      vi.mocked(browserPaneRegistry.list).mockReturnValue([
        pane({ sessionId: 'lane_abc12345', kind: 'lane', url: 'http://localhost:4200' }),
      ] as never);

      const result = await openPaneForCallerTask({
        ...openInput('http://localhost:4200'),
        isolated: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected the lane to open');
      expect(result.data.laneId).toBe('lane_abc12345');
      // No renderer involvement at all: no window push, no URL sidecar write.
      expect(sent).toEqual([]);
      expect(browserUrlStore.set).not.toHaveBeenCalled();
    });

    it('tells a backgrounded caller to pass a url rather than failing vaguely', async () => {
      // The saved URL and project default live behind the project path, which is
      // exactly what is unavailable here - so say that, and say the lane itself
      // still works, instead of refusing with project-not-open.
      installHost({ currentProjectId: 'other-project', currentProjectPath: null });
      vi.mocked(browserPaneRegistry.getByTaskId).mockReturnValue([]);

      const result = await openPaneForCallerTask({ ...openInput(undefined), isolated: true });

      expect(result).toMatchObject({ ok: false, error: { kind: 'no-url' } });
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error.detail).toContain('the lane itself will open fine');
    });

    it('never hands the shared pane to a caller that asked for isolation', async () => {
      // Silently returning the shared pane would give the caller the exact
      // opposite of what it asked for, and it would not find out. The enclosing
      // describe leaves a LIVE shared pane registered, which is what makes this
      // meaningful: the isolated branch has to win against a resolvable pane.
      vi.mocked(browserPaneRegistry.list).mockReturnValue([
        pane(),
        pane({ sessionId: 'lane_abc12345', kind: 'lane', url: 'http://localhost:4200' }),
      ] as never);

      const result = await openPaneForCallerTask({
        ...openInput('http://localhost:4200'),
        isolated: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected a lane');
      expect(result.data.laneId).toBeTruthy();
      expect(result.data.pane.sessionId).not.toBe(CALLER_SESSION);
    });

    it('navigates a RETAINED live pane whose project is backgrounded', async () => {
      // Task #542 Finding B. Retention deliberately keeps a backgrounded
      // project's pane alive so its agent can keep driving it, but the
      // project-not-open guard used to run BEFORE the live-pane lookup, so the
      // one pane retention exists to preserve was the one open_pane refused.
      //
      // Worse, the two composed: `no-pane-open` tells the agent to call
      // open_pane, which returned project-not-open, so an agent with a live,
      // driveable pane had no way back to it and worked blind.
      installHost({ currentProjectId: 'other-project', currentProjectPath: null });
      runWithGuestBody();

      const result = await openPaneForCallerTask(openInput('http://localhost:7777'));

      expect(result).toMatchObject({ ok: true, data: { opened: false, navigated: true } });
      expect(loadedUrls).toEqual(['http://localhost:7777']);
      // Nothing project-scoped may run on this path: `taskExists` resolves a
      // project DB by id, and getProjectDb CREATES the file for an unrecognized
      // id, so reaching it with a backgrounded project would leave a stray db.
      expect(sent).toEqual([]);
      expect(browserUrlStore.set).not.toHaveBeenCalled();
    });

    it('reports a retained pane"s status while its project is backgrounded', async () => {
      installHost({ currentProjectId: 'other-project', currentProjectPath: null });
      vi.mocked(browserPaneRegistry.list).mockReturnValue([pane({ url: 'http://localhost:4200' })] as never);

      const result = await openPaneForCallerTask(openInput(undefined));

      expect(result).toMatchObject({
        ok: true,
        data: { opened: false, navigated: false, url: 'http://localhost:4200' },
      });
    });

    it('navigates a live pane instead of re-seeding its locked src', async () => {
      // BrowserPane locks its <webview> src at first mount, so a seeded URL
      // would be silently ignored and the agent told it navigated when it did not.
      runWithGuestBody();
      const result = await openPaneForCallerTask(openInput('http://localhost:7777'));
      expect(result).toMatchObject({ ok: true, data: { opened: false, navigated: true } });
      expect(loadedUrls).toEqual(['http://localhost:7777']);
      expect(browserUrlStore.set).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it('returns the existing pane untouched when no url is passed', async () => {
      const result = await openPaneForCallerTask(openInput(undefined));
      expect(result).toMatchObject({ ok: true, data: { opened: false, navigated: false } });
      expect(withGuest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it('does not apply the navigation POLICY to a call that navigates nothing', async () => {
      // The policy gates navigations. Running it on a no-op would refuse a pure
      // status call because the user tightened restrict-to-localhost AFTER the
      // page loaded - which cannot unload the page, so refusing helps nobody.
      vi.mocked(validateNavigationUrl).mockReturnValue({
        ok: false,
        error: { kind: 'navigation-host-blocked', detail: 'blocked' },
      } as never);
      const result = await openPaneForCallerTask(openInput(undefined));
      expect(result).toMatchObject({ ok: true, data: { opened: false, navigated: false } });
    });

    it('still applies the navigation policy when a url IS passed', async () => {
      vi.mocked(validateNavigationUrl).mockReturnValue({
        ok: false,
        error: { kind: 'navigation-host-blocked', detail: 'blocked' },
      } as never);
      const result = await openPaneForCallerTask(openInput('http://example.com'));
      expect(result).toMatchObject({ ok: false, error: { kind: 'navigation-host-blocked' } });
      expect(loadedUrls).toEqual([]);
    });

    it('reports pane-destroyed when the pane vanishes between the live check and the status read', async () => {
      vi.mocked(browserPaneRegistry.list).mockReturnValue([] as never);
      const result = await openPaneForCallerTask(openInput(undefined));
      expect(result).toMatchObject({ ok: false, error: { kind: 'pane-destroyed' } });
    });
  });
});

describe('closePanes', () => {
  const closeInput = (overrides: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    callerSessionId: CALLER_SESSION,
    callerTaskId: CALLER_TASK,
    config: CONFIG,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sent = [];
    installHost();
    vi.mocked(browserPaneRegistry.waitForPanesGone).mockResolvedValue([] as never);
    vi.mocked(browserPaneRegistry.listForProject).mockReturnValue({
      panes: [pane()],
      otherProjectPaneCount: 2,
      unknownProjectPaneCount: 0,
    } as never);
    vi.mocked(browserPaneRegistry.list).mockReturnValue([pane()] as never);
  });

  it('refuses when browser automation is turned off', async () => {
    // It never reaches withGuest's capability gate, so it must check the master
    // switch itself.
    const result = await closePanes(closeInput({ config: { ...CONFIG, enabled: false } }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'automation-disabled' } });
    expect(sent).toEqual([]);
  });

  it("resolves a bare call through resolveTarget WITH caller identity, so it finds the agent's own pane", async () => {
    // The most common call this tool will ever receive. Without caller identity
    // in the selector, resolveTarget falls through to the single-pane branch and
    // refuses `multiple-panes` whenever a sibling task also has a pane open.
    vi.mocked(browserPaneRegistry.resolveTarget).mockReturnValue({
      ok: true,
      entry: { sessionId: CALLER_SESSION },
    } as never);
    await closePanes(closeInput());
    expect(browserPaneRegistry.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        callerSessionId: CALLER_SESSION,
        callerTaskId: CALLER_TASK,
      }),
    );
  });

  it('actually closes the pane a bare call resolved, rather than reporting an empty success', async () => {
    // The call-args assertion above proves the selector; this proves the
    // RESULT. Without it, `targets = pane ? [pane] : []` could always yield []
    // and the tool would answer ok with nothing closed and no error.
    vi.mocked(browserPaneRegistry.resolveTarget).mockReturnValue({
      ok: true,
      entry: { sessionId: CALLER_SESSION },
    } as never);
    const result = await closePanes(closeInput());
    expect(result.ok === true && result.data.closed.map((entry) => entry.sessionId)).toEqual([CALLER_SESSION]);
    expect(sent[0]).toMatchObject({ channel: IPC.BROWSER_PANE_CLOSE_REQUEST, args: [PROJECT, [CALLER_TASK]] });
  });

  it('does NOT let includeOtherProjects widen a bare call into another project', async () => {
    // includeOtherProjects widens `all` and an explicitly named target. Widening
    // the IMPLICIT default too would let resolveTarget's single-pane fallback
    // close a pane in a project the caller never named, purely because the
    // caller's own project happened to have none open.
    vi.mocked(browserPaneRegistry.resolveTarget).mockReturnValue({
      ok: false,
      kind: 'no-pane-open',
      detail: 'none here',
    } as never);
    await closePanes(closeInput({ includeOtherProjects: true }));
    expect(browserPaneRegistry.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT }),
    );
  });

  it('still permits an EXPLICITLY named foreign target under includeOtherProjects', async () => {
    vi.mocked(browserPaneRegistry.resolveTarget).mockReturnValue({
      ok: true,
      entry: { sessionId: CALLER_SESSION },
    } as never);
    await closePanes(closeInput({ taskId: 'task-elsewhere', includeOtherProjects: true }));
    expect(browserPaneRegistry.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: null }),
    );
  });

  it('keeps reporting untouched other-project panes when it did not sweep them', async () => {
    // Only a real all+includeOtherProjects sweep leaves nothing behind. A
    // single-target close that merely crossed projects must not report 0 and
    // read as comprehensive.
    vi.mocked(browserPaneRegistry.resolveTarget).mockReturnValue({
      ok: true,
      entry: { sessionId: CALLER_SESSION },
    } as never);
    const result = await closePanes(closeInput({ taskId: 'task-elsewhere', includeOtherProjects: true }));
    expect(result).toMatchObject({ ok: true, data: { otherProjectPaneCount: 2 } });
  });

  it('surfaces a foreign-project refusal for an explicit out-of-project target', async () => {
    vi.mocked(browserPaneRegistry.resolveTarget).mockReturnValue({
      ok: false,
      kind: 'foreign-project',
      detail: 'nope',
    } as never);
    const result = await closePanes(closeInput({ sessionId: 'someone-elses' }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'foreign-project' } });
    expect(sent).toEqual([]);
  });

  it('closes only the caller project by default, and says what it left alone', async () => {
    const result = await closePanes(closeInput({ all: true }));
    expect(result).toMatchObject({
      ok: true,
      data: { scope: 'this-project', otherProjectPaneCount: 2 },
    });
    expect(browserPaneRegistry.list).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ channel: IPC.BROWSER_PANE_CLOSE_REQUEST, args: [PROJECT, [CALLER_TASK]] });
  });

  it('reaches every project only on the explicit opt-in', async () => {
    const foreign = pane({ sessionId: 'sess-c', taskId: 'task-3', projectId: 'proj-2' });
    vi.mocked(browserPaneRegistry.list).mockReturnValue([pane(), foreign] as never);
    const result = await closePanes(closeInput({ all: true, includeOtherProjects: true }));
    expect(result).toMatchObject({ ok: true, data: { scope: 'all-projects', otherProjectPaneCount: 0 } });
    expect(result.ok === true && result.data.closed.map((entry) => entry.sessionId)).toEqual([
      CALLER_SESSION,
      'sess-c',
    ]);
  });

  it('reports a pane that did not close as skipped rather than claiming success', async () => {
    // A popped-out pane is the expected straggler: it is mutually exclusive with
    // the in-app mount, so clearing the open flag does not unmount it.
    const other = pane({ sessionId: 'sess-b', taskId: 'task-2' });
    vi.mocked(browserPaneRegistry.listForProject).mockReturnValue({
      panes: [pane(), other],
      otherProjectPaneCount: 0,
      unknownProjectPaneCount: 0,
    } as never);
    vi.mocked(browserPaneRegistry.waitForPanesGone).mockResolvedValue(['sess-b'] as never);

    const result = await closePanes(closeInput({ all: true }));
    expect(result.ok === true && result.data.closed.map((entry) => entry.sessionId)).toEqual([CALLER_SESSION]);
    expect(result.ok === true && result.data.skipped.map((entry) => entry.sessionId)).toEqual(['sess-b']);
  });

  it('succeeds with an empty result when there is nothing open', async () => {
    vi.mocked(browserPaneRegistry.listForProject).mockReturnValue({
      panes: [],
      otherProjectPaneCount: 0,
      unknownProjectPaneCount: 0,
    } as never);
    const result = await closePanes(closeInput({ all: true }));
    expect(result).toMatchObject({ ok: true, data: { closed: [], skipped: [] } });
    expect(sent).toEqual([]);
  });

  it('refuses with app-not-ready when the app has no host installed yet, once there is something to close', async () => {
    // The empty-result path above returns ok before ever reading the host, so
    // it cannot exercise this refusal - it needs a non-empty target list first.
    setBrowserPaneOpenerHost(() => null);
    const result = await closePanes(closeInput({ all: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'app-not-ready' } });
  });

  it('refuses with app-not-ready when the close push has no live window to send to', async () => {
    installHost({ send: () => false });
    const result = await closePanes(closeInput({ all: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'app-not-ready' } });
  });
});
