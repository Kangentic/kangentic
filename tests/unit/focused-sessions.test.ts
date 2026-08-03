/**
 * Unit tests for the pure focused-session derivation helpers extracted from
 * useFocusedSessionsSync. Covers the full decision matrix:
 *
 *   deriveFocusedSessionIds:
 *     - window sessions and the panel session are focused TOGETHER (the panel
 *       sheds only the detached tabs, so both surfaces hold live terminals)
 *     - board view + panel visible + panel session
 *     - board view + panel hidden
 *     - board view + panel visible + no panel session
 *     - backlog view + no dialog
 *     - commandBar visible adds transient to the set
 *     - commandBar + transient already in set (no duplicate)
 *     - ACTIVITY_TAB sentinel path (via derivePanelSessionId)
 *
 *   derivePanelSessionId:
 *     - ACTIVITY_TAB returns null
 *     - activeSessionId points at a running non-transient session
 *     - activeSessionId not in running set - falls back to idle session
 *     - no idle session - falls back to first running session
 *     - no running sessions - returns null
 *     - transient sessions are excluded from candidate pool
 *     - detached sessions (owned by a detail window) are excluded too, both as
 *       the active id and as a fallback candidate
 */
import { describe, it, expect } from 'vitest';
import {
  deriveFocusedSessionIds,
  derivePanelSessionId,
  type DeriveFocusedSessionIdsInput,
  type DerivePanelSessionIdInput,
} from '../../src/renderer/utils/focused-sessions';
import { ACTIVITY_TAB } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-default',
    taskId: 'task-default',
    projectId: 'proj-default',
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    ...overrides,
  };
}

function makeFocusedInput(
  overrides: Partial<DeriveFocusedSessionIdsInput> = {},
): DeriveFocusedSessionIdsInput {
  return {
    activeView: 'board',
    terminalPanelVisible: true,
    panelSessionId: null,
    dialogSessionIds: [],
    commandBarVisible: false,
    transientSessionIds: [],
    ...overrides,
  };
}

function makePanelInput(
  overrides: Partial<DerivePanelSessionIdInput> = {},
): DerivePanelSessionIdInput {
  return {
    activeSessionId: null,
    sessions: [],
    currentProjectId: 'proj-default',
    sessionActivity: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveFocusedSessionIds
// ---------------------------------------------------------------------------

describe('deriveFocusedSessionIds', () => {
  it('returns empty array when nothing is focused', () => {
    const result = deriveFocusedSessionIds(makeFocusedInput());
    expect(result).toEqual([]);
  });

  it('focuses the window session AND the panel session together', () => {
    // The panel sheds only the tabs whose detail is open, so it keeps a live
    // terminal for another session while a window drives this one. Both have a
    // mounted xterm, so both must be focused. This used to be an else-branch,
    // which would now leave the panel's own terminal silent.
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionIds: ['sess-dialog'],
        panelSessionId: 'sess-panel',
        activeView: 'board',
        terminalPanelVisible: true,
      }),
    );
    expect(result).toEqual(['sess-dialog', 'sess-panel']);
  });

  it('does not duplicate a panel session a window already owns', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionIds: ['sess-shared'],
        panelSessionId: 'sess-shared',
      }),
    );
    expect(result).toEqual(['sess-shared']);
  });

  it('still excludes the panel session on the backlog view while a window is open', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'backlog',
        dialogSessionIds: ['sess-dialog'],
        panelSessionId: 'sess-panel',
      }),
    );
    expect(result).toEqual(['sess-dialog']);
  });

  it('focuses every window-owned session when multiple detail windows are open', () => {
    // Multi-window: each open window owns a session, and ALL must be in the
    // focused set or the main process suppresses that window's PTY output. The
    // panel's own session joins them, since the panel keeps whatever tabs the
    // windows did not take.
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionIds: ['sess-a', 'sess-b'],
        panelSessionId: 'sess-panel',
      }),
    );
    expect(result).toEqual(['sess-a', 'sess-b', 'sess-panel']);
  });

  it('returns panel session on board view with panel visible', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'board',
        terminalPanelVisible: true,
        panelSessionId: 'sess-panel',
        dialogSessionIds: [],
      }),
    );
    expect(result).toEqual(['sess-panel']);
  });

  it('returns empty array on board view when panel is hidden', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'board',
        terminalPanelVisible: false,
        panelSessionId: 'sess-panel',
        dialogSessionIds: [],
      }),
    );
    expect(result).toEqual([]);
  });

  it('returns empty array on board view when panelSessionId is null', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'board',
        terminalPanelVisible: true,
        panelSessionId: null,
        dialogSessionIds: [],
      }),
    );
    expect(result).toEqual([]);
  });

  it('returns empty array on backlog view with no dialog', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'backlog',
        panelSessionId: 'sess-panel',
        dialogSessionIds: [],
        commandBarVisible: false,
      }),
    );
    expect(result).toEqual([]);
  });

  it('appends transient session when command bar is visible on backlog view', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'backlog',
        panelSessionId: 'sess-panel',
        dialogSessionIds: [],
        commandBarVisible: true,
        transientSessionIds: ['sess-transient'],
      }),
    );
    // Panel session excluded (backlog), transient appended
    expect(result).toEqual(['sess-transient']);
  });

  it('appends transient session alongside panel session on board view', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'board',
        terminalPanelVisible: true,
        panelSessionId: 'sess-panel',
        dialogSessionIds: [],
        commandBarVisible: true,
        transientSessionIds: ['sess-transient'],
      }),
    );
    expect(result).toEqual(['sess-panel', 'sess-transient']);
  });

  it('appends EVERY transient session when multiple command terminals are open', () => {
    // Phase 2: each Command Terminal window owns its own transient session, and
    // all must be focused or the main process suppresses their PTY output.
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'board',
        terminalPanelVisible: true,
        panelSessionId: 'sess-panel',
        dialogSessionIds: [],
        commandBarVisible: true,
        transientSessionIds: ['sess-transient-1', 'sess-transient-2', 'sess-transient-3'],
      }),
    );
    expect(result).toEqual(['sess-panel', 'sess-transient-1', 'sess-transient-2', 'sess-transient-3']);
  });

  it('does not duplicate a transient session when it is already in the focused set', () => {
    // Contrived scenario: a window-owned session id collides with a transient id.
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionIds: ['sess-shared'],
        commandBarVisible: true,
        transientSessionIds: ['sess-shared'],
      }),
    );
    expect(result).toEqual(['sess-shared']);
    expect(result.length).toBe(1);
  });

  it('does not add transient sessions when commandBar is visible but none exist', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        commandBarVisible: true,
        transientSessionIds: [],
      }),
    );
    expect(result).toEqual([]);
  });

  it('does not add transient sessions when commandBar is hidden even if some exist', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        commandBarVisible: false,
        transientSessionIds: ['sess-transient-1', 'sess-transient-2'],
      }),
    );
    expect(result).toEqual([]);
  });

  it('filters parked sessions out of the dialog set (rule 1)', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionIds: ['sess-a', 'sess-b', 'sess-c'],
        parkedSessionIds: new Set(['sess-b']),
      }),
    );
    expect(result).toEqual(['sess-a', 'sess-c']);
  });

  it('filters parked sessions out of the transient set (rule 4)', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        commandBarVisible: true,
        transientSessionIds: ['sess-t1', 'sess-t2'],
        parkedSessionIds: new Set(['sess-t1']),
      }),
    );
    expect(result).toEqual(['sess-t2']);
  });

  it('derives an empty set when every window session is parked (main emits everything; parked queues ack-and-drop)', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'backlog',
        dialogSessionIds: ['sess-a', 'sess-b'],
        parkedSessionIds: new Set(['sess-a', 'sess-b']),
      }),
    );
    expect(result).toEqual([]);
  });

  it('behaves as before when parkedSessionIds is omitted', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionIds: ['sess-a'],
        commandBarVisible: true,
        transientSessionIds: ['sess-t1'],
      }),
    );
    expect(result).toEqual(['sess-a', 'sess-t1']);
  });
});

// ---------------------------------------------------------------------------
// derivePanelSessionId
// ---------------------------------------------------------------------------

describe('derivePanelSessionId', () => {
  it('returns null when activeSessionId is the ACTIVITY_TAB sentinel', () => {
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: ACTIVITY_TAB,
        sessions: [makeSession({ id: 'sess-1' })],
      }),
    );
    expect(result).toBeNull();
  });

  it('returns activeSessionId when it points at a running non-transient session', () => {
    const session = makeSession({
      id: 'sess-active',
      status: 'running',
      projectId: 'proj-default',
      transient: false,
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-active',
        sessions: [session],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBe('sess-active');
  });

  it('returns null when there are no running sessions for the project', () => {
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: null,
        sessions: [],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBeNull();
  });

  it('prefers an idle running session over a non-idle one when activeSessionId is stale', () => {
    const idleSession = makeSession({
      id: 'sess-idle',
      status: 'running',
      projectId: 'proj-default',
    });
    const thinkingSession = makeSession({
      id: 'sess-thinking',
      status: 'running',
      projectId: 'proj-default',
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-stale',
        sessions: [thinkingSession, idleSession],
        currentProjectId: 'proj-default',
        sessionActivity: {
          'sess-thinking': 'thinking',
          'sess-idle': 'idle',
        },
      }),
    );
    expect(result).toBe('sess-idle');
  });

  it('prefers a permission-blocked session (awaiting user) over a thinking one when activeSessionId is stale', () => {
    // permission, like idle, requires user interaction, so it is a focus target.
    const permissionSession = makeSession({
      id: 'sess-permission',
      status: 'running',
      projectId: 'proj-default',
    });
    const thinkingSession = makeSession({
      id: 'sess-thinking',
      status: 'running',
      projectId: 'proj-default',
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-stale',
        sessions: [thinkingSession, permissionSession],
        currentProjectId: 'proj-default',
        sessionActivity: {
          'sess-thinking': 'thinking',
          'sess-permission': 'permission',
        },
      }),
    );
    expect(result).toBe('sess-permission');
  });

  it('falls back to first running session when no idle session exists', () => {
    const sessionA = makeSession({
      id: 'sess-a',
      status: 'running',
      projectId: 'proj-default',
    });
    const sessionB = makeSession({
      id: 'sess-b',
      status: 'running',
      projectId: 'proj-default',
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-stale',
        sessions: [sessionA, sessionB],
        currentProjectId: 'proj-default',
        sessionActivity: {
          'sess-a': 'thinking',
          'sess-b': 'thinking',
        },
      }),
    );
    expect(result).toBe('sess-a');
  });

  it('excludes transient sessions from the candidate pool', () => {
    const transientSession = makeSession({
      id: 'sess-transient',
      status: 'running',
      projectId: 'proj-default',
      transient: true,
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: null,
        sessions: [transientSession],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBeNull();
  });

  it('excludes sessions from other projects', () => {
    const otherProjectSession = makeSession({
      id: 'sess-other',
      status: 'running',
      projectId: 'proj-other',
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: null,
        sessions: [otherProjectSession],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBeNull();
  });

  it('excludes non-running sessions (suspended, exited) from the candidate pool', () => {
    const suspendedSession = makeSession({
      id: 'sess-suspended',
      status: 'suspended',
      projectId: 'proj-default',
    });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: null,
        sessions: [suspendedSession],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBeNull();
  });

  // ── detached sessions (a task-detail window hosts the terminal) ──

  it('falls through to another tab when the ACTIVE session is detached to a window', () => {
    // The panel has no tab for a detached session, so it renders the fallback -
    // and this must name the same one, or main streams bytes to the terminal that
    // is gone and starves the one now on screen.
    const detached = makeSession({ id: 'sess-detached', projectId: 'proj-default' });
    const remaining = makeSession({ id: 'sess-remaining', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-detached',
        sessions: [detached, remaining],
        currentProjectId: 'proj-default',
        ownedSessionIds: new Set(['sess-detached']),
      }),
    );
    expect(result).toBe('sess-remaining');
  });

  it('never falls back TO a detached session', () => {
    const detached = makeSession({ id: 'sess-detached', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-stale',
        sessions: [detached],
        currentProjectId: 'proj-default',
        ownedSessionIds: new Set(['sess-detached']),
      }),
    );
    expect(result).toBeNull();
  });

  it('does not prefer a detached idle session over a visible thinking one', () => {
    const detachedIdle = makeSession({ id: 'sess-detached', projectId: 'proj-default' });
    const visibleThinking = makeSession({ id: 'sess-visible', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-stale',
        sessions: [visibleThinking, detachedIdle],
        currentProjectId: 'proj-default',
        sessionActivity: { 'sess-visible': 'thinking', 'sess-detached': 'idle' },
        ownedSessionIds: new Set(['sess-detached']),
      }),
    );
    expect(result).toBe('sess-visible');
  });

  // ── a collapsed panel mounts no xterm ──

  it('returns null when the panel is collapsed, so nothing is focused with no xterm to ack', () => {
    // Measured live: a collapsed panel still had its session focused, so main streamed
    // bytes that nothing acknowledged (~6KB stranded in-flight). At
    // BACKPRESSURE_HIGH_WATER (1MiB) that pauses the PTY and the agent stalls.
    const session = makeSession({ id: 'sess-a', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-a',
        sessions: [session],
        currentProjectId: 'proj-default',
        panelShowsTerminal: false,
      }),
    );
    expect(result).toBeNull();
  });

  it('resolves normally once the panel is expanded again', () => {
    const session = makeSession({ id: 'sess-a', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-a',
        sessions: [session],
        currentProjectId: 'proj-default',
        panelShowsTerminal: true,
      }),
    );
    expect(result).toBe('sess-a');
  });

  it('treats an omitted panelShowsTerminal as mounted, so other callers are unaffected', () => {
    // TerminalPanel resolves its ACTIVE TAB through this same function and must keep
    // working while collapsed - the tab strip is still on screen.
    const session = makeSession({ id: 'sess-a', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-a',
        sessions: [session],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBe('sess-a');
  });

  it('behaves as before when ownedSessionIds is omitted', () => {
    const session = makeSession({ id: 'sess-a', projectId: 'proj-default' });
    const result = derivePanelSessionId(
      makePanelInput({
        activeSessionId: 'sess-a',
        sessions: [session],
        currentProjectId: 'proj-default',
      }),
    );
    expect(result).toBe('sess-a');
  });
});

