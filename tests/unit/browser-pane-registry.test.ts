/**
 * Unit tests for BrowserPaneRegistry in
 * src/main/browser/browser-pane-registry.ts.
 *
 * The registry maps open Browser surfaces to their guest webContents so the
 * kangentic_browser_* MCP tools can target them. The load-bearing behaviors:
 * a surface handle names ONE guest for its whole life (re-registering the same
 * guest keeps it, a new guest gets a new one, a gone guest's handle says so),
 * target resolution (handle / taskId / own-task-only implicit default / rank
 * by kind / ambiguous), self-healing eviction of a destroyed guest, and
 * synchronous detach-all on shutdown.
 *
 * electron's `webContents.fromId` and the CDP helpers are mocked so the suite
 * is pure Node with no real Electron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  detachDebugger: vi.fn(),
  isDebuggerAttached: vi.fn(() => false),
}));
vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
}));

import { webContents } from 'electron';
import { detachDebugger, isDebuggerAttached } from '../../src/main/browser/cdp/cdp';
import { trackFeatureUsed } from '../../src/main/analytics/usage';
import { BrowserPaneRegistry, type RegisterSurfaceInput } from '../../src/main/browser/browser-pane-registry';

interface FakeGuest {
  id: number;
  destroyed: boolean;
  isDestroyed(): boolean;
  getURL(): string;
}

function fakeGuest(id: number, destroyed = false, liveUrl = ''): FakeGuest {
  return { id, destroyed, isDestroyed: () => destroyed, getURL: () => liveUrl };
}

/** Wire `webContents.fromId` to resolve a set of fake guests by id. */
function seedGuests(...guests: FakeGuest[]): void {
  const byId = new Map(guests.map((guest) => [guest.id, guest]));
  vi.mocked(webContents.fromId).mockImplementation((id: number) => byId.get(id) as never);
}

// Explicit handles keep lookups deterministic; the renderer path never passes
// one and gets a minted `pane_` handle (pinned in the "surface handles" block).
const REGISTER_A: RegisterSurfaceInput = { handle: 'pane_aaaaaaaa', ownerSessionId: 'sess-a', taskId: 'task-1', projectId: 'proj-1', webContentsId: 11, url: 'http://localhost:4200' };
const REGISTER_B: RegisterSurfaceInput = { handle: 'pane_bbbbbbbb', ownerSessionId: 'sess-b', taskId: 'task-2', projectId: 'proj-1', webContentsId: 22, url: null };
/** A pane in a DIFFERENT project, for the cross-project isolation cases. */
const REGISTER_C: RegisterSurfaceInput = { handle: 'pane_cccccccc', ownerSessionId: 'sess-c', taskId: 'task-3', projectId: 'proj-2', webContentsId: 33, url: 'http://127.0.0.1:8099/admin' };
/** A lane main stood up when task-1's window closed. */
const HANDOFF_LANE: RegisterSurfaceInput = { handle: 'lane_11111111', ownerSessionId: 'sess-a', taskId: 'task-1', projectId: 'proj-1', webContentsId: 44, url: 'http://localhost:4200', kind: 'lane', handoff: true };
/** A lane task-1's agent asked for with `isolated: true`. */
const ISOLATED_LANE: RegisterSurfaceInput = { handle: 'lane_22222222', ownerSessionId: 'sess-a', taskId: 'task-1', projectId: 'proj-1', webContentsId: 55, url: 'http://localhost:4200', kind: 'lane' };

describe('BrowserPaneRegistry', () => {
  let registry: BrowserPaneRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    registry = new BrowserPaneRegistry();
  });

  it('registers and gets a pane', () => {
    registry.register(REGISTER_A);
    expect(registry.size).toBe(1);
    expect(registry.get('pane_aaaaaaaa')?.taskId).toBe('task-1');
    expect(registry.get('pane_aaaaaaaa')?.ownerSessionId).toBe('sess-a');
    expect(registry.get('pane_aaaaaaaa')?.url).toBe('http://localhost:4200');
    expect(registry.get('pane_aaaaaaaa')).toMatchObject({ kind: 'pane', handoff: false });
  });

  /**
   * `trackFeatureUsed('browser_pane')` is the adoption signal added alongside
   * this registry (see browser-pane-registry.ts's `register()`). It has two
   * ways to be wrong: counting an offscreen lane (the driver's own plumbing,
   * never a user opening the Browser pane) as adoption, and re-counting a
   * rebind of an already-known guest (a `/clear` session rotation) as a new
   * adoption event.
   */
  describe('adoption signal (trackFeatureUsed)', () => {
    it('fires browser_pane for a new pane registration', () => {
      registry.register(REGISTER_A);
      expect(vi.mocked(trackFeatureUsed)).toHaveBeenCalledWith('browser_pane');
    });

    it('does NOT fire for a lane registration (offscreen driver plumbing, not a user pane)', () => {
      registry.register(ISOLATED_LANE);
      expect(vi.mocked(trackFeatureUsed)).not.toHaveBeenCalled();
    });

    it('does NOT re-fire when the SAME guest re-registers (a rebind, not a new entry)', () => {
      registry.register(REGISTER_A);
      vi.mocked(trackFeatureUsed).mockClear();
      registry.register({ ...REGISTER_A, handle: undefined, ownerSessionId: 'sess-a2' });
      expect(vi.mocked(trackFeatureUsed)).not.toHaveBeenCalled();
    });
  });

  it('unregisters by handle and by webContentsId', () => {
    registry.register(REGISTER_A);
    registry.register(REGISTER_B);
    registry.unregister('pane_aaaaaaaa');
    expect(registry.get('pane_aaaaaaaa')).toBeUndefined();
    registry.unregisterByWebContentsId(22);
    expect(registry.get('pane_bbbbbbbb')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  /**
   * Where a surface is on the user's screen is the agent's only way to know
   * whether the user can SEE what it is doing. The renderer is the only side
   * that knows, so the registry records what it is told and defaults sanely.
   */
  describe('visibility', () => {
    it('defaults a pane to showing and a lane to offscreen', () => {
      registry.register(REGISTER_A);
      registry.register(ISOLATED_LANE);
      expect(registry.get('pane_aaaaaaaa')?.visibility).toBe('showing');
      expect(registry.get('lane_22222222')?.visibility).toBe('offscreen');
    });

    it('takes the visibility a registration carries, and updates it in place on a re-register', () => {
      registry.register({ ...REGISTER_A, visibility: 'hidden' });
      expect(registry.get('pane_aaaaaaaa')?.visibility).toBe('hidden');
      // Same guest, new owner (a session rotation) - the handle and the
      // reported visibility both survive; a re-register without one keeps it.
      registry.register({ ...REGISTER_A, handle: undefined, ownerSessionId: 'sess-a2' });
      expect(registry.get('pane_aaaaaaaa')?.visibility).toBe('hidden');
      registry.register({ ...REGISTER_A, handle: undefined, visibility: 'parked' });
      expect(registry.get('pane_aaaaaaaa')?.visibility).toBe('parked');
    });

    it('setVisibility records a change by guest id, reports whether anything changed, and ignores an unknown guest', () => {
      registry.register(REGISTER_A);
      expect(registry.setVisibility(11, 'hidden')).toBe(true);
      expect(registry.get('pane_aaaaaaaa')?.visibility).toBe('hidden');
      expect(registry.setVisibility(11, 'hidden')).toBe(false);
      expect(registry.setVisibility(999, 'parked')).toBe(false);
    });

    it('lists the visibility alongside the rest of the status, so list_panes carries it', () => {
      seedGuests(fakeGuest(11));
      registry.register({ ...REGISTER_A, visibility: 'parked' });
      expect(registry.list()[0]).toMatchObject({ sessionId: 'pane_aaaaaaaa', visibility: 'parked', alive: true });
    });
  });

  /**
   * The user's Close control retires the handle with its own reason, so the
   * agent is told WHO closed its tab rather than "the window was closed".
   */
  it('words a user-closed retirement as the user closing the browser', () => {
    registry.register(REGISTER_A);
    registry.unregisterByWebContentsId(11, 'user-closed');
    const result = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: 'proj-1', callerTaskId: 'task-1' });
    expect(result).toMatchObject({ ok: false, kind: 'surface-gone' });
    expect(result.ok === false && result.detail).toContain('the user closed the browser');
    expect(result.ok === false && result.detail).toContain('kangentic_browser_open_pane');
  });

  /**
   * The defect this registry was rebuilt around: it used to key entries by the
   * agent session id and overwrite on register, so every remount re-bound the
   * same key to a new guest and an agent holding the key silently addressed a
   * different tab. A handle now names ONE guest for its whole life.
   */
  describe('surface handles', () => {
    it('mints a pane_ handle for a registration that brings none', () => {
      const entry = registry.register({ ownerSessionId: 'sess-a', taskId: 'task-1', projectId: 'proj-1', webContentsId: 11, url: null });
      expect(entry.sessionId).toMatch(/^pane_[0-9a-f]{8}$/);
      expect(registry.get(entry.sessionId)).toBe(entry);
    });

    it('keeps the handle when the SAME guest registers again, and updates the owner in place', () => {
      // A `/clear` rotates the task's session; the pane's guest never moved.
      registry.register(REGISTER_A);
      const rebound = registry.register({ ...REGISTER_A, handle: undefined, ownerSessionId: 'sess-a2', url: null });
      expect(rebound.sessionId).toBe('pane_aaaaaaaa');
      expect(registry.size).toBe(1);
      expect(registry.get('pane_aaaaaaaa')?.ownerSessionId).toBe('sess-a2');
      // A rebind with no URL keeps the one already known.
      expect(registry.get('pane_aaaaaaaa')?.url).toBe('http://localhost:4200');
    });

    it('gives a DIFFERENT guest for the same task and owner a new handle', () => {
      registry.register(REGISTER_A);
      const second = registry.register({ ...REGISTER_A, handle: undefined, webContentsId: 12 });
      expect(second.sessionId).not.toBe('pane_aaaaaaaa');
      expect(second.sessionId).toMatch(/^pane_/);
      expect(registry.size).toBe(2);
    });

    it('keeps a lane_ handle verbatim', () => {
      expect(registry.register(HANDOFF_LANE).sessionId).toBe('lane_11111111');
      expect(registry.get('lane_11111111')).toMatchObject({ kind: 'lane', handoff: true, ownerSessionId: 'sess-a' });
    });
  });

  describe('unregisterByWebContentsId', () => {
    it('removes only the guest named, never a newer registration for the same task (race guard)', () => {
      // A pop-out registers a NEW guest for task-1 BEFORE the in-app pane's own
      // unmount cleanup (carrying its stale guest id 11) runs. The stale cleanup
      // must not clobber the newer registration.
      registry.register(REGISTER_A); // guest 11
      const popOut = registry.register({ ...REGISTER_A, handle: undefined, webContentsId: 22 });
      registry.unregisterByWebContentsId(11, 'renderer-unmount');
      expect(registry.get('pane_aaaaaaaa')).toBeUndefined();
      expect(registry.get(popOut.sessionId)?.webContentsId).toBe(22);
    });

    it('records the reason it was given', () => {
      registry.register(REGISTER_A);
      registry.unregisterByWebContentsId(11, 'renderer-unmount');
      const result = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'surface-gone' });
      expect(result.ok === false && result.detail).toContain('its pane unmounted');
    });

    it('is a harmless no-op for an unknown guest', () => {
      expect(() => registry.unregisterByWebContentsId(5)).not.toThrow();
      expect(registry.size).toBe(0);
    });
  });

  it('updates url by handle and by webContentsId', () => {
    registry.register(REGISTER_B);
    registry.updateUrl('pane_bbbbbbbb', 'http://localhost:5173');
    expect(registry.get('pane_bbbbbbbb')?.url).toBe('http://localhost:5173');
    registry.updateUrlByWebContentsId(22, 'http://localhost:8080');
    expect(registry.get('pane_bbbbbbbb')?.url).toBe('http://localhost:8080');
  });

  it('getByTaskId filters by task and optional project', () => {
    registry.register(REGISTER_A);
    registry.register({ ...REGISTER_B, taskId: 'task-1', projectId: 'proj-2' });
    expect(registry.getByTaskId('task-1')).toHaveLength(2);
    expect(registry.getByTaskId('task-1', 'proj-1')).toHaveLength(1);
    expect(registry.getByTaskId('task-1', 'proj-1')[0].sessionId).toBe('pane_aaaaaaaa');
  });

  it('list() enriches with alive + debuggerAttached', () => {
    registry.register(REGISTER_A);
    registry.register(REGISTER_B);
    seedGuests(fakeGuest(11), fakeGuest(22, true)); // 11 alive, 22 destroyed
    vi.mocked(isDebuggerAttached).mockImplementation((guest) => (guest as FakeGuest).id === 11);
    const list = registry.list();
    const a = list.find((entry) => entry.sessionId === 'pane_aaaaaaaa');
    const b = list.find((entry) => entry.sessionId === 'pane_bbbbbbbb');
    expect(a?.alive).toBe(true);
    expect(a?.debuggerAttached).toBe(true);
    expect(a?.ownerSessionId).toBe('sess-a');
    expect(b?.alive).toBe(false);
    expect(b?.debuggerAttached).toBe(false);
  });

  // `projectId: null` is the deliberate UNSCOPED path, reserved for
  // main-process internal callers. Every case in this block passes it
  // explicitly so it reads as a choice rather than an omission; the scoped
  // behavior an MCP caller actually gets is covered in the block below.
  describe('resolveTarget (unscoped, projectId: null)', () => {
    it('resolves by handle', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: null });
      expect(result.ok).toBe(true);
      expect(result.ok && result.entry.taskId).toBe('task-1');
    });

    it('errors no-pane-open for a value that was never a handle', () => {
      const result = registry.resolveTarget({ sessionId: 'nope', projectId: null });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
    });

    it('resolves by taskId when exactly one matches', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ taskId: 'task-1', projectId: null });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it('errors multiple-panes when a taskId matches more than one pane', () => {
      registry.register(REGISTER_A);
      registry.register({ ...REGISTER_B, taskId: 'task-1' });
      const result = registry.resolveTarget({ taskId: 'task-1', projectId: null });
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
      expect(result.ok === false && result.candidates).toHaveLength(2);
    });

    it('defaults to the single open pane when no selector is given', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ projectId: null });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it('errors multiple-panes with no selector when more than one is open', () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      const result = registry.resolveTarget({ projectId: null });
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
    });

    it('errors no-pane-open with no selector when none are open', () => {
      expect(registry.resolveTarget({ projectId: null })).toMatchObject({ ok: false, kind: 'no-pane-open' });
    });

    it('still spans projects, so the unscoped path is genuinely unscoped', () => {
      registry.register(REGISTER_A); // proj-1
      registry.register(REGISTER_C); // proj-2
      const result = registry.resolveTarget({ projectId: null });
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
      expect(result.ok === false && result.candidates).toHaveLength(2);
    });
  });

  // The cross-project isolation bug: an agent in one project could drive a
  // Browser pane belonging to a task in another. Every branch of resolveTarget
  // now refuses out-of-scope panes.
  describe('resolveTarget (caller project scoping)', () => {
    it('refuses a handle belonging to another project', () => {
      registry.register(REGISTER_C); // proj-2
      const result = registry.resolveTarget({ sessionId: 'pane_cccccccc', projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'foreign-project' });
      // The no-pane-open copy tells the agent to open the Browser pill, which
      // is wrong and unactionable when the pane is open and simply not theirs.
      expect(result.ok === false && result.detail).not.toContain('Browser pill');
    });

    it('refuses a taskId whose pane lives in another project', () => {
      registry.register(REGISTER_C);
      const result = registry.resolveTarget({ taskId: 'task-3', projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'foreign-project' });
    });

    it('still reports no-pane-open for a task with no pane anywhere', () => {
      registry.register(REGISTER_C);
      const result = registry.resolveTarget({ taskId: 'task-nowhere', projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
    });

    it('resolves an in-scope handle (no false refusal)', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: 'proj-1' });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it('ignores another project when defaulting, instead of erroring ambiguous', () => {
      registry.register(REGISTER_A); // proj-1
      registry.register(REGISTER_C); // proj-2
      const result = registry.resolveTarget({ projectId: 'proj-1' });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it('never defaults into another project when the caller has no pane', () => {
      registry.register(REGISTER_C); // proj-2 only
      const result = registry.resolveTarget({ projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
      expect(result.ok === false && result.detail).toContain('in this project');
    });

    it("prefers the caller's own task over an in-project ambiguity", () => {
      registry.register(REGISTER_A); // task-1
      registry.register(REGISTER_B); // task-2
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-2' });
      expect(result.ok && result.entry.sessionId).toBe('pane_bbbbbbbb');
    });

    it("prefers the surface the caller's own session owns when no task lookup is available", () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerSessionId: 'sess-b' });
      expect(result.ok && result.entry.sessionId).toBe('pane_bbbbbbbb');
    });

    it('a caller with NO task still falls through to the single pane when its session owns none', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerSessionId: 'sess-nobody' });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it("reports an own-task ambiguity against the caller's task", () => {
      registry.register(REGISTER_A);
      registry.register({ ...REGISTER_B, taskId: 'task-1' });
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
      expect(result.ok === false && result.detail).toContain('your own task');
      expect(result.ok === false && result.candidates).toHaveLength(2);
    });

    it("does not prefer the caller's own pane when it sits in another project", () => {
      registry.register(REGISTER_A); // proj-1
      registry.register(REGISTER_C); // proj-2, and it is the caller's own session
      const result = registry.resolveTarget({ projectId: 'proj-1', callerSessionId: 'sess-c' });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it('excludes a pane with no project recorded, and says so', () => {
      registry.register({ ...REGISTER_A, projectId: null });
      const result = registry.resolveTarget({ projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
      expect(result.ok === false && result.detail).toContain('no project recorded');
    });

    it('keeps a pane with no project recorded reachable from an unscoped caller', () => {
      registry.register({ ...REGISTER_A, projectId: null });
      const result = registry.resolveTarget({ projectId: null });
      expect(result.ok && result.entry.sessionId).toBe('pane_aaaaaaaa');
    });
  });

  /**
   * Observed live: an agent whose own pane had died (and whose hand-off lane
   * had failed to load) called navigate with no target, the caller-task rule
   * matched nothing and fell through to "the single pane in the project", and
   * the driver navigated a SIBLING task's logged-in app to an identity-provider
   * URL. A caller bound to a task never leaves its own task's surfaces.
   */
  describe('resolveTarget (own-task-only implicit default)', () => {
    it('refuses rather than falling through to another task\'s only pane', () => {
      registry.register(REGISTER_A); // task-1's pane, the only one in the project
      const result = registry.resolveTarget({ projectId: 'proj-1', callerSessionId: 'sess-b', callerTaskId: 'task-b' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
      expect(result.ok === false && result.detail).toContain('task-b');
      expect(result.ok === false && result.detail).toContain('belongs to another task');
      expect(result.ok === false && result.detail).toContain('kangentic_browser_open_pane');
    });

    it('refuses with no-pane-open, never multiple-panes, however many other tasks have panes', () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-nobody-has' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
      expect(result.ok === false && result.detail).toContain('2 Browser panes open in this project belong to other tasks');
    });

    it('names an own-task pane that registered with no project, since a scoped caller cannot reach it', () => {
      registry.register({ ...REGISTER_A, projectId: null });
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
      expect(result.ok === false && result.detail).toContain('no project recorded');
    });
  });

  /**
   * A hand-off lane and the returning visible pane briefly coexist, and an
   * agent may hold an isolated lane beside the shared pane. Rank decides,
   * deterministically: pane, then hand-off lane, then isolated lane.
   */
  describe('resolveTarget (rank by kind)', () => {
    it('prefers the visible pane over every lane', () => {
      registry.register(HANDOFF_LANE);
      registry.register(ISOLATED_LANE);
      registry.register(REGISTER_A);
      const implicit = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(implicit.ok && implicit.entry.sessionId).toBe('pane_aaaaaaaa');
      const explicit = registry.resolveTarget({ taskId: 'task-1', projectId: 'proj-1' });
      expect(explicit.ok && explicit.entry.sessionId).toBe('pane_aaaaaaaa');
    });

    it('prefers the hand-off lane once the pane is gone', () => {
      registry.register(HANDOFF_LANE);
      registry.register(ISOLATED_LANE);
      const implicit = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(implicit.ok && implicit.entry.sessionId).toBe('lane_11111111');
      const explicit = registry.resolveTarget({ taskId: 'task-1', projectId: 'proj-1' });
      expect(explicit.ok && explicit.entry.sessionId).toBe('lane_11111111');
    });

    it('falls back to a lone isolated lane', () => {
      registry.register(ISOLATED_LANE);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(result.ok && result.entry.sessionId).toBe('lane_22222222');
    });

    it('refuses two surfaces of the same rank and lists their handles', () => {
      registry.register(ISOLATED_LANE);
      registry.register({ ...ISOLATED_LANE, handle: 'lane_33333333', webContentsId: 66 });
      const implicit = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(implicit).toMatchObject({ ok: false, kind: 'multiple-panes' });
      expect(implicit.ok === false && implicit.candidates).toHaveLength(2);
      expect(implicit.ok === false && implicit.detail).toContain('lane_22222222 (isolated lane)');
      const explicit = registry.resolveTarget({ taskId: 'task-1', projectId: 'proj-1' });
      expect(explicit).toMatchObject({ ok: false, kind: 'multiple-panes' });
    });
  });

  /**
   * A handle whose guest is gone must SAY so. The old behavior was silent
   * retargeting; the fallback before that was a bare `no-pane-open` whose hint
   * sends the agent to open a pane it may already have.
   */
  describe('retired surfaces', () => {
    it('reports surface-gone with the reason, what did not carry over, and the open_pane hint when nothing replaced it', () => {
      registry.register(REGISTER_A);
      registry.unregister('pane_aaaaaaaa', 'guest-destroyed');
      const result = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(result).toMatchObject({ ok: false, kind: 'surface-gone' });
      const detail = result.ok === false ? result.detail : '';
      expect(detail).toContain('pane_aaaaaaaa');
      expect(detail).toContain('its pane unmounted');
      expect(detail).toContain('sessionStorage');
      expect(detail).toContain('kangentic_browser_open_pane');
    });

    it('names the replacement surface and its live URL', () => {
      registry.register(REGISTER_A);
      registry.unregister('pane_aaaaaaaa', 'guest-destroyed');
      registry.register({ ...REGISTER_A, handle: 'pane_a2a2a2a2', webContentsId: 12 });
      seedGuests(fakeGuest(12, false, 'http://localhost:4200/estimates'));
      const result = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: 'proj-1', callerTaskId: 'task-1' });
      expect(result).toMatchObject({ ok: false, kind: 'surface-gone' });
      const detail = result.ok === false ? result.detail : '';
      expect(detail).toContain('pane_a2a2a2a2 (pane)');
      expect(detail).toContain('http://localhost:4200/estimates');
      expect(detail).toContain('Pass it as sessionId');
    });

    it('words each reason for the agent', () => {
      registry.register(HANDOFF_LANE);
      registry.unregister('lane_11111111', 'lane-destroyed');
      const lane = registry.resolveTarget({ sessionId: 'lane_11111111', projectId: 'proj-1' });
      expect(lane.ok === false && lane.detail).toContain('the lane was closed');

      registry.register(REGISTER_A);
      seedGuests(); // guest 11 no longer resolves
      registry.resolveLiveGuest(registry.get('pane_aaaaaaaa')!);
      const healed = registry.resolveTarget({ sessionId: 'pane_aaaaaaaa', projectId: 'proj-1' });
      expect(healed).toMatchObject({ ok: false, kind: 'surface-gone' });
      expect(healed.ok === false && healed.detail).toContain('its tab was destroyed');
    });

    it('refuses a retired handle from another project as foreign, not gone', () => {
      registry.register(REGISTER_C);
      registry.unregister('pane_cccccccc', 'guest-destroyed');
      const result = registry.resolveTarget({ sessionId: 'pane_cccccccc', projectId: 'proj-1' });
      expect(result).toMatchObject({ ok: false, kind: 'foreign-project' });
    });

    it('tells a caller passing an agent session id that it is not a handle', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11, false, 'http://localhost:4200'));
      const result = registry.resolveTarget({
        sessionId: 'a5058ec6-0000-4000-8000-000000000000',
        projectId: 'proj-1',
        callerTaskId: 'task-1',
      });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
      const detail = result.ok === false ? result.detail : '';
      expect(detail).toContain('not a browser surface handle');
      expect(detail).toContain('a Kangentic session id is not one');
      expect(detail).toContain('pane_aaaaaaaa (pane)');
    });

    it('points a caller with no task at list_panes', () => {
      const result = registry.resolveTarget({ sessionId: 'nope', projectId: 'proj-1' });
      expect(result.ok === false && result.detail).toContain('kangentic_browser_list_panes');
    });

    it('remembers a bounded number of retired handles', () => {
      for (let index = 0; index < 65; index += 1) {
        const handle = `pane_${index.toString(16).padStart(8, '0')}`;
        registry.register({ ...REGISTER_A, handle, webContentsId: 100 + index });
        registry.unregister(handle, 'guest-destroyed');
      }
      const oldest = registry.resolveTarget({ sessionId: 'pane_00000000', projectId: 'proj-1' });
      expect(oldest).toMatchObject({ ok: false, kind: 'no-pane-open' });
      const newest = registry.resolveTarget({ sessionId: 'pane_00000040', projectId: 'proj-1' });
      expect(newest).toMatchObject({ ok: false, kind: 'surface-gone' });
    });
  });

  describe('deliberate closes', () => {
    it('tells the closed handler when an unregister was marked deliberate, and only then', () => {
      const closed: Array<{ handle: string; deliberate: boolean }> = [];
      registry.setPaneClosedHandler((entry, _reason, deliberate) => {
        closed.push({ handle: entry.sessionId, deliberate });
      });
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      registry.markDeliberateClose(['pane_aaaaaaaa']);
      registry.unregisterByWebContentsId(11, 'renderer-unmount');
      registry.unregisterByWebContentsId(22, 'renderer-unmount');
      expect(closed).toEqual([
        { handle: 'pane_aaaaaaaa', deliberate: true },
        { handle: 'pane_bbbbbbbb', deliberate: false },
      ]);
    });

    it('consumes the mark, so a later unregister of a new guest is not deliberate', () => {
      const deliberateFlags: boolean[] = [];
      registry.setPaneClosedHandler((_entry, _reason, deliberate) => {
        deliberateFlags.push(deliberate);
      });
      registry.register(REGISTER_A);
      registry.markDeliberateClose(['pane_aaaaaaaa']);
      registry.unregister('pane_aaaaaaaa');
      registry.register(REGISTER_A);
      registry.unregister('pane_aaaaaaaa');
      expect(deliberateFlags).toEqual([true, false]);
    });
  });

  // The cached `url` is only as fresh as the did-navigate events feeding it,
  // and same-document navigation (SPA routing, pushState, a fragment change)
  // never fires did-navigate at all. A dev server is exactly what a pane points
  // at, so the cache drifts there by design and list_panes reported a URL the
  // pane had left.
  describe('list() reports the live URL', () => {
    it('prefers the guest URL over the value captured at registration', () => {
      registry.register(REGISTER_A); // registered at http://localhost:4200
      seedGuests(fakeGuest(11, false, 'http://localhost:4200/settings?tab=git'));

      const entry = registry.list().find((pane) => pane.sessionId === 'pane_aaaaaaaa');
      expect(entry?.url).toBe('http://localhost:4200/settings?tab=git');
    });

    it('keeps the last known URL when the guest is gone', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11, true, 'ignored-because-destroyed'));

      const entry = registry.list().find((pane) => pane.sessionId === 'pane_aaaaaaaa');
      expect(entry?.alive).toBe(false);
      expect(entry?.url).toBe('http://localhost:4200');
    });

    it('falls back to the cached URL when the guest reports an empty one', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11, false, ''));

      const entry = registry.list().find((pane) => pane.sessionId === 'pane_aaaaaaaa');
      expect(entry?.url).toBe('http://localhost:4200');
    });

    it('keeps the cached URL and stays alive when the live guest read throws', () => {
      // The guest can be torn down between the alive check and the getURL()
      // call; the try/catch must swallow that and keep the cache rather than
      // letting the throw escape list(). alive stays true here (the liveness
      // check itself passed) which is what distinguishes this branch from the
      // destroyed-guest case above.
      registry.register(REGISTER_A);
      const throwingGuest: FakeGuest = {
        id: 11,
        destroyed: false,
        isDestroyed: () => false,
        getURL: () => {
          throw new Error('guest torn down mid-read');
        },
      };
      seedGuests(throwingGuest);

      const entry = registry.list().find((pane) => pane.sessionId === 'pane_aaaaaaaa');
      expect(entry?.alive).toBe(true);
      expect(entry?.url).toBe('http://localhost:4200');
    });
  });

  describe('listForProject', () => {
    it("returns the caller's panes and counts what it withheld", () => {
      registry.register(REGISTER_A); // proj-1
      registry.register(REGISTER_C); // proj-2
      registry.register({ ...REGISTER_B, projectId: null });
      seedGuests(fakeGuest(11), fakeGuest(22), fakeGuest(33));
      const result = registry.listForProject('proj-1');
      expect(result.panes.map((pane) => pane.sessionId)).toEqual(['pane_aaaaaaaa']);
      expect(result.otherProjectPaneCount).toBe(1);
      expect(result.unknownProjectPaneCount).toBe(1);
    });

    it('flows the live guest URL through the project-scoped view, not the cache', () => {
      // listForProject is built over list(); this pins that composition rather
      // than re-testing the live-URL fallback rules covered above.
      registry.register(REGISTER_A); // cached url http://localhost:4200
      seedGuests(fakeGuest(11, false, 'http://localhost:4200/settings?tab=git'));

      const result = registry.listForProject('proj-1');
      expect(result.panes[0]?.url).toBe('http://localhost:4200/settings?tab=git');
    });
  });

  /**
   * The completion signal behind `kangentic_browser_open_pane` / `_close_pane`.
   * Pane registration is renderer-driven and asynchronous, so main has nothing
   * else to await after it pushes.
   */
  describe('waitForLivePane / waitForPanesGone', () => {
    it('resolves as soon as a matching live pane registers', async () => {
      seedGuests(fakeGuest(11));
      const pending = registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 1000);
      registry.register(REGISTER_A);
      await expect(pending).resolves.toMatchObject({ sessionId: 'pane_aaaaaaaa' });
    });

    it('resolves immediately when the pane is already up', async () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11));
      await expect(
        registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 1000),
      ).resolves.toMatchObject({ sessionId: 'pane_aaaaaaaa' });
    });

    it('does NOT accept a registered pane whose guest is destroyed', async () => {
      // The load-bearing case. A stale entry is only evicted by resolveLiveGuest
      // on a drive call, so a presence-only wait would resolve here and hand the
      // agent a pane whose very next command fails `pane-destroyed` - exactly
      // the dead end open_pane exists to remove.
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11, true));
      await expect(
        registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 20),
      ).resolves.toBeNull();
    });

    it('does NOT accept a live LANE, and resolves once the visible pane registers', async () => {
      // The cold open path pushes a visible pane and waits for it; the hand-off
      // lane standing in for that pane is what the pane's arrival stands down.
      registry.register(HANDOFF_LANE);
      seedGuests(fakeGuest(44), fakeGuest(11));
      await expect(
        registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 20),
      ).resolves.toBeNull();
      const pending = registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 1000);
      registry.register(REGISTER_A);
      await expect(pending).resolves.toMatchObject({ sessionId: 'pane_aaaaaaaa' });
    });

    it('ignores a same-task pane belonging to another project', async () => {
      registry.register({ ...REGISTER_A, projectId: 'proj-2' });
      seedGuests(fakeGuest(11));
      await expect(
        registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 20),
      ).resolves.toBeNull();
    });

    it('resolves null on timeout when nothing registers', async () => {
      seedGuests();
      await expect(
        registry.waitForLivePane({ taskId: 'task-1', projectId: 'proj-1' }, 20),
      ).resolves.toBeNull();
    });

    it('reports the panes still registered when the close wait ends', async () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      seedGuests(fakeGuest(11), fakeGuest(22));
      const pending = registry.waitForPanesGone(['pane_aaaaaaaa', 'pane_bbbbbbbb'], 40);
      registry.unregister('pane_aaaaaaaa');
      // pane_bbbbbbbb never unregisters, so it must be reported rather than assumed closed.
      await expect(pending).resolves.toEqual(['pane_bbbbbbbb']);
    });

    it('resolves empty once every named pane unregisters', async () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11));
      const pending = registry.waitForPanesGone(['pane_aaaaaaaa'], 1000);
      registry.unregisterByWebContentsId(11, 'renderer-unmount');
      await expect(pending).resolves.toEqual([]);
    });

    it('wakes a waiter when the GUEST destroys itself, not just on a renderer unregister', async () => {
      // `unregisterByWebContentsId` is what the guest's own `destroyed` event
      // is wired to in src/main/index.ts - the backstop that keeps the registry
      // honest when a renderer cleanup never runs. If it stopped notifying,
      // close_pane would stall its full 3s and then report a pane that really
      // did close as `skipped`, which is exactly the misreporting the tool's
      // design forbids. The 1000ms budget only fails if no notification lands.
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11));
      const pending = registry.waitForPanesGone(['pane_aaaaaaaa'], 1000);
      registry.unregisterByWebContentsId(11);
      await expect(pending).resolves.toEqual([]);
    });

    it('wakes a waiter on detachAll, so shutdown never leaves one hanging', async () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11));
      const pending = registry.waitForPanesGone(['pane_aaaaaaaa'], 1000);
      registry.detachAll();
      await expect(pending).resolves.toEqual([]);
    });
  });

  /**
   * The whole point of the open/close tools: `no-pane-open` used to tell the
   * agent to click a UI pill it cannot reach, so its only move was to stop and
   * ask the user. The hint must keep naming a tool the agent can actually call.
   * The sibling copy in server-instructions.ts is pinned the same way.
   */
  describe('no-pane-open hint', () => {
    const hintCases: { name: string; run: () => { ok: boolean; detail?: string } }[] = [
      {
        name: 'an unknown handle from a task-bound caller',
        run: () => registry.resolveTarget({ sessionId: 'nope', projectId: 'proj-1', callerTaskId: 'task-1' }) as never,
      },
      {
        name: 'a task with no pane',
        run: () => registry.resolveTarget({ taskId: 'task-9', projectId: 'proj-1' }) as never,
      },
      {
        name: 'a task-bound caller whose task has no surface',
        run: () => registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-9' }) as never,
      },
      {
        name: 'no pane open in the project',
        run: () => registry.resolveTarget({ projectId: 'proj-1' }) as never,
      },
      {
        name: 'no pane open anywhere (unscoped)',
        run: () => registry.resolveTarget({ projectId: null }) as never,
      },
    ];

    for (const { name, run } of hintCases) {
      it(`points ${name} at kangentic_browser_open_pane, never the Browser pill`, () => {
        const result = run();
        expect(result.ok).toBe(false);
        expect(result.detail).toContain('kangentic_browser_open_pane');
        expect(result.detail).not.toContain('Browser pill');
      });
    }
  });

  describe('resolveLiveGuest', () => {
    it('returns the live guest when it resolves', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11));
      const entry = registry.get('pane_aaaaaaaa')!;
      const result = registry.resolveLiveGuest(entry);
      expect(result.ok).toBe(true);
    });

    it('evicts and reports pane-destroyed when the guest id no longer resolves', () => {
      registry.register(REGISTER_A);
      seedGuests(); // fromId returns undefined
      const entry = registry.get('pane_aaaaaaaa')!;
      const result = registry.resolveLiveGuest(entry);
      expect(result).toMatchObject({ ok: false, kind: 'pane-destroyed' });
      expect(registry.get('pane_aaaaaaaa')).toBeUndefined(); // self-healed
    });

    it('evicts and reports pane-destroyed when the guest is destroyed', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11, true));
      const result = registry.resolveLiveGuest(registry.get('pane_aaaaaaaa')!);
      expect(result).toMatchObject({ ok: false, kind: 'pane-destroyed' });
      expect(registry.size).toBe(0);
    });
  });

  it('detachAll detaches live guests and clears the map', () => {
    registry.register(REGISTER_A);
    registry.register(REGISTER_B);
    seedGuests(fakeGuest(11)); // only 11 still resolves
    registry.detachAll();
    expect(vi.mocked(detachDebugger)).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });
});
