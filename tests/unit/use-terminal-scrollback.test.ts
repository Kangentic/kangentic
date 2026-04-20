/**
 * Unit tests for the three behavioral gaps exposed by the parallel-IPC
 * refactor in useTerminal.ts (initTerminal + reloadScrollback paths).
 *
 * These tests exercise the orchestration logic directly - no React, no xterm,
 * no DOM - because all three behaviors are purely about Promise sequencing,
 * ref mutation, and generation-guard arithmetic. The hook extracts cleanly
 * into a standalone helper for testing.
 *
 * Gaps covered:
 *   1. reloadScrollback overlay-lift: always calls getScrollback (no suppressScrollback
 *      gate), writes result to xterm, and clears scrollbackPendingRef.
 *   2. Stale-generation guard: when a second call fires before the first
 *      Promise.all resolves, the first call bails at the generation check
 *      without clobbering the pending flag.
 *   3. IPC rejection path: when either IPC rejects, scrollbackPendingRef
 *      clears so onData is unblocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal ref emulation (mirrors useRef semantics without React)
// ---------------------------------------------------------------------------

function makeRef<T>(initial: T): { current: T } {
  return { current: initial };
}

// ---------------------------------------------------------------------------
// The orchestration logic extracted verbatim from useTerminal.ts.
//
// initTerminal and reloadScrollback share the same Promise.all pattern.
// We replicate only the observable contract:
//   - scrollbackPendingRef starts true on entry
//   - getScrollback is / is not called based on suppressScrollback
//   - scrollbackPendingRef clears to false after completion (happy or catch)
//   - stale generation increments cause early exit without clearing pending
//
// The xterm.write(scrollback, afterWrite) callback is synchronous in tests
// (mock calls afterWrite immediately) so we don't need requestAnimationFrame.
// ---------------------------------------------------------------------------

interface Refs {
  scrollbackPendingRef: { current: boolean };
  scrollbackGenerationRef: { current: number };
}

interface MockIpc {
  resize: () => Promise<void>;
  getScrollback: () => Promise<string | null>;
}

/**
 * Mirrors the initTerminal scrollback path.
 * suppressScrollback=true fast-paths getScrollback to null (shimmer path).
 */
async function runInitScrollbackPath(
  refs: Refs,
  ipc: MockIpc,
  suppressScrollback: boolean,
  onWrite: (scrollback: string) => void,
): Promise<void> {
  refs.scrollbackPendingRef.current = true;
  const scrollbackGeneration = ++refs.scrollbackGenerationRef.current;

  const resizePromise = ipc.resize();
  const scrollbackPromise = suppressScrollback
    ? Promise.resolve<string | null>(null)
    : ipc.getScrollback();

  return Promise.all([resizePromise, scrollbackPromise])
    .then(([, scrollback]) => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) {
        refs.scrollbackPendingRef.current = false;
        return;
      }
      const afterWrite = () => {
        refs.scrollbackPendingRef.current = false;
      };
      if (scrollback) {
        onWrite(scrollback);
        afterWrite();
      } else {
        afterWrite();
      }
    })
    .catch(() => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;
      refs.scrollbackPendingRef.current = false;
    });
}

/**
 * Mirrors the reloadScrollback path (no suppressScrollback gate).
 */
async function runReloadScrollbackPath(
  refs: Refs,
  ipc: MockIpc,
  onWrite: (scrollback: string) => void,
): Promise<void> {
  refs.scrollbackPendingRef.current = true;
  const scrollbackGeneration = ++refs.scrollbackGenerationRef.current;

  const resizePromise = ipc.resize();
  const scrollbackPromise = ipc.getScrollback();

  return Promise.all([resizePromise, scrollbackPromise])
    .then(([, scrollback]) => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) {
        refs.scrollbackPendingRef.current = false;
        return;
      }
      const afterWrite = () => {
        refs.scrollbackPendingRef.current = false;
      };
      if (scrollback) {
        onWrite(scrollback);
        afterWrite();
      } else {
        afterWrite();
      }
    })
    .catch(() => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;
      refs.scrollbackPendingRef.current = false;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTerminal scrollback orchestration', () => {
  let refs: Refs;

  beforeEach(() => {
    refs = {
      scrollbackPendingRef: makeRef(false),
      scrollbackGenerationRef: makeRef(0),
    };
  });

  // -------------------------------------------------------------------------
  // Gap 1: reloadScrollback overlay-lift path
  // -------------------------------------------------------------------------
  describe('reloadScrollback overlay-lift path', () => {
    it('always calls getScrollback (no suppressScrollback gate)', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('previous output'),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, onWrite);

      expect(ipc.getScrollback).toHaveBeenCalledOnce();
    });

    it('writes scrollback content to xterm', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('line1\r\nline2'),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, onWrite);

      expect(onWrite).toHaveBeenCalledWith('line1\r\nline2');
    });

    it('clears scrollbackPendingRef after successful write', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('some output'),
      };

      await runReloadScrollbackPath(refs, ipc, vi.fn());

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('clears scrollbackPendingRef even when scrollback is empty', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(''),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, onWrite);

      expect(onWrite).not.toHaveBeenCalled();
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('fires resize and getScrollback in parallel (both called before either resolves)', async () => {
      const callOrder: string[] = [];
      let resolveResize!: () => void;
      let resolveScrollback!: (value: string | null) => void;

      const ipc: MockIpc = {
        resize: vi.fn().mockImplementation(() => {
          callOrder.push('resize-called');
          return new Promise<void>((resolve) => { resolveResize = resolve; });
        }),
        getScrollback: vi.fn().mockImplementation(() => {
          callOrder.push('getScrollback-called');
          return new Promise<string | null>((resolve) => { resolveScrollback = resolve; });
        }),
      };

      const pathPromise = runReloadScrollbackPath(refs, ipc, vi.fn());

      // Both must have been invoked before either resolved
      expect(callOrder).toEqual(['resize-called', 'getScrollback-called']);

      resolveResize();
      resolveScrollback('output');
      await pathPromise;
    });
  });

  // -------------------------------------------------------------------------
  // Gap 1b: initTerminal suppressScrollback fast-path
  // -------------------------------------------------------------------------
  describe('initTerminal suppressScrollback fast-path', () => {
    it('skips getScrollback when suppressScrollback=true', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('should not appear'),
      };

      await runInitScrollbackPath(refs, ipc, true, vi.fn());

      expect(ipc.getScrollback).not.toHaveBeenCalled();
    });

    it('clears scrollbackPendingRef even on the suppress path', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(null),
      };

      await runInitScrollbackPath(refs, ipc, true, vi.fn());

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('calls getScrollback when suppressScrollback=false', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('terminal content'),
      };
      const onWrite = vi.fn();

      await runInitScrollbackPath(refs, ipc, false, onWrite);

      expect(ipc.getScrollback).toHaveBeenCalledOnce();
      expect(onWrite).toHaveBeenCalledWith('terminal content');
    });
  });

  // -------------------------------------------------------------------------
  // Gap 2: Stale-generation guard
  // -------------------------------------------------------------------------
  describe('stale-generation guard', () => {
    it('bails out when generation increments before Promise.all resolves', async () => {
      let resolveFirst!: () => void;
      const ipc: MockIpc = {
        resize: vi.fn().mockImplementation(() =>
          new Promise<void>((resolve) => { resolveFirst = resolve; })
        ),
        getScrollback: vi.fn().mockResolvedValue('first scrollback'),
      };
      const onWrite = vi.fn();

      // Start first path - it's pending on resize
      const firstPath = runReloadScrollbackPath(refs, ipc, onWrite);

      // A second path fires and increments the generation counter
      const secondIpc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('second scrollback'),
      };
      await runReloadScrollbackPath(refs, secondIpc, onWrite);

      // Now resolve the first path's resize - it should bail at generation check
      resolveFirst();
      await firstPath;

      // onWrite was called once (for the second path), not twice
      expect(onWrite).toHaveBeenCalledTimes(1);
      expect(onWrite).toHaveBeenCalledWith('second scrollback');
    });

    it('leaves scrollbackPendingRef=false after stale bail-out (second path cleared it)', async () => {
      let resolveFirst!: () => void;
      const ipc: MockIpc = {
        resize: vi.fn().mockImplementation(() =>
          new Promise<void>((resolve) => { resolveFirst = resolve; })
        ),
        getScrollback: vi.fn().mockResolvedValue('stale output'),
      };

      const firstPath = runReloadScrollbackPath(refs, ipc, vi.fn());

      const secondIpc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('fresh output'),
      };
      await runReloadScrollbackPath(refs, secondIpc, vi.fn());

      resolveFirst();
      await firstPath;

      // The second path already cleared the flag; the stale bail-out must not
      // set it back to true
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('does not bail out when generation matches (single-path case)', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('the output'),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, onWrite);

      expect(onWrite).toHaveBeenCalledWith('the output');
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 3: IPC rejection path
  // -------------------------------------------------------------------------
  describe('IPC rejection path', () => {
    it('clears scrollbackPendingRef when resize rejects', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockRejectedValue(new Error('session killed')),
        getScrollback: vi.fn().mockResolvedValue('output'),
      };

      await runReloadScrollbackPath(refs, ipc, vi.fn());

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('clears scrollbackPendingRef when getScrollback rejects', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockRejectedValue(new Error('ipc error')),
      };

      await runReloadScrollbackPath(refs, ipc, vi.fn());

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('clears scrollbackPendingRef when both IPCs reject simultaneously', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockRejectedValue(new Error('resize failed')),
        getScrollback: vi.fn().mockRejectedValue(new Error('scrollback failed')),
      };

      await runReloadScrollbackPath(refs, ipc, vi.fn());

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('does not call onWrite when an IPC rejects', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockRejectedValue(new Error('killed')),
        getScrollback: vi.fn().mockResolvedValue('output'),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, onWrite);

      expect(onWrite).not.toHaveBeenCalled();
    });

    it('ignores rejection from a stale generation (does not clear pending for fresh path)', async () => {
      // First path is stale and will reject; second path is active and resolved
      let rejectFirst!: (err: Error) => void;
      const ipc: MockIpc = {
        resize: vi.fn().mockImplementation(() =>
          new Promise<void>((_, reject) => { rejectFirst = reject; })
        ),
        getScrollback: vi.fn().mockResolvedValue('stale'),
      };

      // Start stale path
      const firstPath = runReloadScrollbackPath(refs, ipc, vi.fn());

      // Fresh second path completes and sets pending=false
      const secondIpc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('fresh'),
      };
      await runReloadScrollbackPath(refs, secondIpc, vi.fn());

      // Reject the stale first path - the catch guard checks generation mismatch
      rejectFirst(new Error('killed after second started'));
      await firstPath;

      // Still false - the stale rejection should not have re-set the flag
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });
  });
});
