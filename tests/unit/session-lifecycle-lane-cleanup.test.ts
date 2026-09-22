/**
 * Wiring test for markRecordExited -> destroyLanesForSession /
 * releaseViewportOverridesForSession (src/main/transition-engine/session-lifecycle.ts).
 *
 * A session ending is the GUARANTEE that closes any offscreen browser lane it
 * opened - the comment above the call site says so, because only one of the
 * ten supported agent CLIs fires a faster SubagentStop-style hook. Nothing in
 * the suite asserted markRecordExited actually reaches for it:
 * browser-lane-manager.test.ts proves destroyLanesForSession itself destroys
 * the right windows, but not that session-lifecycle.ts calls it. Deleting
 * that call leaks a lane every time a session exits normally.
 *
 * The same shape applies to releaseViewportOverridesForSession, added
 * alongside it: it is the guarantee that a viewport override a session left
 * on a PANE it did not own (see the call site's own comment) gets put back
 * when the session ends. tests/unit/browser-viewport-override.test.ts proves
 * releaseViewportOverridesForSession itself does the right cleanup given a
 * sessionId; nothing before this pinned that session-lifecycle.ts actually
 * calls it on a successful exit transition.
 *
 * markRecordExited takes its SessionRepository as a parameter rather than
 * constructing one, so a hand-rolled stub (not a real DB) is enough to drive
 * both branches of the guard: CAS succeeds (fresh 'running'/'queued' record)
 * and CAS fails (status already 'suspended', e.g. a repeated onExit).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';

const destroyLanesForSessionMock = vi.fn(() => 0);
const releaseViewportOverridesForSessionMock = vi.fn(() => Promise.resolve());

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLanesForSession: (...args: unknown[]) => destroyLanesForSessionMock(...(args as [string])),
}));

vi.mock('../../src/main/browser/viewport-override', () => ({
  releaseViewportOverridesForSession: (...args: unknown[]) =>
    releaseViewportOverridesForSessionMock(...(args as [string])),
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
    releaseViewportOverridesForSessionMock.mockClear();
    releaseViewportOverridesForSessionMock.mockReturnValue(Promise.resolve());
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

describe('markRecordExited: releaseViewportOverridesForSession wiring (red-green)', () => {
  beforeEach(() => {
    destroyLanesForSessionMock.mockClear();
    destroyLanesForSessionMock.mockReturnValue(0);
    releaseViewportOverridesForSessionMock.mockClear();
    releaseViewportOverridesForSessionMock.mockReturnValue(Promise.resolve());
  });

  it('releases the exiting session\'s viewport overrides when the CAS transition to exited succeeds', () => {
    const sessionRepository = makeSessionRepoStub(true);

    const transitioned = markRecordExited(sessionRepository, 'record-abc12345');

    expect(transitioned).toBe(true);
    expect(releaseViewportOverridesForSessionMock).toHaveBeenCalledTimes(1);
    expect(releaseViewportOverridesForSessionMock).toHaveBeenCalledWith('record-abc12345');
  });

  // Mirrors the lane guard's own flip-side case directly above: a repeated
  // onExit on an already-suspended record must not re-run viewport cleanup
  // either (the CAS-gated `if (transitioned)` block covers both calls).
  it('does NOT release viewport overrides when the CAS fails (record already suspended)', () => {
    const sessionRepository = makeSessionRepoStub(false);

    const transitioned = markRecordExited(sessionRepository, 'record-xyz98765');

    expect(transitioned).toBe(false);
    expect(releaseViewportOverridesForSessionMock).not.toHaveBeenCalled();
  });

  it('swallows a rejecting releaseViewportOverridesForSession and still reports the transition as successful', async () => {
    releaseViewportOverridesForSessionMock.mockReturnValueOnce(
      Promise.reject(new Error('synthetic viewport reset failure')),
    );
    const sessionRepository = makeSessionRepoStub(true);

    let transitioned = false;
    expect(() => {
      transitioned = markRecordExited(sessionRepository, 'record-def45678');
    }).not.toThrow();
    expect(transitioned).toBe(true);

    // The call is fire-and-forget (`void ...catch(...)`), so let its
    // rejection settle before the test ends - otherwise a real regression
    // (the `.catch` dropped) would surface as an unhandled rejection in a
    // LATER test rather than failing this one.
    await Promise.resolve();
    await Promise.resolve();
  });
});
