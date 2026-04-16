import { describe, it, expect } from 'vitest';
import { ResizeManager } from '../../src/main/pty/lifecycle/resize-manager';

describe('ResizeManager', () => {
  describe('shouldNotifyOnData', () => {
    it('notifies on fresh content when no resize has occurred', () => {
      const manager = new ResizeManager();
      const notify = manager.shouldNotifyOnData('s1', 'hello world', 'idle');
      expect(notify).toBe(true);
    });

    it('suppresses empty or whitespace-only chunks', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', '', 'idle')).toBe(false);
      expect(manager.shouldNotifyOnData('s1', '   \n\t ', 'idle')).toBe(false);
    });

    it('suppresses a duplicate normalized frame', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', 'hello world', 'idle')).toBe(true);
      expect(manager.shouldNotifyOnData('s1', 'hello   world', 'idle')).toBe(false);
    });

    it('treats ANSI-only differences as duplicates', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', 'hello world', 'idle')).toBe(true);
      const withAnsi = '\x1b[2Jhello \x1b[0mworld';
      expect(manager.shouldNotifyOnData('s1', withAnsi, 'idle')).toBe(false);
    });

    it('suppresses new frames within the grace window when already woken and idle', () => {
      const manager = new ResizeManager();
      // Wake the session
      expect(manager.shouldNotifyOnData('s1', 'first chunk', 'idle', 1000)).toBe(true);
      // Resize now
      manager.notifyResize('s1', 2000);
      // New content arrives 500ms after resize, session still idle
      const notify = manager.shouldNotifyOnData('s1', 'redraw frame', 'idle', 2500);
      expect(notify).toBe(false);
    });

    it('does NOT suppress when session is thinking even within the grace window', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', 'first', 'idle', 1000)).toBe(true);
      manager.notifyResize('s1', 2000);
      const notify = manager.shouldNotifyOnData('s1', 'real work output', 'thinking', 2500);
      expect(notify).toBe(true);
    });

    it('does NOT suppress the very first wake even inside a grace window', () => {
      // A never-woken session inside a grace window must still wake. Grace
      // period only applies to sessions that were already settled-idle.
      const manager = new ResizeManager();
      manager.notifyResize('s1', 1000);
      const notify = manager.shouldNotifyOnData('s1', 'first output ever', 'idle', 1500);
      expect(notify).toBe(true);
    });

    it('notifies again once the grace window has passed', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', 'first', 'idle', 1000)).toBe(true);
      manager.notifyResize('s1', 2000);
      // Just under the grace window - still suppressed
      expect(manager.shouldNotifyOnData('s1', 'early', 'idle', 3000)).toBe(false);
      // Past the 1500ms grace window - notification resumes
      expect(manager.shouldNotifyOnData('s1', 'late', 'idle', 4000)).toBe(true);
    });

    it('keeps dedup history per-session', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', 'shared content', 'idle')).toBe(true);
      // Same text on a different session is still fresh there.
      expect(manager.shouldNotifyOnData('s2', 'shared content', 'idle')).toBe(true);
    });

    it('caps the dedup ring buffer at 16 frames', () => {
      const manager = new ResizeManager();
      // Fill 17 distinct frames
      for (let index = 0; index < 17; index++) {
        expect(manager.shouldNotifyOnData('s1', `frame-${index}`, 'idle')).toBe(true);
      }
      // Frame 0 should have been evicted, so re-sending it reads as fresh
      expect(manager.shouldNotifyOnData('s1', 'frame-0', 'idle')).toBe(true);
      // Frame 16 (the newest) is still in the buffer
      expect(manager.shouldNotifyOnData('s1', 'frame-16', 'idle')).toBe(false);
    });
  });

  describe('removeSession', () => {
    it('clears all per-session state so IDs can be reused', () => {
      const manager = new ResizeManager();
      expect(manager.shouldNotifyOnData('s1', 'content', 'idle')).toBe(true);
      manager.notifyResize('s1', 1000);
      manager.removeSession('s1');
      // After removal, a new session with the same ID starts clean:
      // duplicate content is fresh again and no grace window is active.
      expect(manager.shouldNotifyOnData('s1', 'content', 'idle', 1200)).toBe(true);
    });
  });
});
