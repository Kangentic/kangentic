import { describe, it, expect } from 'vitest';
import { resolveAutoFocusTarget } from '../../src/renderer/utils/auto-focus';
import { ACTIVITY_TAB } from '../../src/shared/types';
import type { SessionStatus, ActivityState } from '../../src/shared/types';

function makeSession(id: string, status: SessionStatus = 'running') {
  return { id, status };
}

describe('resolveAutoFocusTarget', () => {

  // ── Activity tab is sacred ──
  describe('when user is on the Activity tab', () => {
    it('returns null when a session goes idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: ACTIVITY_TAB,
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('returns null when a session goes to thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: ACTIVITY_TAB,
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });
  });

  // ── Sessions detached to a task-detail window ──
  describe('when a session is detached to a task-detail window', () => {
    it('never switches TO a detached session - the panel has no tab for it', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(['B']),
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('still switches among the tabs a window did NOT take', () => {
      // The panel keeps its remaining tabs now instead of stepping aside entirely,
      // so an unrelated open window must not disable auto-focus for them.
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(['C']),
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B'), makeSession('C')],
      })).toBe('B');
    });

    it('switches away when the viewed session goes thinking, skipping detached candidates', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(['B']),
        sessionActivity: { A: 'thinking', B: 'idle', C: 'idle' },
        sessions: [makeSession('A'), makeSession('B'), makeSession('C')],
      })).toBe('C');
    });

    it('does not treat a DETACHED paused session as "already viewing a paused one"', () => {
      // The stored active id can still name a detached session (the panel deliberately
      // keeps it pointed there so the tab returns selected), but the user is not
      // looking at it, so an idle session elsewhere should still pull focus.
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(['A']),
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });
  });

  // ── Idle events ──
  describe('when a session goes idle', () => {
    it('switches to the idle session when viewing a thinking session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('switches when no session is currently active (null)', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: null,
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBe('A');
    });

    it('does NOT switch when already viewing an idle session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('stays on same session when it goes idle (already selected)', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('does NOT count exited sessions as idle for the "viewing idle" check', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A', 'exited'), makeSession('B')],
      })).toBe('B');
    });

    it('does NOT count suspended sessions as idle for the "viewing idle" check', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A', 'suspended'), makeSession('B')],
      })).toBe('B');
    });
  });

  // ── Thinking events ──
  describe('when a session goes to thinking', () => {
    it('switches to another idle session when the viewed session goes thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('stays on current tab when no other session is idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'thinking' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('stays on current tab when sole session goes thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('does nothing when a non-viewed session goes to thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'idle', B: 'thinking' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('skips exited sessions when finding next idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'idle', C: 'idle' },
        sessions: [makeSession('A'), makeSession('B', 'exited'), makeSession('C')],
      })).toBe('C');
    });

    it('skips queued sessions when finding next idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'idle', C: 'idle' },
        sessions: [makeSession('A'), makeSession('B', 'queued'), makeSession('C')],
      })).toBe('C');
    });
  });

  // ── Permission is treated like idle (requires user interaction) ──
  describe('when a session needs permission', () => {
    it('switches to the permission session when viewing a thinking session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'permission',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'permission' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('does NOT switch when already viewing a permission session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'permission', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('switches to a permission session when the viewed session goes thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        ownedSessionIds: new Set(),
        sessionActivity: { A: 'thinking', B: 'permission' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });
  });
});
