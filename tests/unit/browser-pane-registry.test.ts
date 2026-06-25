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

  describe('resolveTarget', () => {
    it('resolves by sessionId', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ sessionId: 'sess-a' });
      expect(result.ok).toBe(true);
      expect(result.ok && result.entry.taskId).toBe('task-1');
    });

    it('errors no-pane-open for an unknown sessionId', () => {
      const result = registry.resolveTarget({ sessionId: 'nope' });
      expect(result).toMatchObject({ ok: false, kind: 'no-pane-open' });
    });

    it('resolves by taskId when exactly one matches', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({ taskId: 'task-1' });
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
    });

    it('errors multiple-panes when a taskId matches more than one pane', () => {
      registry.register(REGISTER_A);
      registry.register({ ...REGISTER_B, taskId: 'task-1' });
      const result = registry.resolveTarget({ taskId: 'task-1' });
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
      expect(result.ok === false && result.candidates).toHaveLength(2);
    });

    it('defaults to the single open pane when no selector is given', () => {
      registry.register(REGISTER_A);
      const result = registry.resolveTarget({});
      expect(result.ok && result.entry.sessionId).toBe('sess-a');
    });

    it('errors multiple-panes with no selector when more than one is open', () => {
      registry.register(REGISTER_A);
      registry.register(REGISTER_B);
      const result = registry.resolveTarget({});
      expect(result).toMatchObject({ ok: false, kind: 'multiple-panes' });
    });

    it('errors no-pane-open with no selector when none are open', () => {
      expect(registry.resolveTarget({})).toMatchObject({ ok: false, kind: 'no-pane-open' });
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
