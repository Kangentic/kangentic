/**
 * Which turn end answered an expired conversation's recap
 * (src/main/automations/turn-end/recap-turns.ts).
 *
 * A session that opened on the recap as its whole prompt is marked once it has
 * spawned. The turn that answers the recap runs no On agent turn end rows, but
 * only that turn: a prompted spawn seeds its turn's start at the spawn, so the
 * recap's turn began before the session first went idle. A Ctrl+C ends a turn
 * with no turn end, which leaves the mark behind, and the turn the user starts
 * after it begins with a prompt and must run its rows.
 *
 * The first idle alone does not end the recap's turn. An idle no Stop caused
 * (the stale-thinking watchdog) can land mid-turn, and the activity engine
 * re-stamps the turn's start when thinking resumes, so a start after the first
 * idle says nothing about which turn it is. Only a prompt the agent received
 * after that idle does.
 *
 * The module is main-process memory with no dependencies, so these tests drive
 * its six exports directly. The wiring into the turn-end runner and the
 * transition engine is pinned in turn-end-runner-recap-turn.test.ts and
 * transition-engine-expired-recap.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  markRecapSession,
  noteRecapSessionIdle,
  noteRecapSessionPrompt,
  isRecapTurn,
  forgetRecapSession,
  resetRecapSessionsForTests,
} from '../../src/main/automations/turn-end/recap-turns';

const SESSION_ID = 'recap-session-1';
const OTHER_SESSION_ID = 'unrelated-session-2';
/** When the recap session spawned: its opening turn began here. */
const SPAWNED_AT = 1_800_000_000_000;
const FIRST_IDLE_AT = SPAWNED_AT + 20_000;

describe('recap turns', () => {
  beforeEach(() => {
    resetRecapSessionsForTests();
  });

  describe('a session that was never marked', () => {
    it('is never a recap turn, whatever its turn start', () => {
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
      expect(isRecapTurn(SESSION_ID, 0)).toBe(false);
    });

    it('stays unmarked when it goes idle: noting an idle for it does not mark it', () => {
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
    });
  });

  describe('a marked session that has not gone idle yet', () => {
    it('is a recap turn for any turn that has a start', () => {
      markRecapSession(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(true);
      // Not read against a clock: with no idle recorded, the opening turn is the only one there can be.
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT + 3_600_000)).toBe(true);
    });

    it('is not a recap turn when the turn start is unknown (null)', () => {
      markRecapSession(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, null)).toBe(false);
    });

    it('ignores a prompt: the recap\'s own opening prompt is not a later turn\'s', () => {
      markRecapSession(SESSION_ID);

      noteRecapSessionPrompt(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(true);
    });

    it('does not carry a prompt noted before the first idle past that idle', () => {
      // The recap itself reaches the agent as a prompt, so a prompt event lands
      // before any idle. If it were latched, the first idle would read as "the
      // user already answered" and a re-stamped turn start after it would run the rows.
      markRecapSession(SESSION_ID);
      noteRecapSessionPrompt(SESSION_ID);

      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);

      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(true);
    });
  });

  describe('a marked session that has gone idle', () => {
    beforeEach(() => {
      markRecapSession(SESSION_ID);
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);
    });

    it('is a recap turn for the turn that began before the first idle (the recap\'s own)', () => {
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(true);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT - 1)).toBe(true);
    });

    it('is still the recap turn for a start re-stamped after the first idle when no prompt followed it', () => {
      // The stale-thinking watchdog went idle mid-turn and the engine re-stamped
      // the start when thinking resumed: a start after the idle, with no new turn behind it.
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(true);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 3_600_000)).toBe(true);
    });

    it('is still the recap turn for a start at the very moment of the first idle when no prompt followed it', () => {
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT)).toBe(true);
    });

    it('is not a recap turn when the turn start is unknown (null)', () => {
      expect(isRecapTurn(SESSION_ID, null)).toBe(false);
    });

    describe('and was then prompted', () => {
      beforeEach(() => {
        noteRecapSessionPrompt(SESSION_ID);
      });

      it('is not a recap turn for a turn that began after the first idle (the turn after an interrupted recap)', () => {
        expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);
        expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 3_600_000)).toBe(false);
      });

      it('is not a recap turn for a turn that began at the very moment of the first idle', () => {
        // Strictly before: a turn the user started as the session went idle is theirs.
        expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT)).toBe(false);
      });

      it('is still the recap turn for a start before the first idle, however late its turn end arrives', () => {
        expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(true);
        expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT - 1)).toBe(true);
      });

      it('is not a recap turn when the turn start is unknown (null)', () => {
        expect(isRecapTurn(SESSION_ID, null)).toBe(false);
      });

      it('keeps the FIRST idle: a later idle does not move the boundary', () => {
        // The recap's reply was the first idle. The user's turns after it go idle
        // again and again; the boundary must stay where the recap's turn ended, or
        // the second turn would read as a recap turn.
        noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT + 600_000);

        expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);
        expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 300_000)).toBe(false);
      });
    });
  });

  describe('sessions are independent', () => {
    it('marking one session marks no other', () => {
      markRecapSession(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(true);
      expect(isRecapTurn(OTHER_SESSION_ID, SPAWNED_AT)).toBe(false);
    });

    it('an idle noted for one session moves no other session\'s boundary', () => {
      markRecapSession(SESSION_ID);
      markRecapSession(OTHER_SESSION_ID);

      noteRecapSessionIdle(OTHER_SESSION_ID, FIRST_IDLE_AT);
      noteRecapSessionPrompt(OTHER_SESSION_ID);
      // A no-op for a session with no idle of its own, but it latches if the idle above leaked into this one.
      noteRecapSessionPrompt(SESSION_ID);

      // Still on its opening turn: no idle of its own yet.
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(true);
      expect(isRecapTurn(OTHER_SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);
    });

    it('a prompt noted for one session ends no other session\'s recap turn', () => {
      markRecapSession(SESSION_ID);
      markRecapSession(OTHER_SESSION_ID);
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);
      noteRecapSessionIdle(OTHER_SESSION_ID, FIRST_IDLE_AT);

      noteRecapSessionPrompt(OTHER_SESSION_ID);

      expect(isRecapTurn(OTHER_SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(true);
    });

    it('a prompt noted for a session that was never marked does not mark it', () => {
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);
      noteRecapSessionPrompt(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);
    });
  });

  describe('forgetting a session', () => {
    it('clears a marked session that had not gone idle', () => {
      markRecapSession(SESSION_ID);

      forgetRecapSession(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
    });

    it('clears a marked session that had gone idle, and a later idle does not bring it back', () => {
      markRecapSession(SESSION_ID);
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);

      forgetRecapSession(SESSION_ID);
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT + 1_000);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
    });

    it('clears a marked session that had been prompted, and a later prompt does not bring it back', () => {
      markRecapSession(SESSION_ID);
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);
      noteRecapSessionPrompt(SESSION_ID);

      forgetRecapSession(SESSION_ID);
      noteRecapSessionPrompt(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);
    });

    it('leaves other sessions marked', () => {
      markRecapSession(SESSION_ID);
      markRecapSession(OTHER_SESSION_ID);

      forgetRecapSession(SESSION_ID);

      expect(isRecapTurn(OTHER_SESSION_ID, SPAWNED_AT)).toBe(true);
    });

    it('does nothing for a session that was never marked', () => {
      expect(() => forgetRecapSession(SESSION_ID)).not.toThrow();
      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
    });
  });

  describe('resetRecapSessionsForTests', () => {
    it('forgets every session', () => {
      markRecapSession(SESSION_ID);
      markRecapSession(OTHER_SESSION_ID);

      resetRecapSessionsForTests();

      expect(isRecapTurn(SESSION_ID, SPAWNED_AT)).toBe(false);
      expect(isRecapTurn(OTHER_SESSION_ID, SPAWNED_AT)).toBe(false);
    });
  });
});
