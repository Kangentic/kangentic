/**
 * Wiring test for markRecordExited -> destroyLanesForSession
 * (src/main/transition-engine/session-lifecycle.ts).
 *
 * A session ending is the GUARANTEE that closes any offscreen browser lane it
 * opened - the comment above the call site says so, because only one of the
 * ten supported agent CLIs fires a faster SubagentStop-style hook. Nothing in
 * the suite asserted markRecordExited actually reaches for it:
 * browser-lane-manager.test.ts proves destroyLanesForSession itself destroys
 * the right windows, but not that session-lifecycle.ts calls it. Deleting
 * that call leaks a lane every time a session exits normally.
 *
 * markRecordExited takes its SessionRepository as a parameter rather than
 * constructing one, so a hand-rolled stub (not a real DB) is enough to drive
 * both branches of the guard: CAS succeeds (fresh 'running'/'queued' record)
 * and CAS fails (status already 'suspended', e.g. a repeated onExit).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';

const destroyLanesForSessionMock = vi.fn(() => 0);

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLanesForSession: (...args: unknown[]) => destroyLanesForSessionMock(...(args as [string])),
}));

import { markRecordExited } from '../../src/main/transition-engine/session-lifecycle';

function makeSessionRepoStub(compareAndUpdateStatusResult: boolean): SessionRepository {
  return {
    compareAndUpdateStatus: vi.fn(() => compareAndUpdateStatusResult),
  } as unknown as SessionRepository;
}

describe('markRecordExited: destroyLanesForSession wiring (red-green)', () => {
  beforeEach(() => {
    destroyLanesForSessionMock.mockClear();
    destroyLanesForSessionMock.mockReturnValue(0);
  });

  it('destroys the exiting session\'s lanes when the CAS transition to exited succeeds', () => {
    const sessionRepository = makeSessionRepoStub(true);

    const transitioned = markRecordExited(sessionRepository, 'record-abc12345');

    expect(transitioned).toBe(true);
    expect(destroyLanesForSessionMock).toHaveBeenCalledTimes(1);
    expect(destroyLanesForSessionMock).toHaveBeenCalledWith('record-abc12345');
  });

  // This is the flip side of the guarantee above, and it is a KNOWN,
  // deliberately-unfixed gap (per the task that added this test): a session
  // already marked 'suspended' has its lane leak, because the CAS only
  // transitions from 'running' or 'queued'. Pinning the CURRENT behavior, not
  // proposing a fix - a repeated onExit on an already-suspended record must
  // not re-run teardown a second time.
  it('does NOT destroy lanes when the CAS fails (record already suspended)', () => {
    const sessionRepository = makeSessionRepoStub(false);

    const transitioned = markRecordExited(sessionRepository, 'record-xyz98765');

    expect(transitioned).toBe(false);
    expect(destroyLanesForSessionMock).not.toHaveBeenCalled();
  });

  it('swallows a throwing destroyLanesForSession and still reports the transition as successful', () => {
    destroyLanesForSessionMock.mockImplementationOnce(() => {
      throw new Error('synthetic lane teardown failure');
    });
    const sessionRepository = makeSessionRepoStub(true);

    let transitioned = false;
    expect(() => {
      transitioned = markRecordExited(sessionRepository, 'record-def45678');
    }).not.toThrow();
    expect(transitioned).toBe(true);
  });
});
