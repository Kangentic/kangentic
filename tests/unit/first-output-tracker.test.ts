import { describe, it, expect, vi, afterEach } from 'vitest';
import { FirstOutputTracker } from '../../src/main/pty/lifecycle/first-output-tracker';

describe('FirstOutputTracker', () => {
  describe('consume', () => {
    it('fires true on the first qualifying chunk', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', 'hello')).toBe(true);
    });

    it('returns false on every subsequent chunk for the same session', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', 'first')).toBe(true);
      expect(tracker.consume('s1', 'second')).toBe(false);
      expect(tracker.consume('s1', 'third')).toBe(false);
    });

    it('treats empty data as not qualifying when no detector is provided', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', '')).toBe(false);
      expect(tracker.hasEmitted('s1')).toBe(false);
      expect(tracker.consume('s1', 'real')).toBe(true);
    });

    it('delegates the qualification decision to the adapter detector', () => {
      const tracker = new FirstOutputTracker();
      const claudeDetector = (chunk: string) => chunk.includes('\x1b[?1049h');
      // Prompt output before the alternate-screen escape should not qualify
      expect(tracker.consume('s1', 'bash$ claude --resume', claudeDetector)).toBe(false);
      expect(tracker.hasEmitted('s1')).toBe(false);
      // The first chunk containing the escape qualifies
      expect(tracker.consume('s1', '\x1b[?1049hCLI booting', claudeDetector)).toBe(true);
    });

    it('tracks sessions independently', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', 'hello')).toBe(true);
      expect(tracker.consume('s2', 'hello')).toBe(true);
      expect(tracker.consume('s1', 'again')).toBe(false);
      expect(tracker.consume('s2', 'again')).toBe(false);
    });
  });

  describe('hasEmitted', () => {
    it('reflects consume outcome', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.hasEmitted('s1')).toBe(false);
      tracker.consume('s1', 'hello');
      expect(tracker.hasEmitted('s1')).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('removeSession lets a reused ID fire again', () => {
      const tracker = new FirstOutputTracker();
      tracker.consume('s1', 'hello');
      tracker.removeSession('s1');
      expect(tracker.hasEmitted('s1')).toBe(false);
      expect(tracker.consume('s1', 'hello again')).toBe(true);
    });

    it('clear drops all sessions', () => {
      const tracker = new FirstOutputTracker();
      tracker.consume('s1', 'a');
      tracker.consume('s2', 'b');
      tracker.clear();
      expect(tracker.hasEmitted('s1')).toBe(false);
      expect(tracker.hasEmitted('s2')).toBe(false);
    });
  });

  // snapshot() backs SessionManager.getFirstOutputCache(), which lets the
  // renderer rebuild sessionFirstOutput after an HMR reload.
  describe('snapshot', () => {
    it('reflects sessions that have emitted, and tracks removal/clear', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.snapshot()).toEqual([]);

      tracker.consume('s1', 'hello');
      tracker.consume('s2', 'world');
      expect(tracker.snapshot().sort()).toEqual(['s1', 's2']);

      tracker.removeSession('s1');
      expect(tracker.snapshot()).toEqual(['s2']);

      tracker.clear();
      expect(tracker.snapshot()).toEqual([]);
    });

    it('excludes a session whose chunk did not qualify', () => {
      const tracker = new FirstOutputTracker();
      tracker.consume('s1', '', () => false);
      expect(tracker.snapshot()).toEqual([]);
    });
  });

  // SessionManager's launch-overlay latch arms this as the backstop for an
  // agent that never shows the evidence it waits for.
  describe('armCeiling', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs the callback once the ceiling passes with nothing emitted', () => {
      vi.useFakeTimers();
      const tracker = new FirstOutputTracker();
      const onCeiling = vi.fn();
      tracker.armCeiling('s1', 1000, onCeiling);
      vi.advanceTimersByTime(999);
      expect(onCeiling).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onCeiling).toHaveBeenCalledTimes(1);
    });

    it('is cancelled by markEmitted, removeSession, disarmCeiling and clear', () => {
      vi.useFakeTimers();
      const tracker = new FirstOutputTracker();
      const onCeiling = vi.fn();
      tracker.armCeiling('emitted', 1000, onCeiling);
      tracker.armCeiling('removed', 1000, onCeiling);
      tracker.armCeiling('disarmed', 1000, onCeiling);
      tracker.markEmitted('emitted');
      tracker.removeSession('removed');
      tracker.disarmCeiling('disarmed');
      vi.advanceTimersByTime(5000);
      expect(onCeiling).not.toHaveBeenCalled();

      tracker.armCeiling('cleared', 1000, onCeiling);
      tracker.clear();
      vi.advanceTimersByTime(5000);
      expect(onCeiling).not.toHaveBeenCalled();
    });

    it('is a no-op for a session that already emitted or is already armed', () => {
      vi.useFakeTimers();
      const tracker = new FirstOutputTracker();
      const first = vi.fn();
      const second = vi.fn();
      tracker.markEmitted('emitted');
      tracker.armCeiling('emitted', 1000, first);
      tracker.armCeiling('armed', 1000, first);
      tracker.armCeiling('armed', 1000, second);
      vi.advanceTimersByTime(1000);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });
  });
});
