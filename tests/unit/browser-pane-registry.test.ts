/**
 * Unit tests for BrowserPaneRegistry in
 * src/main/browser/browser-pane-registry.ts.
 *
 * The registry maps open Browser panes to their guest webContents so the
 * kangentic_browser_* MCP tools can target them. The load-bearing behaviors:
 * target resolution (sessionId / taskId / single-default / ambiguous),
 * self-healing eviction of a destroyed guest, and synchronous detach-all on
 * shutdown.
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

import { webContents } from 'electron';
import { detachDebugger, isDebuggerAttached } from '../../src/main/browser/cdp/cdp';
import { BrowserPaneRegistry } from '../../src/main/browser/browser-pane-registry';

interface FakeGuest {
  id: number;
  destroyed: boolean;
  isDestroyed(): boolean;
}

function fakeGuest(id: number, destroyed = false): FakeGuest {
  return { id, destroyed, isDestroyed: () => destroyed };
}

/** Wire `webContents.fromId` to resolve a set of fake guests by id. */
function seedGuests(...guests: FakeGuest[]): void {
  const byId = new Map(guests.map((guest) => [guest.id, guest]));
  vi.mocked(webContents.fromId).mockImplementation((id: number) => byId.get(id) as never);
}

const REGISTER_A = { sessionId: 'sess-a', taskId: 'task-1', projectId: 'proj-1', webContentsId: 11, url: 'http://localhost:4200' };
const REGISTER_B = { sessionId: 'sess-b', taskId: 'task-2', projectId: 'proj-1', webContentsId: 22, url: null };
/** A pane in a DIFFERENT project, for the cross-project isolation cases. */
const REGISTER_C = { sessionId: 'sess-c', taskId: 'task-3', projectId: 'proj-2', webContentsId: 33, url: 'http://127.0.0.1:8099/admin' };

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
    expect(registry.get('sess-a')?.taskId).toBe('task-1');
    expect(registry.get('sess-a')?.url).toBe('http://localhost:4200');
  });

  it('unregisters by sessionId and by webContentsId', () => {
    registry.register(REGISTER_A);
    registry.register(REGISTER_B);
    registry.unregister('sess-a');
    expect(registry.get('sess-a')).toBeUndefined();
    registry.unregisterByWebContentsId(22);
    expect(registry.get('sess-b')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  describe('unregisterIfMatches', () => {
    it('is a no-op when the current entry was re-registered with a different webContentsId (race guard)', () => {
      // Pop-out re-registers sess-a with a new guest (webContentsId 22) BEFORE the
      // in-app pane's own unmount cleanup (still carrying its stale webContentsId 11)
      // runs. The stale cleanup must not clobber the newer registration.
      registry.register(REGISTER_A); // webContentsId 11
      registry.register({ ...REGISTER_A, webContentsId: 22 }); // pop-out re-registers the same session
      registry.unregisterIfMatches('sess-a', 11); // stale unmount cleanup, out of order
      expect(registry.get('sess-a')).toBeDefined();
      expect(registry.get('sess-a')?.webContentsId).toBe(22);
    });

    it('deletes the entry when the webContentsId still matches the current registration', () => {
      registry.register(REGISTER_A);
      registry.register({ ...REGISTER_A, webContentsId: 22 });
      registry.unregisterIfMatches('sess-a', 22);
      expect(registry.get('sess-a')).toBeUndefined();
    });

    it('is a harmless no-op for an unknown sessionId', () => {
      expect(() => registry.unregisterIfMatches('unknown', 5)).not.toThrow();
      expect(registry.size).toBe(0);
    });
  });

  it('updates url by sessionId and by webContentsId', () => {
    registry.register(REGISTER_B);
    registry.updateUrl('sess-b', 'http://localhost:5173');
    expect(registry.get('sess-b')?.url).toBe('http://localhost:5173');
    registry.updateUrlByWebContentsId(22, 'http://localhost:8080');
    expect(registry.get('sess-b')?.url).toBe('http://localhost:8080');
  });

  it('getByTaskId filters by task and optional project', () => {
    registry.register(REGISTER_A);
    registry.register({ ...REGISTER_B, taskId: 'task-1', projectId: 'proj-2' });
    expect(registry.getByTaskId('task-1')).toHaveLength(2);
    expect(registry.getByTaskId('task-1', 'proj-1')).toHaveLength(1);
    expect(registry.getByTaskId('task-1', 'proj-1')[0].sessionId).toBe('sess-a');
  });

  it('list() enriches with alive + debuggerAttached', () => {
    registry.register(REGISTER_A);
    registry.register(REGISTER_B);
    seedGuests(fakeGuest(11), fakeGuest(22, true)); // 11 alive, 22 destroyed
    vi.mocked(isDebuggerAttached).mockImplementation((guest) => (guest as FakeGuest).id === 11);
    const list = registry.list();
    const a = list.find((entry) => entry.sessionId === 'sess-a');
    const b = list.find((entry) => entry.sessionId === 'sess-b');
    expect(a?.alive).toBe(true);
    expect(a?.debuggerAttached).toBe(true);
    expect(b?.alive).toBe(false);
    expect(b?.debuggerAttached).toBe(false);
  });

  // `projectId: null` is the deliberate UNSCOPED path, reserved for
  // main-process internal callers. Every case in this block passes it
  // explicitly so it reads as a choice rather than an omission; the scoped
  // behavior an MCP caller actually gets is covered in the block below.
  describe('resolveTarget (unscoped, projectId: null)', () => {
    it('resolves by sessionId', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ sessionId: 'sess-a', projectId: null });
      expect(result.ok).toBe(true);
      expect(result.ok && result.entry.taskId).toBe('task-1');
    });

    it('errors no-pane-open for an unknown sessionId', () => {
      const result = registry.resolveTarget({ sessionId: 'nope', projectId: null });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
    });

    it('resolves by taskId when exactly one matches', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ taskId: 'task-1', projectId: null });
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
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
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
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
    it('refuses a sessionId belonging to another project', () => {
      registry.register(REGISTER_C); // proj-2
      const result = registry.resolveTarget({ sessionId: 'sess-c', projectId: 'proj-1' });
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

    it('resolves an in-scope sessionId (no false refusal)', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ sessionId: 'sess-a', projectId: 'proj-1' });
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
    });

    it('ignores another project when defaulting, instead of erroring ambiguous', () => {
      registry.register(REGISTER_A); // proj-1
      registry.register(REGISTER_C); // proj-2
      const result = registry.resolveTarget({ projectId: 'proj-1' });
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
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
      expect(result.ok && result.entry.sessionId).toBe('sess-b');
    });

    it("prefers the caller's own session with no task lookup available", () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerSessionId: 'sess-b' });
      expect(result.ok && result.entry.sessionId).toBe('sess-b');
    });

    it('falls through when the caller preference matches nothing', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-nobody-has' });
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
    });

    it('a preference miss does not widen into a wrong pick when ambiguous', () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      const result = registry.resolveTarget({ projectId: 'proj-1', callerTaskId: 'task-nobody-has' });
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
      expect(result.ok === false && result.candidates).toHaveLength(2);
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
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
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
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
    });
  });

  describe('listForProject', () => {
    it("returns the caller's panes and counts what it withheld", () => {
      registry.register(REGISTER_A); // proj-1
      registry.register(REGISTER_C); // proj-2
      registry.register({ ...REGISTER_B, projectId: null });
      seedGuests(fakeGuest(11), fakeGuest(22), fakeGuest(33));
      const result = registry.listForProject('proj-1');
      expect(result.panes.map((pane) => pane.sessionId)).toEqual(['sess-a']);
      expect(result.otherProjectPaneCount).toBe(1);
      expect(result.unknownProjectPaneCount).toBe(1);
    });
  });

  describe('resolveLiveGuest', () => {
    it('returns the live guest when it resolves', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11));
      const entry = registry.get('sess-a')!;
      const result = registry.resolveLiveGuest(entry);
      expect(result.ok).toBe(true);
    });

    it('evicts and reports pane-destroyed when the guest id no longer resolves', () => {
      registry.register(REGISTER_A);
      seedGuests(); // fromId returns undefined
      const entry = registry.get('sess-a')!;
      const result = registry.resolveLiveGuest(entry);
      expect(result).toMatchObject({ ok: false, kind: 'pane-destroyed' });
      expect(registry.get('sess-a')).toBeUndefined(); // self-healed
    });

    it('evicts and reports pane-destroyed when the guest is destroyed', () => {
      registry.register(REGISTER_A);
      seedGuests(fakeGuest(11, true));
      const result = registry.resolveLiveGuest(registry.get('sess-a')!);
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
