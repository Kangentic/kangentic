/**
 * Unit tests for the browser-pane driver in
 * src/main/browser/browser-pane-driver.ts.
 *
 * Covers the single chokepoint withGuest (capability gating, target
 * resolution, lazy CDP attach, error envelopes) and validateNavigationUrl
 * (http(s)-only + the optional localhost restriction). electron and the CDP
 * helpers are mocked; the real registry singleton is exercised so resolution
 * is end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  attachDebugger: vi.fn(() => true),
  isDebuggerAttached: vi.fn(() => false),
  detachDebugger: vi.fn(),
  ensureFocusEmulation: vi.fn(),
  waitForDialogInterception: vi.fn(async () => {}),
  ensureVirtualAuthenticator: vi.fn(async () => true),
}));
vi.mock('../../src/main/browser/passkey-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/browser/passkey-guard')>()),
  markAgentControl: vi.fn(),
}));

// The passkey guard's reporter is module-private, so its reports are observed by wrapping the
// factory. Every other reporter (the driver's own) is the real one.
const passkeyReportTags: unknown[] = [];
vi.mock('../../src/main/analytics/handled-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/analytics/handled-report')>();
  return {
    ...actual,
    createChokepointReporter: (...factoryArguments: Parameters<typeof actual.createChokepointReporter>) => {
      const reporter = actual.createChokepointReporter(...factoryArguments);
      if (factoryArguments[0] !== 'browser_passkey_guard') return reporter;
      return {
        ...reporter,
        report: (_error: unknown, options?: { tags?: unknown }) => {
          passkeyReportTags.push(options?.tags);
          return true;
        },
      };
    },
  };
});

import { webContents, BrowserWindow } from 'electron';
import {
  attachDebugger,
  ensureFocusEmulation,
  ensureVirtualAuthenticator,
  isDebuggerAttached,
  waitForDialogInterception,
} from '../../src/main/browser/cdp/cdp';
import { markAgentControl } from '../../src/main/browser/passkey-guard';
import { withGuest, validateNavigationUrl, reviveCrashedGuest, NAVIGATE_TIMEOUT_MS } from '../../src/main/browser/browser-pane-driver';
import { trackGuestCrash } from '../../src/main/browser/guest-crash-state';
import { EventEmitter } from 'node:events';
import { KeyboardFocusNotInGuestError } from '../../src/main/browser/cdp/keyboard-focus';
import { AmbiguousSelectorError } from '../../src/main/browser/cdp/ambiguous-selector';
import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import { resetGuestDriveQueuesForTests } from '../../src/main/browser/guest-drive-queue';
import {
  setAgentInputSender,
  resetAgentInputSignalForTests,
  AGENT_INPUT_BURST_QUIET_MS,
} from '../../src/main/browser/agent-input-signal';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';

function config(overrides: Partial<ResolvedBrowserAutomationConfig> = {}): ResolvedBrowserAutomationConfig {
  return {
    enabled: true,
    allowInteraction: true,
    allowNavigation: true,
    allowEval: false,
    restrictNavigationToLocalhost: false,
    ...overrides,
  };
}

function seedGuest(id: number, destroyed = false): void {
  vi.mocked(webContents.fromId).mockImplementation((requestedId: number) =>
    requestedId === id ? ({ id, isDestroyed: () => destroyed } as never) : (undefined as never),
  );
}

/**
 * The agent-input signal: `withGuest` announces every drive so the pane's
 * renderer can put the user's keyboard focus back if Chromium moved it into the
 * guest. See `.claude/rules/agent-driven-focus.md`.
 *
 * The signal is a real module (not mocked) with an injectable sender, so these
 * assert the ACTUAL begin/end edges rather than that a mock was called.
 */
describe('withGuest - agent input signalling', () => {
  let signalled: { guestId: number; active: boolean }[] = [];

  /**
   * The end edge is DEBOUNCED by a quiet window, so a run of back-to-back tool
   * calls reads as one burst to the renderer rather than ~1500 begin/end pairs
   * that make focus oscillate. These tests therefore have to let the quiet
   * window elapse before asserting the end. See `agent-input-burst.test.ts` for
   * the burst behavior itself.
   */
  const settleBurst = () => vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS + 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    // These suites share one guest id against the real registry singleton, so
    // the per-guest drive queues must be dropped between tests or a test that
    // leaves a drive in flight stalls every later one.
    resetGuestDriveQueuesForTests();
    browserPaneRegistry.detachAll();
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    resetAgentInputSignalForTests();
    signalled = [];
    setAgentInputSender((guest, active) => signalled.push({ guestId: guest.id, active }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The driver NEVER takes the guest's keyboard focus.
   *
   * An implementation that did (to make selector-less `type` / `keypress` work)
   * was built and measured against a live guest: holding focus across calls put
   * the agent's own text into the user's terminal, at 28, then 95, then 207
   * characters as mitigations were added. A `<webview>` is out-of-process, so
   * acquiring its focus is asynchronous and never atomic, and the user can take
   * it back mid-dispatch. Focus moves only as the side effect of a click, which
   * the renderer guard then restores.
   */
  it('never focuses the guest itself, at any capability tier', async () => {
    const focusCalls: string[] = [];
    const guestWithFocusSpy = { id: 7, isDestroyed: () => false, focus: () => focusCalls.push('focus') };
    vi.mocked(webContents.fromId).mockImplementation((requestedId: number) =>
      requestedId === 7 ? (guestWithFocusSpy as never) : (undefined as never),
    );

    // `eval` is in the list, with its gate opened explicitly. Under the default
    // config an eval call is refused BEFORE `fn` runs, so including the tier
    // without `allowEval` would pass vacuously and the rule's "at ANY capability
    // tier" claim would go untested.
    for (const capability of ['observe', 'interact', 'navigate', 'eval'] as const) {
      await withGuest(
        { selector: { projectId: 'p' }, capability, config: config({ allowEval: true }) },
        async () => 'ran',
      );
    }

    expect(focusCalls).toEqual([]);
  });

  it('WAITS for dialog interception before running the body', async () => {
    // Found by a live agent, not by review. `attachDebugger` is synchronous
    // and its domain enables are fire-and-forget, so the FIRST drive against a
    // guest used to run while `Page.enable` was still in flight. A click that
    // opened a `confirm()` in that window raced ahead of the interceptor:
    // Chromium showed its own native modal, the renderer blocked, every later
    // command queued behind it, and nothing on the agent side could recover -
    // only the user dismissing the box. Every drive after the first was fine,
    // which is exactly why a sweep that calls anything else first never sees it.
    let interceptionResolved = false;
    let releaseInterception = (): void => undefined;
    vi.mocked(waitForDialogInterception).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseInterception = () => { interceptionResolved = true; resolve(); };
      }),
    );

    let bodyRan = false;
    const drive = withGuest(
      { selector: { projectId: 'p' }, capability: 'interact', config: config() },
      async () => { bodyRan = true; return true; },
    );

    // Give the driver every chance to run the body early.
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyRan, 'the body must not run while Page.enable is still in flight').toBe(false);

    releaseInterception();
    await drive;
    expect(interceptionResolved).toBe(true);
    expect(bodyRan).toBe(true);
  });

  it('arms focus emulation before running the operation', async () => {
    // Not cosmetic: the renderer takes the user's focus back off the guest after
    // a drive, and without emulation the guest's own focused element loses it
    // too, so the NEXT type call lands nowhere (measured on Electron 41).
    await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => {
      expect(vi.mocked(ensureFocusEmulation)).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
      return 'ran';
    });
  });

  it('arms focus emulation on an ALREADY-ATTACHED guest too', async () => {
    // Idempotence lives in cdp.ts, so the driver must call unconditionally
    // rather than only on the attaching call - a pane attached by an earlier
    // tool would otherwise never get it.
    vi.mocked(isDebuggerAttached).mockReturnValue(true);
    await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ran');
    expect(vi.mocked(ensureFocusEmulation)).toHaveBeenCalledTimes(1);
  });

  it('does not arm focus emulation when the gate refuses', async () => {
    await withGuest({ selector: { projectId: 'p' }, capability: 'eval', config: config({ allowEval: false }) }, async () => 'ran');
    expect(vi.mocked(ensureFocusEmulation)).not.toHaveBeenCalled();
  });

  /**
   * Passkeys go to a virtual authenticator while an agent drives, so a sign-in
   * page never opens an OS passkey dialog nobody can answer (decision 47). The
   * install must land BEFORE the body: a `navigate` that loads first hands the
   * page's passkey request to Windows, and Chromium never moves it afterwards.
   */
  it('marks the owner and installs the virtual authenticator before the body runs', async () => {
    let releaseInstall = (): void => undefined;
    vi.mocked(ensureVirtualAuthenticator).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { releaseInstall = () => resolve(true); }),
    );
    let bodyRan = false;
    const drive = withGuest(
      { selector: { projectId: 'p' }, capability: 'navigate', config: config() },
      async () => { bodyRan = true; return true; },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyRan, 'the body must not run before the authenticator is installed').toBe(false);
    expect(vi.mocked(markAgentControl)).toHaveBeenCalledWith('p', 't');
    releaseInstall();
    await drive;
    expect(bodyRan).toBe(true);
  });

  it('installs the virtual authenticator on an ALREADY-ATTACHED guest too, at every tier', async () => {
    vi.mocked(isDebuggerAttached).mockReturnValue(true);
    await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ran');
    expect(vi.mocked(ensureVirtualAuthenticator)).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
    expect(vi.mocked(markAgentControl)).toHaveBeenCalledTimes(1);
  });

  // A user loses the report that says which entry point's passkey cover failed (a drive here), so
  // an unattended run that hits the OS dialog again leaves nothing to triage.
  it('reports a refused install with the drive surface tag', async () => {
    passkeyReportTags.length = 0;
    vi.mocked(ensureVirtualAuthenticator).mockResolvedValueOnce(false);
    await withGuest({ selector: { projectId: 'p' }, capability: 'navigate', config: config() }, async () => 'ran');
    expect(passkeyReportTags).toEqual([{ surface: 'drive' }]);
  });

  // A user loses the whole tool call: a guest that refuses the authenticator would fail every
  // drive on that pane instead of only risking the OS dialog.
  it('still runs the body and returns ok when the install is refused', async () => {
    vi.mocked(ensureVirtualAuthenticator).mockResolvedValueOnce(false);
    let bodyRan = false;
    const result = await withGuest(
      { selector: { projectId: 'p' }, capability: 'navigate', config: config() },
      async () => { bodyRan = true; return 'ran'; },
    );
    expect(bodyRan).toBe(true);
    expect(result).toEqual({ ok: true, data: 'ran' });
  });

  it('neither marks nor installs when the gate refuses', async () => {
    await withGuest({ selector: { projectId: 'p' }, capability: 'eval', config: config({ allowEval: false }) }, async () => 'ran');
    expect(vi.mocked(ensureVirtualAuthenticator)).not.toHaveBeenCalled();
    expect(vi.mocked(markAgentControl)).not.toHaveBeenCalled();
  });

  it('brackets the operation with an armed and a disarmed edge', async () => {
    await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => {
      // Mid-operation: the guard must already be armed, or a focus steal that
      // lands during the dispatch has nothing watching for it.
      expect(signalled).toEqual([{ guestId: 7, active: true }]);
      return 'ran';
    });
    settleBurst();
    expect(signalled).toEqual([
      { guestId: 7, active: true },
      { guestId: 7, active: false },
    ]);
  });

  it('ends the signal when the operation THROWS', async () => {
    // The `finally`. A guard that never ends would keep pulling focus out of the
    // pane for the rest of the session, which is worse than the bug it fixes.
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => {
      throw new Error('boom');
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
    settleBurst();
    expect(signalled).toEqual([
      { guestId: 7, active: true },
      { guestId: 7, active: false },
    ]);
  });

  it('signals for an observe-tier call too, not just interact', async () => {
    // Deliberately not tier-gated: `observe` dispatches no input today, but a
    // tier list here goes stale the first time a new primitive lands.
    await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ran');
    settleBurst();
    expect(signalled.map((entry) => entry.active)).toEqual([true, false]);
  });

  it('never signals when the capability gate refuses', async () => {
    // Nothing touched the guest, so arming a guard for it would restore focus
    // out of a pane the user may have clicked into themselves.
    await withGuest({ selector: { projectId: 'p' }, capability: 'eval', config: config({ allowEval: false }) }, async () => 'ran');
    expect(signalled).toEqual([]);
  });

  it('never signals when the target does not resolve', async () => {
    browserPaneRegistry.detachAll();
    await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => 'ran');
    expect(signalled).toEqual([]);
  });

  it('serializes two concurrent drives on one guest instead of interleaving them', async () => {
    // The reported bug: three subagents drove one pane at once, interleaving
    // clicks, navigations and screenshots. `withGuest` now holds a per-guest
    // FIFO, so a second drive does not start until the first has finished.
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => {
      order.push('first:start');
      await firstHeld;
      order.push('first:end');
      return 'first';
    });
    const second = withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => {
      order.push('second:start');
      return 'second';
    });

    // Let the microtasks settle. The second body must NOT have started: under
    // the old unguarded driver it would already have run to completion here.
    // Several turns, because the driver awaits more than once before a body
    // runs (dialog interception, the passkey install).
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(order).toEqual(['first:start']);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('announces one burst across back-to-back drives, not one per call', async () => {
    // The refcount + quiet window still matter with serialization in place:
    // consecutive calls (a `wait` polling between a click and a screenshot) must
    // read as ONE burst to the renderer rather than flapping the guard open and
    // shut between them, which oscillated the user's focus.
    await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'a');
    await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => 'b');

    // Both finished, but the quiet window has not elapsed, so no end edge yet.
    expect(signalled).toEqual([{ guestId: 7, active: true }]);

    settleBurst();
    expect(signalled).toEqual([
      { guestId: 7, active: true },
      { guestId: 7, active: false },
    ]);
  });
});

describe('withGuest - capability gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    // These suites share one guest id against the real registry singleton, so
    // the per-guest drive queues must be dropped between tests or a test that
    // leaves a drive in flight stalls every later one.
    resetGuestDriveQueuesForTests();
    browserPaneRegistry.detachAll();
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
  });

  it('blocks all capabilities when automation is disabled', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config({ enabled: false }) }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'automation-disabled' } });
  });

  it('blocks interaction when allowInteraction is off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config({ allowInteraction: false }) }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'interaction-disabled' } });
  });

  it('blocks navigation when allowNavigation is off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'navigate', config: config({ allowNavigation: false }) }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'navigation-disabled' } });
  });

  it('blocks eval when allowEval is off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'eval', config: config() }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'eval-disabled' } });
  });

  it('allows observe even when interaction/eval are off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'snapshot');
    expect(result).toEqual({ ok: true, data: 'snapshot' });
  });
});

describe('withGuest - resolution and attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    // These suites share one guest id against the real registry singleton, so
    // the per-guest drive queues must be dropped between tests or a test that
    // leaves a drive in flight stalls every later one.
    resetGuestDriveQueuesForTests();
    browserPaneRegistry.detachAll();
  });

  it('attaches lazily then runs the body', async () => {
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    const result = await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'observe', config: config() }, async (guestWebContents) => (guestWebContents as { id: number }).id);
    expect(result).toEqual({ ok: true, data: 7 });
    expect(vi.mocked(attachDebugger)).toHaveBeenCalledTimes(1);
  });

  it('hands the body the RESOLVED ENTRY alongside the guest', async () => {
    // `set_viewport` picks between emulation, a window resize and a lane
    // resize from `entry.kind` plus the pop-out registry. A `WebContents`
    // cannot answer either question, and deriving it from `hostWebContents`
    // would couple the choice to a Chromium detail. If this argument is ever
    // dropped, every call quietly routes down the docked-pane branch, so pin
    // it here rather than only inside the tool.
    browserPaneRegistry.register({ handle: 'lane_z', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null, kind: 'lane' });
    seedGuest(7);
    const seen: { sessionId: string; kind: string }[] = [];
    const result = await withGuest(
      { selector: { sessionId: 'lane_z', projectId: 'p' }, capability: 'observe', config: config() },
      async (_guestWebContents, entry) => {
        seen.push({ sessionId: entry.sessionId, kind: entry.kind });
        return 'ok';
      },
    );
    expect(result).toEqual({ ok: true, data: 'ok' });
    expect(seen).toEqual([{ sessionId: 'lane_z', kind: 'lane' }]);
  });

  it('does not re-attach when the debugger is already attached', async () => {
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(isDebuggerAttached).mockReturnValue(true);
    await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
  });

  it('reports pane-destroyed when the guest no longer resolves', async () => {
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(999); // 7 does not resolve
    const result = await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(result).toMatchObject({ ok: false, error: { kind: 'pane-destroyed' } });
  });

  it('reports no-pane-open when nothing is registered', async () => {
    const result = await withGuest({ selector: { sessionId: 'missing', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(result).toMatchObject({ ok: false, error: { kind: 'no-pane-open' } });
  });

  it('reports surface-gone for a retired handle, verbatim, without attaching CDP or running the body', async () => {
    // The tab an agent was driving went away. The registry's answer names the
    // replacement; the driver must surface it untouched rather than collapsing
    // it into no-pane-open, and must not attach to anything.
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    browserPaneRegistry.unregister('pane_s', 'guest-destroyed');
    const body = vi.fn(async () => 'ran');
    const result = await withGuest(
      { selector: { sessionId: 'pane_s', projectId: 'p', callerTaskId: 't' }, capability: 'observe', config: config() },
      body,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'surface-gone' } });
    expect(result.ok === false && result.error.detail).toContain('pane_s');
    expect(body).not.toHaveBeenCalled();
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
  });

  it('refuses a foreign-project target without running the body or attaching CDP', async () => {
    browserPaneRegistry.register({ handle: 'pane_s2', ownerSessionId: 's2', taskId: 't2', projectId: 'proj-2', webContentsId: 8, url: null });
    seedGuest(8);
    const body = vi.fn(async () => 'ran');
    const result = await withGuest(
      { selector: { sessionId: 'pane_s2', projectId: 'proj-1' }, capability: 'observe', config: config() },
      body,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'foreign-project' } });
    expect(body).not.toHaveBeenCalled();
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
  });

  // A closed task window must not cost the agent its browser, and the user
  // minimizing Kangentic is no reason to stop one either. A capture holds the
  // guest drawing itself (`guest-capture-hold.ts`), and no drive reads the host.
  it('runs a drive against a pane whose host window is minimized', async () => {
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isMinimized: () => true } as never);
    const result = await withGuest(
      { selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'observe', config: config() },
      async () => 'ok',
    );
    expect(result).toEqual({ ok: true, data: 'ok' });
  });

  it('refuses a foreign target BEFORE the liveness check, so it cannot evict another project entry', async () => {
    browserPaneRegistry.register({ handle: 'pane_s2', ownerSessionId: 's2', taskId: 't2', projectId: 'proj-2', webContentsId: 8, url: null });
    seedGuest(999); // 8 does not resolve, so an unscoped path would say pane-destroyed
    const result = await withGuest(
      { selector: { sessionId: 'pane_s2', projectId: 'proj-1' }, capability: 'observe', config: config() },
      async () => 'ok',
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'foreign-project' } });
    expect(browserPaneRegistry.get('pane_s2')).toBeDefined();
  });

  it('reports cdp-attach-failed when attach returns false', async () => {
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(attachDebugger).mockReturnValue(false);
    const result = await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(result).toMatchObject({ ok: false, error: { kind: 'cdp-attach-failed' } });
  });

  it('wraps a thrown body error as driver-error', async () => {
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    const result = await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'observe', config: config() }, async () => {
      throw new Error('boom');
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error', detail: 'boom' } });
  });

  it('reports a key refused for lack of pane focus as pane-not-focused, naming the selector fix', async () => {
    // Its own kind, not a driver-error: the page did nothing wrong, and the
    // agent has one specific fix. A driver-error here reads as "the page
    // broke" and sends the agent looking in the wrong place.
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    const result = await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'interact', config: config() }, async () => {
      throw new KeyboardFocusNotInGuestError();
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'pane-not-focused' } });
    expect(result.ok ? '' : result.error.detail).toContain('selector');
  });

  it('reports a selector that named several visible elements as ambiguous-selector, with its candidates', async () => {
    // Not a driver-error either: the tool refused to guess which match the
    // agent meant (GitHub #820). The candidates have to survive the envelope,
    // or the agent needs another call to learn what to pick.
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    const candidates = [
      { index: 0, tag: 'button', text: 'Save', id: null, role: null, ariaLabel: null, name: null, inDialog: false, topmost: false, box: { x: 0, y: 0, width: 10, height: 10 }, selector: 'html > body > button' },
      { index: 1, tag: 'button', text: 'Save', id: 'modal-save', role: null, ariaLabel: null, name: null, inDialog: true, topmost: true, box: { x: 20, y: 0, width: 10, height: 10 }, selector: '#modal-save' },
    ];
    const result = await withGuest({ selector: { sessionId: 'pane_s', projectId: 'p' }, capability: 'interact', config: config() }, async () => {
      throw new AmbiguousSelectorError('text="Save"', 2, candidates);
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'ambiguous-selector', total: 2, candidates } });
    const detail = result.ok ? '' : result.error.detail;
    expect(detail).toContain('text="Save"');
    expect(detail).toContain('strict: false');
  });
});

describe('validateNavigationUrl', () => {
  it('accepts http and https', () => {
    expect(validateNavigationUrl('http://localhost:4200', config()).ok).toBe(true);
    expect(validateNavigationUrl('https://example.com', config()).ok).toBe(true);
  });

  it('rejects non-http(s) and malformed URLs', () => {
    expect(validateNavigationUrl('ftp://x', config())).toMatchObject({ ok: false, error: { kind: 'invalid-url' } });
    expect(validateNavigationUrl('not a url', config())).toMatchObject({ ok: false, error: { kind: 'invalid-url' } });
  });

  it('with the localhost restriction on, allows local/private hosts and blocks public', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    expect(validateNavigationUrl('http://localhost:4200', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://127.0.0.1:3000', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://192.168.1.10', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://dev-box:8080', restricted).ok).toBe(true);
    expect(validateNavigationUrl('https://github.com', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
  });

  it('with the restriction off, allows public hosts', () => {
    expect(validateNavigationUrl('https://github.com', config()).ok).toBe(true);
  });

  it('private IPv4 ranges (10.x, 172.16-31.x, 169.254.x) are allowed under the restriction', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // RFC-1918 10.0.0.0/8
    expect(validateNavigationUrl('http://10.1.2.3', restricted).ok).toBe(true);
    // RFC-1918 172.16.0.0/12 lower bound
    expect(validateNavigationUrl('http://172.16.0.1', restricted).ok).toBe(true);
    // RFC-1918 172.16.0.0/12 upper bound
    expect(validateNavigationUrl('http://172.31.255.1', restricted).ok).toBe(true);
    // link-local 169.254.0.0/16
    expect(validateNavigationUrl('http://169.254.1.1', restricted).ok).toBe(true);
  });

  it('mDNS (.local) and .localhost subdomains are allowed under the restriction', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    expect(validateNavigationUrl('http://foo.local', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://app.localhost', restricted).ok).toBe(true);
  });

  it('IPv6 private/loopback addresses are allowed under the restriction', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // ::1 loopback (URL percent-encodes brackets, hostname strips them)
    expect(validateNavigationUrl('http://[::1]/', restricted).ok).toBe(true);
    // fc00::/7 unique-local fc.. prefix
    expect(validateNavigationUrl('http://[fc00::1]/', restricted).ok).toBe(true);
    // fc00::/7 unique-local fd.. prefix
    expect(validateNavigationUrl('http://[fd12:3456::1]/', restricted).ok).toBe(true);
  });

  it('public IPv4 addresses just outside RFC-1918 172.16-31 are blocked', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // 172.15.x.x is public (one below the lower bound of 172.16)
    expect(validateNavigationUrl('http://172.15.0.1', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
    // 172.32.x.x is public (one above the upper bound of 172.31)
    expect(validateNavigationUrl('http://172.32.0.1', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
  });

  // Regression lock: before the `if (host.includes(':')) return false;` guard
  // was added to isLoopbackOrPrivateHost, a dotless IPv6 literal (e.g.
  // '2001:db8::1' after bracket-stripping) fell through to the single-label
  // check (!host.includes('.')) and was WRONGLY classified as a private
  // intranet name, allowing navigation to arbitrary public IPv6 hosts.
  // Removing that one guard line makes this test go red. Keep it to lock
  // the regression.
  it('public IPv6 addresses are blocked under the restriction (IPv6-as-single-label regression)', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // Documentation range - public IPv6
    expect(validateNavigationUrl('http://[2001:db8::1]/', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
    // Global unicast - public IPv6
    expect(validateNavigationUrl('http://[2600:1234::abcd]/', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
  });
});

/**
 * A page whose renderer process is gone answers no CDP command, so a drive used
 * to attach and wait out its timeout (task #1226, DESKTOP-5Z). `withGuest` now
 * refuses at once with `page-crashed`, and the navigate tier, which the refusal
 * tells the agent to use, starts the page again first.
 */
describe('withGuest - a crashed page', () => {
  /** A guest whose page process can die and come back, with real event wiring. */
  function crashableGuest(id: number, options: { reloadRevives: boolean }) {
    const events = new EventEmitter();
    const guest = {
      id,
      crashed: false,
      reloads: 0,
      isDestroyed: () => false,
      isCrashed: () => guest.crashed,
      reload: () => {
        guest.reloads += 1;
        if (!options.reloadRevives) return;
        guest.crashed = false;
        events.emit('dom-ready');
      },
      on: (name: string, listener: (...args: unknown[]) => void) => { events.on(name, listener); return guest; },
      once: (name: string, listener: (...args: unknown[]) => void) => { events.once(name, listener); return guest; },
      removeListener: (name: string, listener: (...args: unknown[]) => void) => { events.removeListener(name, listener); return guest; },
      crash: (reason: string) => {
        guest.crashed = true;
        events.emit('render-process-gone', {}, { reason, exitCode: 1 });
      },
    };
    trackGuestCrash(guest as never);
    vi.mocked(webContents.fromId).mockImplementation((requestedId: number) =>
      requestedId === id ? (guest as never) : (undefined as never));
    return guest;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    resetGuestDriveQueuesForTests();
    browserPaneRegistry.detachAll();
    browserPaneRegistry.register({ handle: 'pane_c', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 11, url: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a drive at once with page-crashed, naming the surface and why, and never attaches', async () => {
    const guest = crashableGuest(11, { reloadRevives: true });
    guest.crash('oom');
    const body = vi.fn(async () => 'ran');

    // No timer is advanced: a refusal that waited on anything would never settle.
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, body);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('page-crashed');
    expect(result.error.detail).toContain('pane_c');
    expect(result.error.detail).toContain('ran out of memory');
    expect(result.error.detail).toContain('kangentic_browser_navigate');
    expect(body).not.toHaveBeenCalled();
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
    expect(vi.mocked(waitForDialogInterception)).not.toHaveBeenCalled();
    expect(guest.reloads).toBe(0);
  });

  it('says "crashed" for every reason that is not memory', async () => {
    const guest = crashableGuest(11, { reloadRevives: true });
    guest.crash('killed');
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config() }, async () => 'ran');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('page-crashed');
    expect(result.error.detail).toContain('it crashed');
  });

  it('a navigate starts the page again, then runs its body on the live guest', async () => {
    const guest = crashableGuest(11, { reloadRevives: true });
    guest.crash('oom');
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'navigate', config: config() }, async () => 'navigated');
    expect(result).toEqual({ ok: true, data: 'navigated' });
    expect(guest.reloads).toBe(1);
    expect(vi.mocked(attachDebugger)).toHaveBeenCalledTimes(1);

    // Revived: the next drive at any tier runs normally.
    const after = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'observed');
    expect(after).toEqual({ ok: true, data: 'observed' });
  });

  it('a navigate whose page never comes back answers page-crashed at the navigation bound', async () => {
    const guest = crashableGuest(11, { reloadRevives: false });
    guest.crash('crashed');
    const body = vi.fn(async () => 'navigated');
    const pending = withGuest({ selector: { projectId: 'p' }, capability: 'navigate', config: config() }, body);
    await vi.advanceTimersByTimeAsync(NAVIGATE_TIMEOUT_MS);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('page-crashed');
    expect(body).not.toHaveBeenCalled();
    expect(guest.reloads).toBe(1);
  });

  it('refuses a guest Electron reports crashed that this module never heard of, saying "it crashed"', async () => {
    const guest = crashableGuest(11, { reloadRevives: true });
    // No render-process-gone event: only `isCrashed()` knows.
    guest.crashed = true;
    const body = vi.fn(async () => 'ran');
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('page-crashed');
    expect(result.error.detail).toContain('it crashed');
    expect(body).not.toHaveBeenCalled();
  });
});

/**
 * `reviveCrashedGuest` on its own: the reload that starts a stopped page again, shared by
 * every caller that arrives before it finishes (task #1226).
 */
describe('reviveCrashedGuest', () => {
  function revivableGuest(id: number, options: { reloadThrows: boolean }) {
    const events = new EventEmitter();
    const guest = {
      id,
      reloads: 0,
      reload: () => {
        guest.reloads += 1;
        if (options.reloadThrows) throw new Error('guest is being torn down');
      },
      once: (name: string, listener: (...args: unknown[]) => void) => { events.once(name, listener); return guest; },
      removeListener: (name: string, listener: (...args: unknown[]) => void) => { events.removeListener(name, listener); return guest; },
      domReady: () => events.emit('dom-ready'),
      domReadyListeners: () => events.listenerCount('dom-ready'),
    };
    return guest;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves false at once, with no dom-ready listener left behind, when reload throws', async () => {
    const guest = revivableGuest(21, { reloadThrows: true });
    // No timer is advanced: a throwing reload must not wait out the navigation bound.
    await expect(reviveCrashedGuest(guest as never)).resolves.toBe(false);
    expect(guest.reloads).toBe(1);
    expect(guest.domReadyListeners()).toBe(0);
  });

  it('shares one reload between revives that arrive before dom-ready, then reloads again once settled', async () => {
    const guest = revivableGuest(22, { reloadThrows: false });
    const first = reviveCrashedGuest(guest as never);
    const second = reviveCrashedGuest(guest as never);
    expect(guest.reloads).toBe(1);

    guest.domReady();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(guest.reloads).toBe(1);

    const third = reviveCrashedGuest(guest as never);
    expect(guest.reloads).toBe(2);
    guest.domReady();
    await expect(third).resolves.toBe(true);
  });
});
