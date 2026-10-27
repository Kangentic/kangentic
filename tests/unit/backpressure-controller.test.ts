import { describe, it, expect, vi } from 'vitest';
import {
  BackpressureController,
  type PauseResumeTarget,
} from '../../src/main/pty/buffer/backpressure-controller';

function fakePty(): PauseResumeTarget & { pauseSpy: ReturnType<typeof vi.fn>; resumeSpy: ReturnType<typeof vi.fn> } {
  const pauseSpy = vi.fn();
  const resumeSpy = vi.fn();
  return { pause: pauseSpy, resume: resumeSpy, pauseSpy, resumeSpy };
}

const HIGH = 1000;
const LOW = 200;

describe('BackpressureController', () => {
  it('does not pause while in-flight stays below the high-water mark', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 500);
    controller.recordEmitted('s', 400); // 900 < 1000
    expect(pty.pauseSpy).not.toHaveBeenCalled();
    expect(controller.isPaused('s')).toBe(false);
  });

  it('pauses once in-flight reaches the high-water mark', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 600);
    controller.recordEmitted('s', 500); // 1100 >= 1000
    expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('s')).toBe(true);
  });

  it('pauses at most once until resumed (no repeated pause calls)', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 1100);
    controller.recordEmitted('s', 1100);
    expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('resumes only once in-flight drains below the low-water mark', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 1100); // paused, inFlight 1100
    controller.acknowledge('s', 800); // 300 > 200 -> still paused
    expect(pty.resumeSpy).not.toHaveBeenCalled();
    expect(controller.isPaused('s')).toBe(true);
    controller.acknowledge('s', 200); // 100 <= 200 -> resume
    expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('s')).toBe(false);
  });

  describe('the pending buffer as a second reason to pause', () => {
    const PENDING_HIGH = 5000;
    const PENDING_LOW = 500;
    const controllerFor = (pty: PauseResumeTarget) => new BackpressureController(() => pty, {
      highWater: HIGH,
      lowWater: LOW,
      pendingHighWater: PENDING_HIGH,
      pendingLowWater: PENDING_LOW,
    });

    it('pauses when the pending buffer piles up, with nothing in flight', () => {
      const pty = fakePty();
      const controller = controllerFor(pty);
      controller.recordPending('s', 4000);
      expect(controller.isPaused('s')).toBe(false);
      controller.recordPending('s', 6000);
      expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
      expect(controller.isPaused('s')).toBe(true);
    });

    it('does not resume on an acknowledgement while the pending buffer is still high', () => {
      const pty = fakePty();
      const controller = controllerFor(pty);
      controller.recordPending('s', 6000);
      controller.recordEmitted('s', 300);
      controller.acknowledge('s', 300);
      expect(pty.resumeSpy).not.toHaveBeenCalled();
      expect(controller.isPaused('s')).toBe(true);
    });

    it('resumes only once the pending buffer and in-flight are both low', () => {
      const pty = fakePty();
      const controller = controllerFor(pty);
      controller.recordPending('s', 6000);
      controller.recordEmitted('s', 1100);
      controller.recordPending('s', 400);
      expect(pty.resumeSpy).not.toHaveBeenCalled();
      controller.acknowledge('s', 1000);
      expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
      expect(controller.isPaused('s')).toBe(false);
    });

    it('keeps no entry for a session whose pending buffer stays low', () => {
      const pty = fakePty();
      const controller = controllerFor(pty);
      controller.recordPending('s', 100);
      expect(controller.getInFlight('s')).toBe(0);
      expect(controller.isPaused('s')).toBe(false);
      expect(pty.pauseSpy).not.toHaveBeenCalled();
    });
  });

  describe('a pause no ack answers (a renderer whose terminals are gone, task #912)', () => {
    const STALE = 10_000;
    const PENDING_HIGH = 5000;
    const PENDING_LOW = 500;
    const RELEASED = 8000;

    function staleController(pty: PauseResumeTarget) {
      const clock = { nowMs: 0 };
      const controller = new BackpressureController(() => pty, {
        highWater: HIGH,
        lowWater: LOW,
        pendingHighWater: PENDING_HIGH,
        pendingLowWater: PENDING_LOW,
        now: () => clock.nowMs,
        stalePauseMs: STALE,
        releasedHighWater: RELEASED,
      });
      return { controller, clock };
    }

    it('resumes a session paused on in-flight once nothing has acked it for the stale bound', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      expect(controller.isPaused('s')).toBe(true);

      clock.nowMs = STALE - 1;
      expect(controller.releaseStalePauses()).toEqual([]);
      expect(pty.resumeSpy).not.toHaveBeenCalled();

      clock.nowMs = STALE;
      expect(controller.releaseStalePauses()).toEqual([{ sessionId: 's', inFlight: 1100, idleMs: STALE }]);
      expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
      expect(controller.isPaused('s')).toBe(false);
      expect(controller.getInFlight('s')).toBe(0);
      expect(controller.hasPausedSession()).toBe(false);
    });

    it('restarts the clock on every ack, so a slow renderer that keeps acking is never released', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 5000);
      // 20 s paused in all, twice the bound, but never 10 s without an ack.
      for (let step = 1; step <= 4; step++) {
        clock.nowMs = step * 5000;
        expect(controller.releaseStalePauses()).toEqual([]);
        controller.acknowledge('s', 100); // still far above the low water
      }
      expect(controller.isPaused('s')).toBe(true);
      expect(pty.resumeSpy).not.toHaveBeenCalled();
    });

    it('raises the high water after a release, so unacked output pauses it again only at the raised cap', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      clock.nowMs = STALE;
      controller.releaseStalePauses();

      controller.recordEmitted('s', RELEASED - 1);
      expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
      expect(controller.isPaused('s')).toBe(false);
      controller.recordEmitted('s', 1);
      expect(pty.pauseSpy).toHaveBeenCalledTimes(2);
      expect(controller.isPaused('s')).toBe(true);
    });

    it('releases again a session that reaches the raised cap with still no ack, one stale window after that pause', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      clock.nowMs = STALE;
      controller.releaseStalePauses();
      controller.recordEmitted('s', RELEASED);
      expect(controller.isPaused('s')).toBe(true);

      // The clock restarts at this pause, not at the entry's creation or the first release.
      clock.nowMs = STALE * 2 - 1;
      expect(controller.releaseStalePauses()).toEqual([]);
      clock.nowMs = STALE * 2;
      expect(controller.releaseStalePauses()).toEqual([{ sessionId: 's', inFlight: RELEASED, idleMs: STALE }]);
      expect(pty.resumeSpy).toHaveBeenCalledTimes(2);
      expect(controller.isPaused('s')).toBe(false);
    });

    it('still pauses a released session on the host\'s own pending buffer, and resumes it once drained', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      clock.nowMs = STALE;
      controller.releaseStalePauses();

      controller.recordPending('s', PENDING_HIGH + 1);
      expect(pty.pauseSpy).toHaveBeenCalledTimes(2);
      expect(controller.isPaused('s')).toBe(true);
      // Not a stale pause: the flush drains the pending buffer whether or not anyone acks.
      clock.nowMs = STALE * 3;
      expect(controller.releaseStalePauses()).toEqual([]);

      controller.recordPending('s', PENDING_LOW);
      expect(controller.isPaused('s')).toBe(false);
      expect(pty.resumeSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps a release paused while the pending buffer is still high, until recordPending drains it', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      controller.recordPending('s', PENDING_HIGH + 1);
      clock.nowMs = STALE;

      expect(controller.releaseStalePauses()).toHaveLength(1);
      expect(controller.isPaused('s')).toBe(true);
      expect(pty.resumeSpy).not.toHaveBeenCalled();

      controller.recordPending('s', PENDING_LOW);
      expect(controller.isPaused('s')).toBe(false);
      expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
    });

    it('restores the normal high water on the next ack, still counting what it sent while released', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      clock.nowMs = STALE;
      controller.releaseStalePauses();
      controller.recordEmitted('s', 5000); // above the normal high water, below the raised one
      expect(controller.isPaused('s')).toBe(false);

      // A renderer thawing from a stall acks its oldest output first; the backlog behind it still counts.
      controller.acknowledge('s', 64);
      expect(controller.getInFlight('s')).toBe(5000 - 64);
      controller.recordEmitted('s', 1);
      expect(pty.pauseSpy).toHaveBeenCalledTimes(2);
      expect(controller.isPaused('s')).toBe(true);
    });

    it('release() forgets the raised high water, so a fresh focus starts at the normal one', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordEmitted('s', 1100);
      clock.nowMs = STALE;
      controller.releaseStalePauses();

      controller.release('s');
      controller.recordEmitted('s', 1100);
      expect(controller.isPaused('s')).toBe(true);
    });

    it('does not count a pause held only by the pending buffer as stale', () => {
      const pty = fakePty();
      const { controller, clock } = staleController(pty);
      controller.recordPending('s', PENDING_HIGH + 1);
      clock.nowMs = STALE * 2;
      expect(controller.releaseStalePauses()).toEqual([]);
      expect(controller.isPaused('s')).toBe(true);
    });
  });

  it('isolates accounting per session', () => {
    const ptyA = fakePty();
    const ptyB = fakePty();
    const controller = new BackpressureController((id) => (id === 'a' ? ptyA : ptyB), { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('a', 1100); // a pauses
    controller.recordEmitted('b', 100); // b stays free
    expect(ptyA.pauseSpy).toHaveBeenCalledTimes(1);
    expect(ptyB.pauseSpy).not.toHaveBeenCalled();
  });

  it('acknowledging an unknown session is a no-op', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    expect(() => controller.acknowledge('missing', 100)).not.toThrow();
    expect(pty.resumeSpy).not.toHaveBeenCalled();
  });

  it('clamps in-flight at zero so over-acking cannot wedge a later pause', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 100);
    controller.acknowledge('s', 500); // over-ack, clamps to 0
    controller.recordEmitted('s', 1100); // should pause from a clean 0 base
    expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('release resumes a paused session and forgets its accounting', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 1100);
    controller.release('s');
    expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('s')).toBe(false);
  });

  it('reset resumes every paused session and clears state', () => {
    const ptyA = fakePty();
    const ptyB = fakePty();
    const controller = new BackpressureController((id) => (id === 'a' ? ptyA : ptyB), { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('a', 1100);
    controller.recordEmitted('b', 1100);
    controller.reset();
    expect(ptyA.resumeSpy).toHaveBeenCalledTimes(1);
    expect(ptyB.resumeSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('a')).toBe(false);
    expect(controller.isPaused('b')).toBe(false);
  });

  it('degrades gracefully when the target is gone or pause throws', () => {
    const controller = new BackpressureController(() => null, { highWater: HIGH, lowWater: LOW });
    controller.recordEmitted('s', 1100);
    // No target to pause: stays unpaused rather than crashing.
    expect(controller.isPaused('s')).toBe(false);
    const throwing: PauseResumeTarget = {
      pause: () => { throw new Error('unsupported'); },
      resume: () => { throw new Error('unsupported'); },
    };
    const controller2 = new BackpressureController(() => throwing, { highWater: HIGH, lowWater: LOW });
    expect(() => controller2.recordEmitted('s', 1100)).not.toThrow();
    expect(controller2.isPaused('s')).toBe(false);
  });

  it('release of a never-paused session does not call resume and forgets its accounting', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, { highWater: HIGH, lowWater: LOW });

    // Record below highWater so the session is tracked but never paused.
    controller.recordEmitted('s', HIGH - 1);
    expect(controller.isPaused('s')).toBe(false);

    controller.release('s');

    // release must only resume a paused session - this one was never paused.
    expect(pty.resumeSpy).not.toHaveBeenCalled();
    // Accounting is forgotten: getInFlight returns the default 0 for unknown sessions.
    expect(controller.getInFlight('s')).toBe(0);
  });
});
