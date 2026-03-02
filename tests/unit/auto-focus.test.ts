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
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('returns null when a session goes to thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: ACTIVITY_TAB,
        sessionActivity: { A: 'thinking' },
        sessions: [makeSession('A')],
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
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('switches when no session is currently active (null)', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: null,
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBe('A');
    });

    it('does NOT switch when already viewing an idle session', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('stays on same session when it goes idle (already selected)', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'idle',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'idle' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('does NOT count exited sessions as idle for the "viewing idle" check', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'idle', B: 'idle' },
        sessions: [makeSession('A', 'exited'), makeSession('B')],
      })).toBe('B');
    });

    it('does NOT count suspended sessions as idle for the "viewing idle" check', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'idle',
        currentActiveSessionId: 'A',
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
        sessionActivity: { A: 'thinking', B: 'idle' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBe('B');
    });

    it('stays on current tab when no other session is idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'thinking', B: 'thinking' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('stays on current tab when sole session goes thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'thinking' },
        sessions: [makeSession('A')],
      })).toBeNull();
    });

    it('does nothing when a non-viewed session goes to thinking', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'B',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'idle', B: 'thinking' },
        sessions: [makeSession('A'), makeSession('B')],
      })).toBeNull();
    });

    it('skips exited sessions when finding next idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'thinking', B: 'idle', C: 'idle' },
        sessions: [makeSession('A'), makeSession('B', 'exited'), makeSession('C')],
      })).toBe('C');
    });

    it('skips queued sessions when finding next idle', () => {
      expect(resolveAutoFocusTarget({
        sessionId: 'A',
        newState: 'thinking',
        currentActiveSessionId: 'A',
        sessionActivity: { A: 'thinking', B: 'idle', C: 'idle' },
        sessions: [makeSession('A'), makeSession('B', 'queued'), makeSession('C')],
      })).toBe('C');
    });
  });
});
