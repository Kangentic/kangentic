/**
 * Unit tests for the pure focused-session derivation helpers extracted from
 * useFocusedSessionsSync. Covers the full decision matrix:
 *
 *   deriveFocusedSessionIds:
 *     - dialog open (dialog takes priority, panel session excluded)
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
    dialogSessionId: null,
    commandBarVisible: false,
    transientSessionId: null,
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

  it('returns dialog session only when dialog is open', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionId: 'sess-dialog',
        panelSessionId: 'sess-panel',
        activeView: 'board',
        terminalPanelVisible: true,
      }),
    );
    expect(result).toEqual(['sess-dialog']);
  });

  it('excludes panel session when dialog is open (dialog takes priority)', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionId: 'sess-dialog',
        panelSessionId: 'sess-panel',
      }),
    );
    expect(result).not.toContain('sess-panel');
  });

  it('returns panel session on board view with panel visible', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'board',
        terminalPanelVisible: true,
        panelSessionId: 'sess-panel',
        dialogSessionId: null,
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
        dialogSessionId: null,
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
        dialogSessionId: null,
      }),
    );
    expect(result).toEqual([]);
  });

  it('returns empty array on backlog view with no dialog', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        activeView: 'backlog',
        panelSessionId: 'sess-panel',
        dialogSessionId: null,
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
        dialogSessionId: null,
        commandBarVisible: true,
        transientSessionId: 'sess-transient',
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
        dialogSessionId: null,
        commandBarVisible: true,
        transientSessionId: 'sess-transient',
      }),
    );
    expect(result).toEqual(['sess-panel', 'sess-transient']);
  });

  it('does not duplicate transient session when it is already in the focused set', () => {
    // Contrived scenario: dialogSessionId === transientSessionId
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        dialogSessionId: 'sess-shared',
        commandBarVisible: true,
        transientSessionId: 'sess-shared',
      }),
    );
    expect(result).toEqual(['sess-shared']);
    expect(result.length).toBe(1);
  });

  it('does not add transient when commandBar is visible but transientSessionId is null', () => {
    const result = deriveFocusedSessionIds(
      makeFocusedInput({
        commandBarVisible: true,
        transientSessionId: null,
      }),
    );
    expect(result).toEqual([]);
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
});
