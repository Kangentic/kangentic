/**
 * Unit tests for src/main/browser/browser-pane-reason.ts: the one-line reason an
 * agent gave in `kangentic_browser_open_pane`, kept per owner. The pane shows it
 * as "Agent is <reason>" only while the agent drives, through `agentInputReason`,
 * which the agent-input push sender in src/main/index.ts calls. The real pane
 * registry resolves the guest to its owner here; electron and the CDP helpers
 * are mocked so the suite is pure Node.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import {
  agentInputReason,
  clearAllBrowserPaneReasons,
  clearBrowserPaneReason,
  clearBrowserPaneReasonsForSession,
  getBrowserPaneReason,
  setBrowserPaneReason,
} from '../../src/main/browser/browser-pane-reason';

const OWNER = 'task-1';
const GUEST_ID = 11;
const PANE_HANDLE = 'pane_aaaaaaaa';

describe('browser pane reason', () => {
  beforeEach(() => {
    clearAllBrowserPaneReasons();
    browserPaneRegistry.register({
      handle: PANE_HANDLE,
      ownerSessionId: 'sess-a',
      taskId: OWNER,
      projectId: 'proj-1',
      webContentsId: GUEST_ID,
      url: null,
    });
  });

  afterEach(() => {
    browserPaneRegistry.unregister(PANE_HANDLE);
  });

  describe('agentInputReason', () => {
    it('returns the owner reason on the active edge', () => {
      setBrowserPaneReason(OWNER, { purpose: 'own-work', reason: 'checking the layout', sessionId: 'sess-a' });
      expect(agentInputReason(GUEST_ID, true)).toBe('checking the layout');
    });

    it('returns null on the active edge when the owner gave no reason', () => {
      expect(agentInputReason(GUEST_ID, true)).toBeNull();
    });

    it('returns null on the end edge even with a stored reason', () => {
      setBrowserPaneReason(OWNER, { purpose: 'own-work', reason: 'checking the layout', sessionId: 'sess-a' });
      expect(agentInputReason(GUEST_ID, false)).toBeNull();
    });

    it('returns null for a guest no surface registered', () => {
      setBrowserPaneReason(OWNER, { purpose: 'own-work', reason: 'checking the layout', sessionId: 'sess-a' });
      expect(agentInputReason(999, true)).toBeNull();
    });
  });

  it('setBrowserPaneReason collapses whitespace and newlines to one trimmed line', () => {
    setBrowserPaneReason(OWNER, { purpose: 'for-user', reason: '  measuring\n canvas   heights ', sessionId: null });
    expect(getBrowserPaneReason(OWNER)?.reason).toBe('measuring canvas heights');
  });

  it('clearBrowserPaneReasonsForSession clears only the reasons that session gave', () => {
    setBrowserPaneReason('task-a', { purpose: 'own-work', reason: 'one', sessionId: 'sess-a' });
    setBrowserPaneReason('task-b', { purpose: 'own-work', reason: 'two', sessionId: 'sess-b' });
    setBrowserPaneReason('task-c', { purpose: 'for-user', reason: 'three', sessionId: null });

    clearBrowserPaneReasonsForSession('sess-a');

    expect(getBrowserPaneReason('task-a')).toBeNull();
    expect(getBrowserPaneReason('task-b')?.reason).toBe('two');
    expect(getBrowserPaneReason('task-c')?.reason).toBe('three');
  });

  it('clearBrowserPaneReason forgets one owner and leaves the rest', () => {
    setBrowserPaneReason('task-a', { purpose: 'own-work', reason: 'one', sessionId: 'sess-a' });
    setBrowserPaneReason('task-b', { purpose: 'own-work', reason: 'two', sessionId: 'sess-a' });
    clearBrowserPaneReason('task-a');
    expect(getBrowserPaneReason('task-a')).toBeNull();
    expect(getBrowserPaneReason('task-b')?.reason).toBe('two');
  });
});
