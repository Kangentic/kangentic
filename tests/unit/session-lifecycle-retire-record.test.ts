/**
 * `retireRecord` (src/main/transition-engine/session-lifecycle.ts) and the
 * time it stamps.
 *
 * Retiring accepted `exited` as a source status and wrote `exited_at = now` on
 * every call, so a record that had already ended kept getting a newer exit
 * time each time something touched it: a session that ended at 14:36:24 read
 * as ended at 14:36:40 once its replacement spawned (#682 follow-up). The
 * stamp now belongs only to the call that ends the record; an already-exited
 * row is confirmed without a stamp, and the return value stays true.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLanesForSession: vi.fn(),
}));

import { retireRecord } from '../../src/main/transition-engine/session-lifecycle';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';

type Cas = SessionRepository['compareAndUpdateStatus'];

function repoWhoseStatusIs(status: string): { repo: SessionRepository; cas: ReturnType<typeof vi.fn> } {
  const cas = vi.fn(((_id, expectedFrom) => {
    const fromList = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
    return fromList.includes(status as never);
  }) as Cas);
  return { repo: { compareAndUpdateStatus: cas } as unknown as SessionRepository, cas };
}

describe('retireRecord', () => {
  it('stamps exited_at when it is the call that ends a suspended record', () => {
    const { repo, cas } = repoWhoseStatusIs('suspended');

    expect(retireRecord(repo, 'rec-1')).toBe(true);

    expect(cas).toHaveBeenCalledTimes(1);
    expect(cas).toHaveBeenCalledWith('rec-1', ['suspended', 'orphaned'], 'exited', { exited_at: expect.any(String) });
  });

  it('leaves an already-exited record\'s exited_at alone and still reports it retired', () => {
    const { repo, cas } = repoWhoseStatusIs('exited');

    expect(retireRecord(repo, 'rec-1')).toBe(true);

    expect(cas).toHaveBeenCalledTimes(2);
    // The second, confirming CAS carries no extra fields: nothing is re-stamped.
    expect(cas.mock.calls[1]).toEqual(['rec-1', 'exited', 'exited']);
  });

  it('returns false for a record in a status it does not retire', () => {
    const { repo } = repoWhoseStatusIs('running');

    expect(retireRecord(repo, 'rec-1')).toBe(false);
  });
});
