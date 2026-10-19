/**
 * The abandoned-turn store (src/main/automations/turn-end/abandoned-turns.ts), on its own, with no
 * runner: one kept turn end per session, the three counters it judges them by, and what forgets
 * them. The runner's reclaim (`turn-end-runner-abandoned-turn.test.ts`) drives the same functions
 * through the session manager's events; this file pins each rule where it lives, so a regression
 * points at the store and not at a pass that happened to depend on it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { TurnEndedPayload } from '../../src/main/pty/session-manager';
import {
  forgetAbandonedTurnSession,
  forgetAbandonedTurnsForTask,
  hasAbandonedTurn,
  noteAbandonedTurn,
  noteTurnEnded,
  noteUserWork,
  resetAbandonedTurnsForTests,
  takeAbandonedTurn,
  turnEndMark,
  userWorkMark,
  type AbandonedTurn,
} from '../../src/main/automations/turn-end/abandoned-turns';

/**
 * An abandoned turn end for a session. Its turn-end mark defaults to the session's mark now, which
 * is what the runner records when a pass gives up and no later turn end has arrived.
 */
function abandonedTurn(input: {
  sessionId: string;
  taskId?: string;
  columnId?: string;
  userWorkMarkAtTurnEnd?: number;
  turnEndMarkAtTurnEnd?: number;
}): AbandonedTurn {
  const payload: TurnEndedPayload = {
    sessionId: input.sessionId,
    taskId: input.taskId ?? `task-of-${input.sessionId}`,
    projectId: 'project-1',
    agentSessionId: 'agent-session-1',
    isolatedSwimlaneId: null,
    turnStartedAt: 1_000,
    workSerial: 7,
    transcriptAnchor: null,
  };
  return {
    payload,
    columnId: input.columnId ?? 'lane-review',
    userWorkMarkAtTurnEnd: input.userWorkMarkAtTurnEnd ?? 0,
    turnEndMarkAtTurnEnd: input.turnEndMarkAtTurnEnd ?? turnEndMark(input.sessionId),
  };
}

describe('abandoned turn ends', () => {
  beforeEach(() => {
    resetAbandonedTurnsForTests();
  });

  describe('noteAbandonedTurn', () => {
    it('keeps one entry per session, and the newest wins', () => {
      const first = abandonedTurn({ sessionId: 'session-a', columnId: 'lane-first' });
      const second = abandonedTurn({ sessionId: 'session-a', columnId: 'lane-second' });

      noteAbandonedTurn(first);
      noteAbandonedTurn(second);

      expect(takeAbandonedTurn('session-a')).toBe(second);
      // The first was replaced, not queued behind the second.
      expect(hasAbandonedTurn('session-a')).toBe(false);
    });

    it('keeps a separate entry for each session', () => {
      const forSessionA = abandonedTurn({ sessionId: 'session-a' });
      const forSessionB = abandonedTurn({ sessionId: 'session-b' });

      noteAbandonedTurn(forSessionA);
      noteAbandonedTurn(forSessionB);

      expect(takeAbandonedTurn('session-a')).toBe(forSessionA);
      expect(takeAbandonedTurn('session-b')).toBe(forSessionB);
    });

    it('refuses an entry when a turn end of the session\'s own arrived since it ended', () => {
      const endedBeforeTheTurnEnd = abandonedTurn({ sessionId: 'session-a', turnEndMarkAtTurnEnd: turnEndMark('session-a') });
      noteTurnEnded('session-a');

      noteAbandonedTurn(endedBeforeTheTurnEnd);

      expect(hasAbandonedTurn('session-a')).toBe(false);

      // The same call keeps an entry stamped with the mark the session has now.
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-a', turnEndMarkAtTurnEnd: turnEndMark('session-a') }));
      expect(hasAbandonedTurn('session-a')).toBe(true);
    });

    it('leaves the entry it holds alone when it refuses a stale one', () => {
      noteTurnEnded('session-a');
      const held = abandonedTurn({ sessionId: 'session-a', turnEndMarkAtTurnEnd: 1 });
      noteAbandonedTurn(held);

      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-a', turnEndMarkAtTurnEnd: 0 }));

      expect(takeAbandonedTurn('session-a')).toBe(held);
    });
  });

  describe('noteTurnEnded', () => {
    it('forgets the session\'s entry, since the newer turn\'s own pass judges instead', () => {
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-a' }));
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-b' }));

      noteTurnEnded('session-a');

      expect(hasAbandonedTurn('session-a')).toBe(false);
      expect(hasAbandonedTurn('session-b')).toBe(true);
    });

    it('counts a turn end per session', () => {
      expect(turnEndMark('session-a')).toBe(0);

      noteTurnEnded('session-a');
      expect(turnEndMark('session-a')).toBe(1);

      noteTurnEnded('session-a');
      expect(turnEndMark('session-a')).toBe(2);
      expect(turnEndMark('session-b')).toBe(0);
    });
  });

  describe('takeAbandonedTurn', () => {
    it('returns the entry once and removes it, so a second idle judges nothing', () => {
      const entry = abandonedTurn({ sessionId: 'session-a' });
      noteAbandonedTurn(entry);

      expect(takeAbandonedTurn('session-a')).toBe(entry);
      expect(hasAbandonedTurn('session-a')).toBe(false);
      expect(takeAbandonedTurn('session-a')).toBeNull();
    });

    it('returns null for a session with no entry', () => {
      expect(takeAbandonedTurn('session-unknown')).toBeNull();
    });
  });

  describe('forgetAbandonedTurnsForTask', () => {
    it('drops only that task\'s entries', () => {
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-a', taskId: 'task-1' }));
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-b', taskId: 'task-1' }));
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-c', taskId: 'task-2' }));

      forgetAbandonedTurnsForTask('task-1');

      expect(hasAbandonedTurn('session-a')).toBe(false);
      expect(hasAbandonedTurn('session-b')).toBe(false);
      expect(hasAbandonedTurn('session-c')).toBe(true);
    });
  });

  describe('forgetAbandonedTurnSession', () => {
    it('clears the entry and both counters of a session that left the registry, and no other session\'s', () => {
      noteUserWork('session-a');
      noteUserWork('session-a');
      noteTurnEnded('session-a');
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-a' }));
      noteUserWork('session-b');
      noteTurnEnded('session-b');
      noteTurnEnded('session-b');
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-b' }));
      expect(userWorkMark('session-a')).toBe(2);
      expect(turnEndMark('session-a')).toBe(1);

      forgetAbandonedTurnSession('session-a');

      expect(hasAbandonedTurn('session-a')).toBe(false);
      expect(userWorkMark('session-a')).toBe(0);
      expect(turnEndMark('session-a')).toBe(0);
      // The other session keeps its entry and its counts.
      expect(hasAbandonedTurn('session-b')).toBe(true);
      expect(userWorkMark('session-b')).toBe(1);
      expect(turnEndMark('session-b')).toBe(2);
    });
  });

  describe('noteUserWork', () => {
    it('counts a prompt, interrupt or failed turn per session', () => {
      expect(userWorkMark('session-a')).toBe(0);

      noteUserWork('session-a');
      noteUserWork('session-a');
      noteUserWork('session-b');

      expect(userWorkMark('session-a')).toBe(2);
      expect(userWorkMark('session-b')).toBe(1);
      expect(userWorkMark('session-unknown')).toBe(0);
    });

    it('does not move the turn-end count or forget an entry', () => {
      noteAbandonedTurn(abandonedTurn({ sessionId: 'session-a' }));

      noteUserWork('session-a');

      expect(turnEndMark('session-a')).toBe(0);
      expect(hasAbandonedTurn('session-a')).toBe(true);
    });
  });
});
