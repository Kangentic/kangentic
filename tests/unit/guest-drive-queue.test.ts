import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  withGuestDriveLock,
  guestDriveDepth,
  resetGuestDriveQueuesForTests,
  GuestBusyError,
} from '../../src/main/browser/guest-drive-queue';

/**
 * The per-guest FIFO that converts interleaved CDP commands into
 * slow-but-correct ones.
 *
 * These exercise the queue directly rather than through `withGuest`, so a
 * failure points at the lock rather than at pane resolution.
 */

beforeEach(() => {
  resetGuestDriveQueuesForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetGuestDriveQueuesForTests();
});

describe('withGuestDriveLock', () => {
  it('runs one drive at a time on a guest, in arrival order', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const first = withGuestDriveLock(7, async () => {
      order.push('first:start');
      await held;
      order.push('first:end');
    });
    const second = withGuestDriveLock(7, async () => { order.push('second'); });
    const third = withGuestDriveLock(7, async () => { order.push('third'); });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    release?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  it('does not serialize across DIFFERENT guests', async () => {
    // Separate panes are the whole point of lanes: they must stay parallel.
    const order: string[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const onSeven = withGuestDriveLock(7, async () => {
      order.push('seven:start');
      await held;
      order.push('seven:end');
    });
    const onEight = withGuestDriveLock(8, async () => { order.push('eight'); });

    await onEight;
    expect(order).toEqual(['seven:start', 'eight']);

    release?.();
    await onSeven;
  });

  it('propagates the body result and its errors to the right caller', async () => {
    await expect(withGuestDriveLock(7, async () => 'value')).resolves.toBe('value');
    await expect(withGuestDriveLock(7, async () => { throw new Error('body failed'); }))
      .rejects.toThrow('body failed');
    // A rejecting body must not wedge the queue for the next caller.
    await expect(withGuestDriveLock(7, async () => 'after')).resolves.toBe('after');
  });

  it('refuses with GuestBusyError rather than waiting forever on a stuck holder', async () => {
    vi.useFakeTimers();
    // Never resolves: the guest is wedged.
    const stuck = withGuestDriveLock(7, () => new Promise<void>(() => {}));
    const queued = withGuestDriveLock(7, async () => 'never runs', 1000);
    // Attach the rejection handler BEFORE advancing time, or the rejection
    // lands with nothing awaiting it and surfaces as an unhandled rejection.
    const rejection = queued.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1001);

    const error = await rejection;
    expect(error).toBeInstanceOf(GuestBusyError);
    // The refusal names the escape hatch, since retrying a wedged pane forever
    // is not something the calling agent can recover from on its own.
    expect((error as Error).message).toMatch(/isolated: true/);
    void stuck;
  });

  it('does not run a body that already gave up waiting', async () => {
    // Otherwise a timed-out drive would still dispatch its CDP commands later,
    // against a page the agent has stopped reasoning about.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withGuestDriveLock(7, async () => { await held; });

    let ran = false;
    const queued = withGuestDriveLock(7, async () => { ran = true; }, 1000);
    const rejection = queued.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1001);
    expect(await rejection).toBeInstanceOf(GuestBusyError);

    release?.();
    await holder;
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toBe(false);
  });
});

describe('guestDriveDepth', () => {
  it('reports zero for an untouched guest and drops back to zero when drained', async () => {
    expect(guestDriveDepth(7)).toBe(0);
    await withGuestDriveLock(7, async () => 'done');
    expect(guestDriveDepth(7)).toBe(0);
  });

  it('counts the running drive plus everything queued behind it', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const first = withGuestDriveLock(7, async () => { await held; });
    const second = withGuestDriveLock(7, async () => {});
    await Promise.resolve();

    expect(guestDriveDepth(7)).toBe(2);

    release?.();
    await Promise.all([first, second]);
    expect(guestDriveDepth(7)).toBe(0);
  });
});

describe('resetGuestDriveQueuesForTests', () => {
  it('drops queues so a suite sharing one guest id does not leak state', async () => {
    const holder = withGuestDriveLock(7, () => new Promise<void>(() => {}));
    await Promise.resolve();
    expect(guestDriveDepth(7)).toBe(1);

    resetGuestDriveQueuesForTests();
    expect(guestDriveDepth(7)).toBe(0);

    // A fresh queue runs immediately rather than stacking behind the abandoned
    // holder - which is exactly what stalled six tests before this seam existed.
    await expect(withGuestDriveLock(7, async () => 'fresh')).resolves.toBe('fresh');
    void holder;
  });
});
