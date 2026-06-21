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
        dialogSessionIds: [],
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('returns null when a session goes to thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: ACTIVITY_TAB,
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });
  });

  // ── A task-detail window is open ──
  describe('when a task-detail window is open', () => {
    it('returns null when a session goes idle and a window is open', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: ['C'],
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B'), makeSession('C')],
      })).toBeNull();
    });

    it('returns null when the viewed session goes thinking and a window is open', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: ['A'],
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('returns null when multiple windows are open', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: ['A', 'B'],
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });
  });

  // ── Idle events ──
  describe('when a session goes idle', () => {
    it('switches to the idle session when viewing a thinking session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('switches when no session is currently active (null)', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: null,
        dialogSessionIds: [],
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBe('A');
    });

    it('does NOT switch when already viewing an idle session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('stays on same session when it goes idle (already selected)', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('does NOT count exited sessions as idle for the "viewing idle" check', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A', 'exited'), makeSession('B')],
      })).toBe('B');
    });

    it('does NOT count suspended sessions as idle for the "viewing idle" check', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
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
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('stays on current tab when no other session is idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking', B: 'thinking' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('stays on current tab when sole session goes thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('does nothing when a non-viewed session goes to thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'idle', B: 'thinking' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('skips exited sessions when finding next idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking', B: 'idle', C: 'idle' },
        sessions: [makeSession('A'), makeSession('B', 'exited'), makeSession('C')],
      })).toBe('C');
    });

    it('skips queued sessions when finding next idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
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
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking', B: 'permission' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('does NOT switch when already viewing a permission session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'permission', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('switches to a permission session when the viewed session goes thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        dialogSessionIds: [],
        sessionActivity: { A: 'thinking', B: 'permission' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });
  });
});
