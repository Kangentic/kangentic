/**
 * `openTaskConversation(taskId, projectId, target?)`: the one function every
 * conversation entry point calls (the header pill, the kebab item, the completed
 * task view's tab bar and Route card, the archived card's menu).
 *
 * It decides WHICH session id to raise on the session store's open signal, and
 * what tab to ask for. Behaviors pinned here:
 *
 *   - Which session: an open conversation window anchored on ANY of the task's
 *     sessions is reused (so a Route pill switches that window's tab instead of
 *     opening a second window for the same conversation). Several candidates:
 *     the one on the live session wins, then the one raised last (highest
 *     zIndex). With none open: the live session, then the newest listed one.
 *   - No history at all: a toast, and the signal is left exactly as it was.
 *   - A listing that fails is not fatal while a live session exists.
 *   - A `target` asks for that tab and takes NO terminal capture (a column opens
 *     at its own position); with no target the tab request is null, which a
 *     window that is already open reads as "keep the tab you are on", and the
 *     live terminal's viewport is captured so the viewer can open where the
 *     user was looking.
 *
 * The real session, window and toast stores run; only `window.electronAPI`
 * (the transcript listing) and the config store (the toast store reads its
 * duration and cap) are stubbed. Windows are seeded as `kind: 'conversation'`
 * with explicit zIndex values, because the board store's default kind is
 * `task-detail` and a task-detail window is never reused.
 *
 * Red-green: drop the `candidate.kind === 'conversation'` filter and the
 * task-detail case fails; swap the live preference for the zIndex rule alone
 * and the live-wins case fails; flip the zIndex comparison and the raised-last
 * case fails; drop the `target ? null :` guard and the target case fails (it
 * registers a capture reader so the guard has something to take); pass the
 * store's old tab instead of `null` and the no-target case fails; drop the
 * catch and the rejected-listing cases fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConversationSessionMeta, ConversationTabRequest, Session } from '../../src/shared/types';
import type { ManagedWindow } from '../../src/renderer/window-manager/store/types';

const electronStub = vi.hoisted(() => {
  const listSessions = vi.fn();
  (globalThis as Record<string, unknown>).window = { electronAPI: { transcripts: { listSessions } } };
  return { listSessions };
});

// The toast store reads the configured duration and cap when it adds a toast.
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({
      loadConfig: vi.fn(),
      config: { notifications: { toasts: { durationSeconds: 4, maxCount: 5 } } },
    }),
  },
}));

import { openTaskConversation } from '../../src/renderer/components/dialogs/task-detail/open-task-conversation';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';
import { useToastStore } from '../../src/renderer/stores/toast-store';
import { useWindowStore } from '../../src/renderer/window-manager/store/window-store';
import {
  registerTerminalCapture,
  unregisterTerminalCapture,
} from '../../src/renderer/utils/terminal-capture-registry';

const TASK_ID = 'task-open-conversation';
const PROJECT_ID = 'project-open-conversation';
const LIVE_SESSION_ID = 'session-live';
const NEWEST_SESSION_ID = 'session-newest';
const OLDER_SESSION_ID = 'session-older';
const OLDEST_SESSION_ID = 'session-oldest';
const FOREIGN_SESSION_ID = 'session-of-another-task';

const SENTINEL_SESSION_ID = 'session-sentinel';
const SENTINEL_TAB: ConversationTabRequest = { swimlaneId: 'swimlane-sentinel' };
const SENTINEL_REQUEST_ID = 7;

const REVIEW_TARGET: ConversationTabRequest = {
  swimlaneId: 'swimlane-review',
  visitStartedAt: '2026-10-20T18:11:00.000Z',
};

function makeLiveSession(): Session {
  return {
    id: LIVE_SESSION_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    pid: 4242,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-10-20T17:00:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
  };
}

function makeMeta(sessionId: string, startedAt: string): ConversationSessionMeta {
  return { sessionId, agentName: 'claude', startedAt, exitedAt: null, isolatedSwimlaneId: null, status: 'exited' };
}

/** Listed sessions, deliberately out of order so neither the first nor the last element is the newest. */
const LISTED_SESSIONS: ConversationSessionMeta[] = [
  makeMeta(OLDER_SESSION_ID, '2026-10-05T10:00:00.000Z'),
  makeMeta(NEWEST_SESSION_ID, '2026-10-15T10:00:00.000Z'),
  makeMeta(OLDEST_SESSION_ID, '2026-10-01T10:00:00.000Z'),
];

function seedLiveSession(): void {
  const sessions = [makeLiveSession()];
  useSessionStore.setState({ sessions, _sessionByTaskId: buildSessionByTaskId(sessions) });
}

/** Seed windows directly so each one's zIndex is exactly what the case needs. */
function seedWindows(windows: Array<{ anchor: string; zIndex: number; kind?: ManagedWindow['kind'] }>): void {
  const seeded: Record<string, ManagedWindow> = {};
  windows.forEach((spec, index) => {
    const id = `window-${index + 1}`;
    seeded[id] = {
      id,
      kind: spec.kind ?? 'conversation',
      anchor: spec.anchor,
      sessionId: spec.anchor,
      geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      state: 'floating',
      zIndex: spec.zIndex,
      leafId: null,
      sessionStatus: 'live',
      restoreGeometry: null,
      title: 'Conversation',
    };
  });
  useWindowStore.setState({ windows: seeded, order: Object.keys(seeded), focusedWindowId: null });
}

function signal() {
  const state = useSessionStore.getState();
  return {
    conversationSessionId: state.conversationSessionId,
    conversationTab: state.conversationTab,
    conversationRequestId: state.conversationRequestId,
  };
}

beforeEach(() => {
  electronStub.listSessions.mockReset();
  electronStub.listSessions.mockResolvedValue([]);
  useSessionStore.setState({
    sessions: [],
    _sessionByTaskId: new Map(),
    conversationSessionId: SENTINEL_SESSION_ID,
    conversationTab: SENTINEL_TAB,
    conversationRequestId: SENTINEL_REQUEST_ID,
    pendingTuiAnchor: null,
  });
  useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null, zCounter: 0, tileTree: null });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  // The capture registry is module-scoped and outlives a test.
  unregisterTerminalCapture(LIVE_SESSION_ID);
});

describe('openTaskConversation: nothing to open', () => {
  it('toasts and leaves the signal untouched when there is no live session and no listed session', async () => {
    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(electronStub.listSessions).toHaveBeenCalledWith(TASK_ID, PROJECT_ID);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('No conversation history for this task yet');
    expect(toasts[0].variant).toBe('info');
    expect(signal()).toEqual({
      conversationSessionId: SENTINEL_SESSION_ID,
      conversationTab: SENTINEL_TAB,
      conversationRequestId: SENTINEL_REQUEST_ID,
    });
  });

  it('toasts the same way when the listing fails and there is no live session either', async () => {
    electronStub.listSessions.mockRejectedValue(new Error('ipc closed'));

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(signal().conversationSessionId).toBe(SENTINEL_SESSION_ID);
    expect(signal().conversationRequestId).toBe(SENTINEL_REQUEST_ID);
  });
});

describe('openTaskConversation: which session', () => {
  it('opens on the live session when the listing fails', async () => {
    seedLiveSession();
    electronStub.listSessions.mockRejectedValue(new Error('ipc closed'));

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(LIVE_SESSION_ID);
    expect(signal().conversationRequestId).toBe(SENTINEL_REQUEST_ID + 1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('prefers the live session over the newest listed one when nothing is open', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(LIVE_SESSION_ID);
  });

  it('falls back to the newest listed session by start time when there is no live session', async () => {
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(NEWEST_SESSION_ID);
    expect(signal().conversationRequestId).toBe(SENTINEL_REQUEST_ID + 1);
  });
});

describe('openTaskConversation: reusing an open conversation window', () => {
  it('reuses a window anchored on an older listed session, not the live or the newest id', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    seedWindows([{ anchor: OLDER_SESSION_ID, zIndex: 1 }]);

    await openTaskConversation(TASK_ID, PROJECT_ID, REVIEW_TARGET);

    expect(signal().conversationSessionId).toBe(OLDER_SESSION_ID);
    expect(signal().conversationSessionId).not.toBe(LIVE_SESSION_ID);
    expect(signal().conversationSessionId).not.toBe(NEWEST_SESSION_ID);
  });

  it('ignores a conversation window anchored on a session of another task', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    seedWindows([{ anchor: FOREIGN_SESSION_ID, zIndex: 9 }]);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(LIVE_SESSION_ID);
  });

  it('ignores a window of another kind even when its anchor is one of the task\'s sessions', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    seedWindows([{ anchor: OLDER_SESSION_ID, zIndex: 9, kind: 'task-detail' }]);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(LIVE_SESSION_ID);
  });

  it('prefers the window on the live session over a window raised later on another session', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    // The live-anchored window has the LOWER zIndex, so the zIndex rule alone would pick the other.
    seedWindows([
      { anchor: OLDER_SESSION_ID, zIndex: 9 },
      { anchor: LIVE_SESSION_ID, zIndex: 2 },
    ]);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(LIVE_SESSION_ID);
  });

  it('with none on the live session, takes the window raised last', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    // The highest zIndex is in the MIDDLE of the insertion order, so neither the
    // first nor the last match can pass for the right reason.
    seedWindows([
      { anchor: OLDEST_SESSION_ID, zIndex: 5 },
      { anchor: OLDER_SESSION_ID, zIndex: 9 },
      { anchor: NEWEST_SESSION_ID, zIndex: 2 },
    ]);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(OLDER_SESSION_ID);
  });

  it('reuses an open window even when the listing fails, if it is on the live session', async () => {
    seedLiveSession();
    electronStub.listSessions.mockRejectedValue(new Error('ipc closed'));
    seedWindows([{ anchor: LIVE_SESSION_ID, zIndex: 1 }]);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(signal().conversationSessionId).toBe(LIVE_SESSION_ID);
  });
});

describe('openTaskConversation: the tab and the terminal capture', () => {
  const capturedViewport = { visibleLines: ['> fix the failing test', 'Working on it'], atBottom: true };

  it('asks for the target tab and takes no terminal capture when a target is given', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    // A reader IS registered, so only the target guard keeps the capture from running.
    const reader = vi.fn(() => capturedViewport);
    registerTerminalCapture(LIVE_SESSION_ID, reader);

    await openTaskConversation(TASK_ID, PROJECT_ID, REVIEW_TARGET);

    expect(signal().conversationTab).toEqual(REVIEW_TARGET);
    expect(useSessionStore.getState().pendingTuiAnchor).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('asks for a column with no stay the same way', async () => {
    seedLiveSession();
    const columnOnly: ConversationTabRequest = { swimlaneId: 'swimlane-executing' };

    await openTaskConversation(TASK_ID, PROJECT_ID, columnOnly);

    expect(signal().conversationTab).toEqual(columnOnly);
    expect('visitStartedAt' in (signal().conversationTab as ConversationTabRequest)).toBe(false);
  });

  it('asks for no tab when no target is given, whatever tab the store still held', async () => {
    seedLiveSession();
    expect(useSessionStore.getState().conversationTab).toEqual(SENTINEL_TAB);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    // Null means "keep the tab you are on" to a window that is already open.
    expect(signal().conversationTab).toBeNull();
  });

  it('captures the live terminal viewport for the session it opens when no target is given', async () => {
    seedLiveSession();
    registerTerminalCapture(LIVE_SESSION_ID, () => capturedViewport);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(useSessionStore.getState().pendingTuiAnchor).toEqual({
      sessionId: LIVE_SESSION_ID,
      visibleLines: capturedViewport.visibleLines,
      atBottom: capturedViewport.atBottom,
    });
  });

  it('anchors the capture to the reused window\'s session, not the live one', async () => {
    seedLiveSession();
    electronStub.listSessions.mockResolvedValue(LISTED_SESSIONS);
    seedWindows([{ anchor: OLDER_SESSION_ID, zIndex: 1 }]);
    registerTerminalCapture(LIVE_SESSION_ID, () => capturedViewport);

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(useSessionStore.getState().pendingTuiAnchor?.sessionId).toBe(OLDER_SESSION_ID);
  });

  it('sets no anchor when the task has no terminal to capture', async () => {
    seedLiveSession();

    await openTaskConversation(TASK_ID, PROJECT_ID);

    expect(useSessionStore.getState().pendingTuiAnchor).toBeNull();
  });
});
