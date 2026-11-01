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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markRecapSession,
  noteRecapSessionIdle,
  noteRecapSessionPrompt,
  isRecapTurn,
  isExpiredRecapSession,
  recapKindOf,
  whenRecapTurnEnds,
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

  // Task #952: the main conversation resumed after an isolated column's
  // session, with its recap as the whole prompt ahead of a slash command. Its
  // first turn end is the recap's, whatever its start, and the command waits
  // on it. Nothing is withheld.
  describe('a return recap', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is the session\'s first turn end, with or without a turn start, and withholds nothing', () => {
      markRecapSession(SESSION_ID, 'return');
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);
      noteRecapSessionPrompt(SESSION_ID);

      expect(isRecapTurn(SESSION_ID, null)).toBe(true);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(true);
      expect(recapKindOf(SESSION_ID)).toBe('return');
      // Held messages do not wait for a next start, as they do after an expired recap.
      expect(isExpiredRecapSession(SESSION_ID)).toBe(false);
      markRecapSession(OTHER_SESSION_ID);
      expect(isExpiredRecapSession(OTHER_SESSION_ID)).toBe(true);
      expect(recapKindOf(OTHER_SESSION_ID)).toBe('expired');
    });

    it('tells its waiters when the recap turn ends, and when the session leaves first', async () => {
      markRecapSession(SESSION_ID, 'return');
      markRecapSession(OTHER_SESSION_ID, 'return');
      const ended = whenRecapTurnEnds(SESSION_ID, 60_000);
      const gone = whenRecapTurnEnds(OTHER_SESSION_ID, 60_000);

      forgetRecapSession(SESSION_ID, true);
      forgetRecapSession(OTHER_SESSION_ID, false);

      await expect(ended).resolves.toBe(true);
      await expect(gone).resolves.toBe(false);
      expect(recapKindOf(SESSION_ID)).toBeNull();
    });

    it('answers at once for a session with no mark', async () => {
      await expect(whenRecapTurnEnds(SESSION_ID, 60_000)).resolves.toBe(true);
    });

    it('gives up after its wait and drops the mark, so a recap the user interrupted holds nothing for good', async () => {
      vi.useFakeTimers();
      markRecapSession(SESSION_ID, 'return');
      const waited = whenRecapTurnEnds(SESSION_ID, 60_000);

      vi.advanceTimersByTime(60_000);

      await expect(waited).resolves.toBe(true);
      expect(isRecapTurn(SESSION_ID, null)).toBe(false);
    });
  });

  // A session can be marked again (a respawn that opens on a recap while the
  // earlier mark is still in the registry). The earlier mark's waiters must be
  // told, not left hanging on an entry nobody can reach, and its timeout must
  // not forget the newer mark.
  describe('marking a session that already has a mark', () => {
    afterEach(() => {
      // The spy on clearTimeout lives on the fake clock: restore it first.
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    /** Records how a wait settled, so a wait that never settles reads as `pending` instead of hanging the test. */
    function trackWait(wait: Promise<boolean>): { outcome: () => boolean | 'pending' } {
      let outcome: boolean | 'pending' = 'pending';
      void wait.then((proceed) => { outcome = proceed; });
      return { outcome: () => outcome };
    }

    /** Let promise reactions queued by a resolve run. */
    async function flushPromiseReactions(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    }

    it('settles the earlier mark\'s waiters with proceed true, since the session is still there', async () => {
      vi.useFakeTimers();
      markRecapSession(SESSION_ID, 'return');
      const earlierWait = trackWait(whenRecapTurnEnds(SESSION_ID, 60_000));
      expect(earlierWait.outcome()).toBe('pending');

      markRecapSession(SESSION_ID, 'return');
      await flushPromiseReactions();

      expect(earlierWait.outcome()).toBe(true);
    });

    it('replaces the mark with a fresh one: its kind, its first idle and its prompt start over', () => {
      markRecapSession(SESSION_ID, 'expired');
      noteRecapSessionIdle(SESSION_ID, FIRST_IDLE_AT);
      noteRecapSessionPrompt(SESSION_ID);
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(false);

      markRecapSession(SESSION_ID, 'return');

      expect(recapKindOf(SESSION_ID)).toBe('return');
      expect(isExpiredRecapSession(SESSION_ID)).toBe(false);

      markRecapSession(SESSION_ID, 'expired');

      // Back on its opening turn: the earlier idle and prompt are gone.
      expect(isRecapTurn(SESSION_ID, FIRST_IDLE_AT + 1)).toBe(true);
    });

    it('clears the earlier mark\'s bound, so no timer is left to fire for it', () => {
      vi.useFakeTimers();
      markRecapSession(SESSION_ID, 'return');
      void whenRecapTurnEnds(SESSION_ID, 60_000);
      expect(vi.getTimerCount()).toBe(1);

      markRecapSession(SESSION_ID, 'return');

      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the newer mark and its waiter when the earlier mark\'s bound runs out', async () => {
      vi.useFakeTimers();
      markRecapSession(SESSION_ID, 'return');
      const earlierWait = trackWait(whenRecapTurnEnds(SESSION_ID, 60_000));
      markRecapSession(SESSION_ID, 'return');
      const newerWait = trackWait(whenRecapTurnEnds(SESSION_ID, 120_000));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(earlierWait.outcome()).toBe(true);
      expect(newerWait.outcome()).toBe('pending');
      expect(recapKindOf(SESSION_ID)).toBe('return');

      await vi.advanceTimersByTimeAsync(60_000);

      // Its own bound, not the earlier one's, ended the newer mark.
      expect(newerWait.outcome()).toBe(true);
      expect(recapKindOf(SESSION_ID)).toBeNull();
    });

    it('ignores an earlier mark\'s timeout that still fires after the mark was replaced', async () => {
      vi.useFakeTimers();
      // A timer already due when the mark was replaced fires despite its
      // clear. Make the clear a no-op to reach that case: only the guard in
      // the timeout callback (the entry in the registry is no longer its own)
      // keeps it from forgetting the newer mark.
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
      markRecapSession(SESSION_ID, 'return');
      const earlierWait = trackWait(whenRecapTurnEnds(SESSION_ID, 60_000));
      markRecapSession(SESSION_ID, 'return');
      const newerWait = trackWait(whenRecapTurnEnds(SESSION_ID, 120_000));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(earlierWait.outcome()).toBe(true);
      expect(newerWait.outcome()).toBe('pending');
      expect(recapKindOf(SESSION_ID)).toBe('return');

      await vi.advanceTimersByTimeAsync(60_000);

      expect(newerWait.outcome()).toBe(true);
      expect(recapKindOf(SESSION_ID)).toBeNull();
    });
  });
});
