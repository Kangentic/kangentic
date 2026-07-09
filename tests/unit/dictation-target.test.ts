/**
 * Unit tests for `resolveFocusedCommandSessionId` in dictation-target.ts.
 *
 * Covers the fix for "Command Terminal voice dictation doesn't work": priority 1
 * of `resolveDictationTarget()` used to read `focusedWindow.sessionId` from the
 * command window-manager store, which is always null for Command Terminal
 * windows (their live PTY id is never written back to the window store). The
 * fix resolves the focused command window's session by its durable slot anchor
 * through the transientSessions map instead, gated on the command layer
 * actually being visible (hiding the layer keeps the window and its
 * focusedWindowId alive, so an unguarded resolve would let a hidden terminal
 * steal dictation from a visible board window).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resolveFocusedCommandSessionId, resolveDictationTarget } from '../../src/renderer/utils/dictation-target';
import { boardWindowManager, commandWindowManager } from '../../src/renderer/window-manager';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { transientKey, type TransientSessionEntry } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { Project, Session } from '../../src/shared/types';

function makeEntry(overrides: Partial<TransientSessionEntry> = {}): TransientSessionEntry {
  return {
    projectId: 'proj-1',
    slot: 'slot-1',
    sessionId: 'sess-transient-1',
    branch: 'main',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-default',
    taskId: 'task-default',
    projectId: 'proj-default',
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: 'C:\\Users\\dev\\project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    agentSessionId: null,
    ...overrides,
  };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: 'Test Project',
    path: 'C:\\Users\\dev\\project',
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Blank the four real stores `resolveDictationTarget()` reads from directly
 * (the command window-manager store, the board window-manager store, the
 * session store, and the project store), so each integration test below
 * starts from a clean slate and neither leaks into the other nor into the
 * pure-function tests above (which never touch these stores, so they are
 * unaffected either way).
 */
function resetIntegrationStores(): void {
  commandWindowManager.store.setState({
    windows: {},
    order: [],
    focusedWindowId: null,
    zCounter: 0,
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
  });
  boardWindowManager.store.setState({
    windows: {},
    order: [],
    focusedWindowId: null,
    zCounter: 0,
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
  });
  useSessionStore.setState({
    sessions: [],
    commandBarVisible: false,
    transientSessions: {},
    activeSessionId: null,
  });
  useProjectStore.setState({ currentProject: null });
}

describe('resolveFocusedCommandSessionId', () => {
  it('resolves the focused command window session when the layer is visible', () => {
    const entry = makeEntry();
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: true,
      focusedCommandAnchor: 'slot-1',
      currentProjectId: 'proj-1',
      transientSessions: { 'proj-1::slot-1': entry },
    });
    expect(result).toBe('sess-transient-1');
  });

  it('returns null when the command layer is hidden, even with a focused window', () => {
    // Regression guard: hiding the layer keeps the window and focusedWindowId
    // alive in the store, so an unguarded resolve would let a hidden terminal
    // steal dictation from a visible board window.
    const entry = makeEntry();
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: false,
      focusedCommandAnchor: 'slot-1',
      currentProjectId: 'proj-1',
      transientSessions: { 'proj-1::slot-1': entry },
    });
    expect(result).toBeNull();
  });

  it('returns null when no command window is focused', () => {
    const entry = makeEntry();
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: true,
      focusedCommandAnchor: null,
      currentProjectId: 'proj-1',
      transientSessions: { 'proj-1::slot-1': entry },
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no current project', () => {
    const entry = makeEntry();
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: true,
      focusedCommandAnchor: 'slot-1',
      currentProjectId: null,
      transientSessions: { 'proj-1::slot-1': entry },
    });
    expect(result).toBeNull();
  });

  it('returns null when the anchor is keyed under a different project', () => {
    const entry = makeEntry({ projectId: 'proj-2' });
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: true,
      focusedCommandAnchor: 'slot-1',
      currentProjectId: 'proj-1',
      transientSessions: { 'proj-2::slot-1': entry },
    });
    expect(result).toBeNull();
  });

  it('returns null when no transient entry exists yet for the slot (mid-spawn)', () => {
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: true,
      focusedCommandAnchor: 'slot-1',
      currentProjectId: 'proj-1',
      transientSessions: {},
    });
    expect(result).toBeNull();
  });

  it('resolves the correct slot when multiple Command Terminal windows are open', () => {
    const result = resolveFocusedCommandSessionId({
      commandBarVisible: true,
      focusedCommandAnchor: 'slot-2',
      currentProjectId: 'proj-1',
      transientSessions: {
        'proj-1::slot-1': makeEntry({ slot: 'slot-1', sessionId: 'sess-a' }),
        'proj-1::slot-2': makeEntry({ slot: 'slot-2', sessionId: 'sess-b' }),
      },
    });
    expect(result).toBe('sess-b');
  });
});

/**
 * Integration coverage for `resolveDictationTarget()`'s priority-1 leg
 * (the private `focusedCommandSessionId()` wrapper), exercised against the
 * REAL Zustand stores rather than a hand-built input object. This is the part
 * `resolveFocusedCommandSessionId`'s unit tests above cannot reach: the
 * wrapper's own store reads (`commandWindowManager.store.getState().windows[
 * focusedWindowId].anchor`, `useSessionStore.getState().commandBarVisible` /
 * `.transientSessions`, `useProjectStore.getState().currentProject?.id`) and
 * the fact that `resolveDictationTarget()` actually calls this wrapper FIRST
 * in its priority chain.
 *
 * Red condition (the bug this guards): revert priority 1 in
 * `resolveDictationTarget()` back to `focusedWindowSessionId(commandWindowManager)`
 * (reading `focusedWindow.sessionId`, which command windows never populate) and
 * the "visible" test below fails because `resolveDictationTarget()` returns
 * null instead of the seeded command session id.
 */
describe('resolveDictationTarget - Command Terminal priority (real stores)', () => {
  beforeEach(resetIntegrationStores);
  afterAll(resetIntegrationStores);

  it('resolves the focused command-terminal window session when the command layer is visible', () => {
    const projectId = 'proj-cmd-1';
    const commandSessionId = 'sess-cmd-1';

    useProjectStore.setState({ currentProject: makeProject(projectId) });

    const windowId = commandWindowManager.store.getState().openWindow({
      anchor: 'slot-1',
      sessionId: null,
      title: 'Command Terminal',
    });
    // openWindow focuses the window it just created, matching production:
    // opening a Command Terminal window makes it the focused one.
    expect(commandWindowManager.store.getState().focusedWindowId).toBe(windowId);

    useSessionStore.setState({
      commandBarVisible: true,
      transientSessions: {
        [transientKey(projectId, 'slot-1')]: {
          projectId,
          slot: 'slot-1',
          sessionId: commandSessionId,
          branch: 'main',
        },
      },
      sessions: [
        makeSession({ id: commandSessionId, projectId, transient: true, status: 'running' }),
      ],
    });

    expect(resolveDictationTarget()).toBe(commandSessionId);
  });

  it('does not let a hidden command layer win priority 1, even with a focused window and a running session', () => {
    const projectId = 'proj-cmd-2';
    const commandSessionId = 'sess-cmd-2';

    useProjectStore.setState({ currentProject: makeProject(projectId) });

    commandWindowManager.store.getState().openWindow({
      anchor: 'slot-1',
      sessionId: null,
      title: 'Command Terminal',
    });

    useSessionStore.setState({
      // Layer hidden: priority 1 must not win, even though the window is
      // focused and the transient session is running.
      commandBarVisible: false,
      transientSessions: {
        [transientKey(projectId, 'slot-1')]: {
          projectId,
          slot: 'slot-1',
          sessionId: commandSessionId,
          branch: 'main',
        },
      },
      sessions: [
        makeSession({ id: commandSessionId, projectId, transient: true, status: 'running' }),
      ],
    });

    const result = resolveDictationTarget();
    expect(result).not.toBe(commandSessionId);
    // No other priority has a candidate in this seeded state (no board window
    // focused, no last-focused terminal, and the only running session is
    // transient so it is excluded from the bottom-panel derivation), so the
    // chain falls all the way through to null.
    expect(result).toBeNull();
  });

  it('falls through to the focused board (task-detail) window when the command layer does not resolve', () => {
    // Priority 2's positive path was entirely untested: every prior case here
    // either had no board window open, or had the command layer win. This
    // proves the board leg still resolves correctly on its own so the "both
    // resolve" test below is meaningfully checking priority ORDER, not just
    // that priority 2 happens to work.
    const projectId = 'proj-board-1';
    const boardSessionId = 'sess-board-1';

    useProjectStore.setState({ currentProject: makeProject(projectId) });

    boardWindowManager.store.getState().openWindow({
      anchor: 'task-1',
      sessionId: boardSessionId,
      title: 'Task One',
    });

    // Command layer hidden: priority 1 must not resolve, so the chain falls
    // through to priority 2.
    useSessionStore.setState({
      commandBarVisible: false,
      sessions: [makeSession({ id: boardSessionId, projectId, taskId: 'task-1', status: 'running' })],
    });

    expect(resolveDictationTarget()).toBe(boardSessionId);
  });

  it('lets a focused Command Terminal window win priority 1 over a focused board window with a running session', () => {
    // This is the exact regression scenario from the bug report: a task-detail
    // window was focused (so priority 2 fully resolves), but the visible,
    // focused Command Terminal is the one dictation should target. Before the
    // fix, priority 1 read `focusedWindow.sessionId` off the command manager,
    // which command windows never populate, so this case silently fell
    // through to the board window instead of the terminal the user was
    // actually dictating into.
    const projectId = 'proj-both-1';
    const commandSessionId = 'sess-cmd-both-1';
    const boardSessionId = 'sess-board-both-1';

    useProjectStore.setState({ currentProject: makeProject(projectId) });

    // Board window is open and focused with a resolvable, running session -
    // priority 2 alone would happily resolve to it.
    boardWindowManager.store.getState().openWindow({
      anchor: 'task-1',
      sessionId: boardSessionId,
      title: 'Task One',
    });

    // Each window layer tracks its own `focusedWindowId` independently, so
    // opening the Command Terminal window afterward does not touch the board
    // manager's focus - both managers report a focused window at once, which
    // is the real shape of "task-detail window focused, Command Terminal also
    // focused" that this scenario needs.
    commandWindowManager.store.getState().openWindow({
      anchor: 'slot-1',
      sessionId: null,
      title: 'Command Terminal',
    });

    useSessionStore.setState({
      commandBarVisible: true,
      transientSessions: {
        [transientKey(projectId, 'slot-1')]: {
          projectId,
          slot: 'slot-1',
          sessionId: commandSessionId,
          branch: 'main',
        },
      },
      sessions: [
        makeSession({ id: commandSessionId, projectId, transient: true, status: 'running' }),
        makeSession({ id: boardSessionId, projectId, taskId: 'task-1', status: 'running' }),
      ],
    });

    expect(resolveDictationTarget()).toBe(commandSessionId);
  });
});
