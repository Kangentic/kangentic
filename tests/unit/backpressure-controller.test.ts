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
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    controller.recordEmitted('s', 500);
    controller.recordEmitted('s', 400); // 900 < 1000
    expect(pty.pauseSpy).not.toHaveBeenCalled();
    expect(controller.isPaused('s')).toBe(false);
  });

  it('pauses once in-flight reaches the high-water mark', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    controller.recordEmitted('s', 600);
    controller.recordEmitted('s', 500); // 1100 >= 1000
    expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('s')).toBe(true);
  });

  it('pauses at most once until resumed (no repeated pause calls)', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    controller.recordEmitted('s', 1100);
    controller.recordEmitted('s', 1100);
    expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('resumes only once in-flight drains below the low-water mark', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    controller.recordEmitted('s', 1100); // paused, inFlight 1100
    controller.acknowledge('s', 800); // 300 > 200 -> still paused
    expect(pty.resumeSpy).not.toHaveBeenCalled();
    expect(controller.isPaused('s')).toBe(true);
    controller.acknowledge('s', 200); // 100 <= 200 -> resume
    expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('s')).toBe(false);
  });

  it('isolates accounting per session', () => {
    const ptyA = fakePty();
    const ptyB = fakePty();
    const controller = new BackpressureController((id) => (id === 'a' ? ptyA : ptyB), HIGH, LOW);
    controller.recordEmitted('a', 1100); // a pauses
    controller.recordEmitted('b', 100); // b stays free
    expect(ptyA.pauseSpy).toHaveBeenCalledTimes(1);
    expect(ptyB.pauseSpy).not.toHaveBeenCalled();
  });

  it('acknowledging an unknown session is a no-op', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    expect(() => controller.acknowledge('missing', 100)).not.toThrow();
    expect(pty.resumeSpy).not.toHaveBeenCalled();
  });

  it('clamps in-flight at zero so over-acking cannot wedge a later pause', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    controller.recordEmitted('s', 100);
    controller.acknowledge('s', 500); // over-ack, clamps to 0
    controller.recordEmitted('s', 1100); // should pause from a clean 0 base
    expect(pty.pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('release resumes a paused session and forgets its accounting', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);
    controller.recordEmitted('s', 1100);
    controller.release('s');
    expect(pty.resumeSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('s')).toBe(false);
  });

  it('reset resumes every paused session and clears state', () => {
    const ptyA = fakePty();
    const ptyB = fakePty();
    const controller = new BackpressureController((id) => (id === 'a' ? ptyA : ptyB), HIGH, LOW);
    controller.recordEmitted('a', 1100);
    controller.recordEmitted('b', 1100);
    controller.reset();
    expect(ptyA.resumeSpy).toHaveBeenCalledTimes(1);
    expect(ptyB.resumeSpy).toHaveBeenCalledTimes(1);
    expect(controller.isPaused('a')).toBe(false);
    expect(controller.isPaused('b')).toBe(false);
  });

  it('degrades gracefully when the target is gone or pause throws', () => {
    const controller = new BackpressureController(() => null, HIGH, LOW);
    controller.recordEmitted('s', 1100);
    // No target to pause: stays unpaused rather than crashing.
    expect(controller.isPaused('s')).toBe(false);
    const throwing: PauseResumeTarget = {
      pause: () => { throw new Error('unsupported'); },
      resume: () => { throw new Error('unsupported'); },
    };
    const controller2 = new BackpressureController(() => throwing, HIGH, LOW);
    expect(() => controller2.recordEmitted('s', 1100)).not.toThrow();
    expect(controller2.isPaused('s')).toBe(false);
  });

  it('release of a never-paused session does not call resume and forgets its accounting', () => {
    const pty = fakePty();
    const controller = new BackpressureController(() => pty, HIGH, LOW);

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
