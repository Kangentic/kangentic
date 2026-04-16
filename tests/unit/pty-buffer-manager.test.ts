import { describe, it, expect, vi } from 'vitest';
import { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';

describe('PtyBufferManager', () => {
  const SESSION = 'test-session';

  function createManager() {
    const onFlush = vi.fn();
    const manager = new PtyBufferManager({ onFlush });
    manager.initSession(SESSION, '', 80);
    // Simulate the initial resize that establishes real terminal dimensions.
    // This mirrors what the renderer does on first connection (fit + resize).
    manager.onResize(SESSION, 80);
    return { manager, onFlush };
  }

  describe('getScrollback drains pending buffer', () => {
    it('prevents stale flush after scrollback is consumed', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      // Simulate PTY data arriving (queues a 16ms flush)
      manager.onData(SESSION, 'hello world');

      // Renderer calls getScrollback before the flush fires
      const scrollback = manager.getScrollback(SESSION);
      expect(scrollback).toContain('hello world');

      // Advance past the 16ms timer - flush should find empty buffer
      vi.advanceTimersByTime(20);
      expect(onFlush).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('onResize tracks col changes', () => {
    it('reports colsChanged when width changes', () => {
      const { manager } = createManager();

      // Resize to different cols
      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(true);
    });

    it('preserves scrollback when cols change (read-time strip, no write-time clear)', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'content at old width');
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalled();

      // Resize to different cols - scrollback preserved
      manager.onResize(SESSION, 120);
      expect(manager.getScrollback(SESSION)).toContain('content at old width');

      vi.useRealTimers();
    });

    it('keeps buffer when cols stay the same', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'some data');

      // Resize with same cols (e.g. rows-only change)
      const colsChanged = manager.onResize(SESSION, 80);
      expect(colsChanged).toBe(false);

      // Buffer should still flush
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledWith(SESSION, 'some data');

      vi.useRealTimers();
    });

    it('returns false for unknown session', () => {
      const { manager } = createManager();
      expect(manager.onResize('nonexistent', 100)).toBe(false);
    });
  });

  describe('post-drain data flows normally', () => {
    it('flushes new data arriving after getScrollback drained the buffer', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'first chunk');
      manager.getScrollback(SESSION);

      // Advance to clear the old timer
      vi.advanceTimersByTime(20);
      expect(onFlush).not.toHaveBeenCalled();

      // New data should schedule a new flush and deliver normally
      manager.onData(SESSION, 'second chunk');
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledWith(SESSION, 'second chunk');

      vi.useRealTimers();
    });
  });

  describe('initial resize preserves carried-over scrollback', () => {
    it('does not clear scrollback on the first resize after initSession', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      // Simulate a resumed session with carried-over scrollback
      manager.initSession(SESSION, 'previous session output', 0);

      // First resize (renderer establishing container dimensions) must NOT clear
      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
    });

    it('preserves scrollback on second resize with different cols', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      manager.initSession(SESSION, 'previous session output', 0);

      // First resize: establishes dimensions
      manager.onResize(SESSION, 120);

      // Add some live data at the current width
      manager.onData(SESSION, 'live data');

      // Second resize: user resizes window to different width
      // Scrollback is no longer cleared on resize (KISS read-time strip)
      const colsChanged = manager.onResize(SESSION, 200);
      expect(colsChanged).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
    });

    it('does not clear scrollback on second resize with same cols', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      manager.initSession(SESSION, 'previous session output', 0);

      // First resize
      manager.onResize(SESSION, 120);
      // Add live data
      manager.onData(SESSION, ' plus new data');

      // Second resize with same cols (rows-only change)
      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
      expect(manager.getScrollback(SESSION)).toContain('plus new data');
    });

    it('fresh session with empty scrollback is unaffected by initial resize', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      manager.initSession(SESSION, '', 0);

      // First resize: cols change from 0 to 120 but scrollback is empty
      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toBe('');
    });
  });

  describe('getScrollback with no pending buffer', () => {
    it('returns scrollback when buffer is already empty', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, 'data');
      // Let the flush fire normally
      vi.advanceTimersByTime(20);

      // Buffer is now empty, but scrollback still has the data
      const scrollback = manager.getScrollback(SESSION);
      expect(scrollback).toContain('data');

      vi.useRealTimers();
    });

    it('returns empty string for session with no data', () => {
      const { manager } = createManager();
      expect(manager.getScrollback(SESSION)).toBe('');
    });
  });
});
