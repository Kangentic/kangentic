import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationSwitchGate } from '../../src/main/activity-engine/conversation-switch-gate';
import type { SessionUsage } from '../../src/shared/types';

/**
 * The gate only stores and returns usage objects, never reads them, so a
 * minimal object tagged by `marker` is enough to tell one report from another.
 */
function usageMarked(marker: string): SessionUsage {
  return { marker } as unknown as SessionUsage;
}

/** `count` distinct ids named `<prefix>-1` .. `<prefix>-<count>`, oldest first. */
function idsOf(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${index + 1}`);
}

const SESSION = 'session-1';
const OTHER_SESSION = 'session-2';
const CURRENT_ID = 'current-id';
/** Mirrors MAX_TRACKED_IDS in conversation-switch-gate.ts (not exported). */
const CAP = 8;

describe('ConversationSwitchGate', () => {
  let gate: ConversationSwitchGate;

  beforeEach(() => {
    gate = new ConversationSwitchGate();
  });

  describe('hold then confirm', () => {
    it('holds an unconfirmed id and hands its usage back once when a hook confirms it', () => {
      const usage = usageMarked('first-report');

      expect(gate.admit(SESSION, 'moved-id', usage)).toBe('hold');

      expect(gate.confirm(SESSION, 'moved-id', CURRENT_ID)).toBe(usage);
      expect(gate.confirm(SESSION, 'moved-id', CURRENT_ID)).toBeNull();
    });

    it('returns null from confirm when nothing was held for that id', () => {
      expect(gate.confirm(SESSION, 'moved-id', CURRENT_ID)).toBeNull();
    });
  });

  describe('confirm then admit', () => {
    it('admits a confirmed id as a switch', () => {
      gate.confirm(SESSION, 'moved-id', CURRENT_ID);

      expect(gate.admit(SESSION, 'moved-id', usageMarked('late-write'))).toBe('switch');
    });

    it('does not let a confirmation for one id admit another', () => {
      gate.confirm(SESSION, 'moved-id', CURRENT_ID);

      expect(gate.admit(SESSION, 'spare-id', usageMarked('spare-write'))).toBe('hold');
    });

    it('records nothing when the confirmed id is already the current one', () => {
      expect(gate.confirm(SESSION, CURRENT_ID, CURRENT_ID)).toBeNull();

      expect(gate.admit(SESSION, CURRENT_ID, usageMarked('stale-writer'))).toBe('hold');
    });

    it('records the confirmation when the session has no current id yet', () => {
      gate.confirm(SESSION, 'moved-id', undefined);

      expect(gate.admit(SESSION, 'moved-id', usageMarked('first-write'))).toBe('switch');
    });
  });

  describe('the confirmed list cap', () => {
    it('forgets the oldest confirmation past the cap and keeps the newest ones', () => {
      const ids = idsOf('confirmed', CAP + 1);
      for (const id of ids) gate.confirm(SESSION, id, CURRENT_ID);

      expect(gate.admit(SESSION, ids[0], usageMarked('oldest'))).toBe('hold');
      for (const id of ids.slice(1)) {
        expect(gate.admit(SESSION, id, usageMarked(id))).toBe('switch');
      }
    });

    it('keeps every confirmation while the list is exactly at the cap', () => {
      const ids = idsOf('confirmed', CAP);
      for (const id of ids) gate.confirm(SESSION, id, CURRENT_ID);

      for (const id of ids) {
        expect(gate.admit(SESSION, id, usageMarked(id))).toBe('switch');
      }
    });

    it('moves a re-confirmed id to newest without spending a second slot on it', () => {
      // 7 distinct ids, then the second one again, then an eighth distinct id.
      // Deduplicated, that is 8 entries and none has been evicted yet.
      const ids = idsOf('confirmed', CAP - 1);
      for (const id of ids) gate.confirm(SESSION, id, CURRENT_ID);
      gate.confirm(SESSION, ids[1], CURRENT_ID);
      gate.confirm(SESSION, 'confirmed-extra-1', CURRENT_ID);

      for (const id of [...ids, 'confirmed-extra-1']) {
        expect(gate.admit(SESSION, id, usageMarked(id))).toBe('switch');
      }
    });

    it('keeps a re-confirmed id as newest while older entries are evicted', () => {
      // Order after the re-confirm: 1, 3, 4, 5, 6, 7, then 2 as newest.
      // The first extra fills the list to the cap. The next two evict 1 and
      // 3. Had 2 kept its first slot it would be the second oldest and go
      // with them.
      const ids = idsOf('confirmed', CAP - 1);
      for (const id of ids) gate.confirm(SESSION, id, CURRENT_ID);
      gate.confirm(SESSION, ids[1], CURRENT_ID);
      gate.confirm(SESSION, 'confirmed-extra-1', CURRENT_ID);
      gate.confirm(SESSION, 'confirmed-extra-2', CURRENT_ID);
      gate.confirm(SESSION, 'confirmed-extra-3', CURRENT_ID);

      expect(gate.admit(SESSION, ids[0], usageMarked('evicted-1'))).toBe('hold');
      expect(gate.admit(SESSION, ids[2], usageMarked('evicted-2'))).toBe('hold');
      expect(gate.admit(SESSION, ids[1], usageMarked('re-confirmed'))).toBe('switch');
      expect(gate.admit(SESSION, 'confirmed-extra-3', usageMarked('newest'))).toBe('switch');
    });

    it('still admits an id confirmed again after a full list of others', () => {
      // First confirmed, seven others, the first again, one more. The repeat
      // must move the first id to newest. Left at its old position (oldest),
      // the one more confirmation would evict it.
      const first = 'confirmed-first';
      gate.confirm(SESSION, first, CURRENT_ID);
      for (const id of idsOf('confirmed-other', CAP - 1)) gate.confirm(SESSION, id, CURRENT_ID);
      gate.confirm(SESSION, first, CURRENT_ID);
      gate.confirm(SESSION, 'confirmed-extra', CURRENT_ID);

      expect(gate.admit(SESSION, first, usageMarked('first-write'))).toBe('switch');
    });
  });

  describe('the held list cap', () => {
    it('forgets the oldest held id past the cap and keeps the newest ones', () => {
      const ids = idsOf('held', CAP + 1);
      const usageById = new Map(ids.map((id) => [id, usageMarked(id)]));
      for (const id of ids) gate.admit(SESSION, id, usageById.get(id)!);

      expect(gate.confirm(SESSION, ids[0], CURRENT_ID)).toBeNull();
      for (const id of ids.slice(1)) {
        expect(gate.confirm(SESSION, id, CURRENT_ID)).toBe(usageById.get(id));
      }
    });

    it('keeps every held id while the list is exactly at the cap', () => {
      const ids = idsOf('held', CAP);
      const usageById = new Map(ids.map((id) => [id, usageMarked(id)]));
      for (const id of ids) gate.admit(SESSION, id, usageById.get(id)!);

      for (const id of ids) {
        expect(gate.confirm(SESSION, id, CURRENT_ID)).toBe(usageById.get(id));
      }
    });
  });

  describe('admitting the same id twice', () => {
    it('hands back the latest usage on confirm', () => {
      const earlier = usageMarked('earlier');
      const later = usageMarked('later');

      expect(gate.admit(SESSION, 'moved-id', earlier)).toBe('hold');
      expect(gate.admit(SESSION, 'moved-id', later)).toBe('hold');

      expect(gate.confirm(SESSION, 'moved-id', CURRENT_ID)).toBe(later);
      expect(gate.confirm(SESSION, 'moved-id', CURRENT_ID)).toBeNull();
    });

    it('counts the re-admitted id as the newest held, so older ids are evicted first', () => {
      // Held: 1..8 with 1 admitted first. Re-admit 1, so 2 is now the oldest.
      // One more distinct id pushes the list past the cap and evicts 2, not 1.
      const ids = idsOf('held', CAP);
      for (const id of ids) gate.admit(SESSION, id, usageMarked(`${id}-earlier`));
      const refreshed = usageMarked('held-1-refreshed');
      gate.admit(SESSION, ids[0], refreshed);
      const newest = usageMarked('held-extra');
      gate.admit(SESSION, 'held-extra', newest);

      expect(gate.confirm(SESSION, ids[1], CURRENT_ID)).toBeNull();
      expect(gate.confirm(SESSION, ids[0], CURRENT_ID)).toBe(refreshed);
      expect(gate.confirm(SESSION, 'held-extra', CURRENT_ID)).toBe(newest);
    });

    it('evicts the re-admitted id only once eight newer ids follow it', () => {
      const refreshed = usageMarked('held-first-refreshed');
      gate.admit(SESSION, 'held-first', usageMarked('held-first-earlier'));
      gate.admit(SESSION, 'held-first', refreshed);

      // Seven newer ids: the list is full but the re-admitted id is still in it.
      const newer = idsOf('held-newer', CAP);
      for (const id of newer.slice(0, CAP - 1)) gate.admit(SESSION, id, usageMarked(id));
      // The eighth newer id is the ninth entry, so the oldest (the re-admitted id) goes.
      gate.admit(SESSION, newer[CAP - 1], usageMarked(newer[CAP - 1]));

      expect(gate.confirm(SESSION, 'held-first', CURRENT_ID)).toBeNull();
    });

    it('still holds the re-admitted id after seven newer ids follow it', () => {
      const refreshed = usageMarked('held-first-refreshed');
      gate.admit(SESSION, 'held-first', usageMarked('held-first-earlier'));
      gate.admit(SESSION, 'held-first', refreshed);
      for (const id of idsOf('held-newer', CAP - 1)) gate.admit(SESSION, id, usageMarked(id));

      expect(gate.confirm(SESSION, 'held-first', CURRENT_ID)).toBe(refreshed);
    });
  });

  describe('adopt', () => {
    it('spends the adopted confirmation and every older one, and keeps newer ones', () => {
      for (const id of ['move-a', 'move-b', 'move-c', 'move-d']) {
        gate.confirm(SESSION, id, CURRENT_ID);
      }

      gate.adopt(SESSION, 'move-b');

      expect(gate.admit(SESSION, 'move-a', usageMarked('late-a'))).toBe('hold');
      expect(gate.admit(SESSION, 'move-b', usageMarked('late-b'))).toBe('hold');
      expect(gate.admit(SESSION, 'move-c', usageMarked('late-c'))).toBe('switch');
      expect(gate.admit(SESSION, 'move-d', usageMarked('late-d'))).toBe('switch');
    });

    it('spends every confirmation when the newest one is the one adopted', () => {
      gate.confirm(SESSION, 'move-a', CURRENT_ID);
      gate.confirm(SESSION, 'move-b', CURRENT_ID);

      gate.adopt(SESSION, 'move-b');

      expect(gate.admit(SESSION, 'move-a', usageMarked('late-a'))).toBe('hold');
      expect(gate.admit(SESSION, 'move-b', usageMarked('late-b'))).toBe('hold');
    });

    it('clears no confirmation when the adopted id was never confirmed', () => {
      gate.confirm(SESSION, 'move-a', CURRENT_ID);
      gate.confirm(SESSION, 'move-b', CURRENT_ID);

      gate.adopt(SESSION, 'never-confirmed');

      expect(gate.admit(SESSION, 'move-a', usageMarked('late-a'))).toBe('switch');
      expect(gate.admit(SESSION, 'move-b', usageMarked('late-b'))).toBe('switch');
    });

    it('drops the adopted id\'s held usage', () => {
      gate.admit(SESSION, 'moved-id', usageMarked('held-write'));

      gate.adopt(SESSION, 'moved-id');

      expect(gate.confirm(SESSION, 'moved-id', CURRENT_ID)).toBeNull();
    });

    it('leaves the held usage of other ids alone', () => {
      const spare = usageMarked('spare-write');
      gate.admit(SESSION, 'moved-id', usageMarked('held-write'));
      gate.admit(SESSION, 'spare-id', spare);

      gate.adopt(SESSION, 'moved-id');

      expect(gate.confirm(SESSION, 'spare-id', CURRENT_ID)).toBe(spare);
    });

    it('does nothing for a session it has never seen', () => {
      expect(() => gate.adopt('unknown-session', 'moved-id')).not.toThrow();
      expect(gate.admit('unknown-session', 'moved-id', usageMarked('write'))).toBe('hold');
    });
  });

  describe('removeSession', () => {
    it('forgets the confirmed and held ids of that session only', () => {
      const survivingHeld = usageMarked('session-2-held');
      for (const session of [SESSION, OTHER_SESSION]) {
        gate.confirm(session, 'moved-id', CURRENT_ID);
        gate.admit(session, 'held-id', session === OTHER_SESSION ? survivingHeld : usageMarked('session-1-held'));
      }

      gate.removeSession(SESSION);

      // The removed session starts over: no confirmation, no held usage.
      expect(gate.confirm(SESSION, 'held-id', CURRENT_ID)).toBeNull();
      expect(gate.admit(SESSION, 'moved-id', usageMarked('fresh-write'))).toBe('hold');
      // The other session keeps both.
      expect(gate.admit(OTHER_SESSION, 'moved-id', usageMarked('late-write'))).toBe('switch');
      expect(gate.confirm(OTHER_SESSION, 'held-id', CURRENT_ID)).toBe(survivingHeld);
    });

    it('is a no-op for a session it has never seen', () => {
      expect(() => gate.removeSession('unknown-session')).not.toThrow();
    });
  });

  describe('session isolation', () => {
    it('keeps each session\'s confirmations and held usage separate', () => {
      const usage = usageMarked('session-1-write');
      gate.confirm(SESSION, 'moved-id', CURRENT_ID);
      gate.admit(SESSION, 'held-id', usage);

      expect(gate.admit(OTHER_SESSION, 'moved-id', usageMarked('other-write'))).toBe('hold');
      expect(gate.confirm(OTHER_SESSION, 'held-id', CURRENT_ID)).toBeNull();
      expect(gate.admit(SESSION, 'moved-id', usageMarked('late-write'))).toBe('switch');
      expect(gate.confirm(SESSION, 'held-id', CURRENT_ID)).toBe(usage);
    });
  });
});
