/**
 * Unit tests for the behavioral gaps in useTerminal.ts's scrollback replay
 * orchestration (initTerminal + reloadScrollback paths).
 *
 * These tests exercise the orchestration logic directly - no React, no xterm,
 * no DOM - because all of it is purely about Promise sequencing, ref
 * mutation, and generation-guard arithmetic. The hook extracts cleanly into a
 * standalone helper for testing.
 *
 * Gaps covered:
 *   1. reloadScrollback overlay-lift: always calls getScrollback (no suppressScrollback
 *      gate), writes result to xterm, and clears scrollbackPendingRef.
 *   2. Stale-generation guard (outer .then): when a second call fires before
 *      the first Promise.all resolves, the first call bails at the generation
 *      check without clobbering pending owned by the newer call.
 *   3. IPC rejection path: when either IPC rejects, scrollbackPendingRef
 *      clears so onData is unblocked.
 *   4. afterWrite generation guard: a stale generation's deferred afterWrite
 *      (the chunked-write completion callback) is a no-op, so an abandoned
 *      replay can never clobber a newer one's pending/fit/focus.
 *   5. Stuck-replay watchdog: if the chunked write's completion callback never
 *      fires, a backstop timer force-clears pending and resumes the incoming
 *      queue so live output isn't dropped indefinitely.
 *   6. Settle notification (settleScrollback): every terminal settle path
 *      (afterWrite, catch, watchdog) funnels through one helper that clears
 *      pending, kicks the queue (except on catch), and THEN notifies
 *      onScrollbackSettled - the signal TerminalTab uses to lift its replay
 *      veil. Exactly one notification per completed operation; a stale
 *      generation never notifies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// We replicate the observable contract:
//   - scrollbackPendingRef starts true on entry
//   - getScrollback is / is not called based on suppressScrollback
//   - a stale generation's outer resolve bails WITHOUT touching pending
//     (bare return - the newer generation owns clearing it)
//   - afterWrite (the chunked-write completion) itself re-checks the
//     generation before running any side effect or clearing pending
//   - a watchdog timer force-clears a stuck replay and resumes the queue
//
// onWrite mirrors writeChunkedToTerminal(term, scrollback, afterWrite): the
// test controls exactly when (or whether) afterWrite fires.
// ---------------------------------------------------------------------------

const SCROLLBACK_WATCHDOG_MS = 5000;

interface Refs {
  scrollbackPendingRef: { current: boolean };
  scrollbackGenerationRef: { current: number };
  scrollbackWatchdogRef: { current: ReturnType<typeof setTimeout> | null };
}

interface MockIpc {
  resize: () => Promise<void>;
  getScrollback: () => Promise<string | null>;
}

interface PathHooks {
  onWrite: (scrollback: string, afterWrite: () => void) => void;
  /** Represents the fit/restoreScroll/focus side effects, run only when the
   *  generation guard passes. */
  onEffects?: () => void;
  /** Represents incomingResumeRef.current?.() - the incoming queue's kick(). */
  onResume?: () => void;
  /** Represents onScrollbackSettledRef.current?.() - the settle notification
   *  TerminalTab uses to lift its replay veil. */
  onSettled?: () => void;
}

/** Mirrors useTerminal's settleScrollback chokepoint. Ordering is load-bearing:
 *  pending clears BEFORE the kick (the incoming queue's shouldHold reads it),
 *  and the settle notification fires AFTER the kick. The catch paths pass
 *  shouldKickIncomingQueue=false. */
function makeSettleScrollback(
  refs: Refs,
  onResume: () => void,
  onSettled: () => void,
): (shouldKickIncomingQueue: boolean) => void {
  return (shouldKickIncomingQueue: boolean) => {
    refs.scrollbackPendingRef.current = false;
    if (shouldKickIncomingQueue) onResume();
    onSettled();
  };
}

function armWatchdog(refs: Refs, scrollbackGeneration: number, settleScrollback: (shouldKickIncomingQueue: boolean) => void): void {
  if (refs.scrollbackWatchdogRef.current) clearTimeout(refs.scrollbackWatchdogRef.current);
  refs.scrollbackWatchdogRef.current = setTimeout(() => {
    refs.scrollbackWatchdogRef.current = null;
    if (refs.scrollbackGenerationRef.current === scrollbackGeneration && refs.scrollbackPendingRef.current) {
      // Invalidate the generation so a merely-delayed (not dropped) afterWrite
      // for this replay bails at its generation guard instead of re-running its
      // side effects after the watchdog already force-recovered.
      refs.scrollbackGenerationRef.current += 1;
      settleScrollback(true);
    }
  }, SCROLLBACK_WATCHDOG_MS);
}

function clearWatchdog(refs: Refs): void {
  if (refs.scrollbackWatchdogRef.current) {
    clearTimeout(refs.scrollbackWatchdogRef.current);
    refs.scrollbackWatchdogRef.current = null;
  }
}

/** Mirrors the reloadScrollback path (no suppressScrollback gate). */
async function runReloadScrollbackPath(refs: Refs, ipc: MockIpc, hooks: PathHooks): Promise<void> {
  const onResume = hooks.onResume ?? (() => {});
  const onSettled = hooks.onSettled ?? (() => {});
  const settleScrollback = makeSettleScrollback(refs, onResume, onSettled);
  refs.scrollbackPendingRef.current = true;
  const scrollbackGeneration = ++refs.scrollbackGenerationRef.current;
  armWatchdog(refs, scrollbackGeneration, settleScrollback);

  const resizePromise = ipc.resize();
  const scrollbackPromise = ipc.getScrollback();

  return Promise.all([resizePromise, scrollbackPromise])
    .then(([, scrollback]) => {
      // A newer scrollback operation has started; it owns clearing pending
      // (and the watchdog it armed), so this stale resolve must not touch
      // either.
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;

      const afterWrite = () => {
        // A newer replay may have started while this chunked write was in
        // flight; abandon so we don't clobber its pending/fit/focus.
        if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;
        clearWatchdog(refs);
        hooks.onEffects?.();
        settleScrollback(true);
      };
      if (scrollback) {
        hooks.onWrite(scrollback, afterWrite);
      } else {
        afterWrite();
      }
    })
    .catch(() => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;
      clearWatchdog(refs);
      settleScrollback(false);
    });
}

/** Mirrors the initTerminal scrollback path (suppressScrollback fast-path to null). */
async function runInitScrollbackPath(
  refs: Refs,
  ipc: MockIpc,
  suppressScrollback: boolean,
  hooks: PathHooks,
): Promise<void> {
  const onResume = hooks.onResume ?? (() => {});
  const onSettled = hooks.onSettled ?? (() => {});
  const settleScrollback = makeSettleScrollback(refs, onResume, onSettled);
  refs.scrollbackPendingRef.current = true;
  const scrollbackGeneration = ++refs.scrollbackGenerationRef.current;
  armWatchdog(refs, scrollbackGeneration, settleScrollback);

  const resizePromise = ipc.resize();
  const scrollbackPromise = suppressScrollback
    ? Promise.resolve<string | null>(null)
    : ipc.getScrollback();

  return Promise.all([resizePromise, scrollbackPromise])
    .then(([, scrollback]) => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;

      const afterWrite = () => {
        if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;
        clearWatchdog(refs);
        hooks.onEffects?.();
        settleScrollback(true);
      };
      if (scrollback) {
        hooks.onWrite(scrollback, afterWrite);
      } else {
        afterWrite();
      }
    })
    .catch(() => {
      if (refs.scrollbackGenerationRef.current !== scrollbackGeneration) return;
      clearWatchdog(refs);
      settleScrollback(false);
    });
}

/** A synchronous chunked-write stand-in: calls afterWrite immediately, and
 *  (optionally) records the written scrollback. */
function syncWrite(onWritten?: (scrollback: string) => void): PathHooks['onWrite'] {
  return (scrollback, afterWrite) => {
    onWritten?.(scrollback);
    afterWrite();
  };
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
      scrollbackWatchdogRef: makeRef(null),
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

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      expect(ipc.getScrollback).toHaveBeenCalledOnce();
    });

    it('writes scrollback content to xterm', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('line1\r\nline2'),
      };
      const written: string[] = [];

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite((s) => written.push(s)) });

      expect(written).toEqual(['line1\r\nline2']);
    });

    it('clears scrollbackPendingRef after successful write', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('some output'),
      };

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('clears scrollbackPendingRef even when scrollback is empty', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(''),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, { onWrite });

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

      const pathPromise = runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

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

      await runInitScrollbackPath(refs, ipc, true, { onWrite: syncWrite() });

      expect(ipc.getScrollback).not.toHaveBeenCalled();
    });

    it('clears scrollbackPendingRef even on the suppress path', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(null),
      };

      await runInitScrollbackPath(refs, ipc, true, { onWrite: syncWrite() });

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('calls getScrollback when suppressScrollback=false', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('terminal content'),
      };
      const written: string[] = [];

      await runInitScrollbackPath(refs, ipc, false, { onWrite: syncWrite((s) => written.push(s)) });

      expect(ipc.getScrollback).toHaveBeenCalledOnce();
      expect(written).toEqual(['terminal content']);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 2: Stale-generation guard (outer .then)
  // -------------------------------------------------------------------------
  describe('stale-generation guard (outer resolve)', () => {
    it('bails out when generation increments before Promise.all resolves', async () => {
      let resolveFirst!: () => void;
      const written: string[] = [];
      const ipc: MockIpc = {
        resize: vi.fn().mockImplementation(() =>
          new Promise<void>((resolve) => { resolveFirst = resolve; })
        ),
        getScrollback: vi.fn().mockResolvedValue('first scrollback'),
      };

      // Start first path - it's pending on resize
      const firstPath = runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite((s) => written.push(s)) });

      // A second path fires and increments the generation counter
      const secondIpc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('second scrollback'),
      };
      await runReloadScrollbackPath(refs, secondIpc, { onWrite: syncWrite((s) => written.push(s)) });

      // Now resolve the first path's resize - it should bail at generation check
      resolveFirst();
      await firstPath;

      // Written once (for the second path), not twice
      expect(written).toEqual(['second scrollback']);
    });

    it('leaves scrollbackPendingRef=false after stale bail-out (second path cleared it)', async () => {
      let resolveFirst!: () => void;
      const ipc: MockIpc = {
        resize: vi.fn().mockImplementation(() =>
          new Promise<void>((resolve) => { resolveFirst = resolve; })
        ),
        getScrollback: vi.fn().mockResolvedValue('stale output'),
      };

      const firstPath = runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      const secondIpc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('fresh output'),
      };
      await runReloadScrollbackPath(refs, secondIpc, { onWrite: syncWrite() });

      resolveFirst();
      await firstPath;

      // The second path already cleared the flag; the stale bail-out must not
      // set it back to true (nor re-clear it, though false->false is moot).
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('does not bail out when generation matches (single-path case)', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('the output'),
      };
      const written: string[] = [];

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite((s) => written.push(s)) });

      expect(written).toEqual(['the output']);
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('a stale outer resolve does NOT clear pending while a newer replay is still in flight (regression: the resolve-path clobber)', async () => {
      let resolveFirstScrollback!: (value: string | null) => void;
      const ipcA: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockImplementation(() =>
          new Promise<string | null>((resolve) => { resolveFirstScrollback = resolve; })
        ),
      };
      const pathA = runReloadScrollbackPath(refs, ipcA, { onWrite: syncWrite() });

      // Path B starts before A's IPC resolves (bumping the generation) and
      // itself stays pending - its own IPC has not resolved either.
      let resolveSecondScrollback!: (value: string | null) => void;
      const ipcB: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockImplementation(() =>
          new Promise<string | null>((resolve) => { resolveSecondScrollback = resolve; })
        ),
      };
      const pathB = runReloadScrollbackPath(refs, ipcB, { onWrite: syncWrite() });

      // A's IPC now resolves (a stale generation). Its outer .then must bail
      // without touching pending - B still owns it and hasn't finished.
      resolveFirstScrollback('stale frame');
      await pathA;
      expect(refs.scrollbackPendingRef.current).toBe(true);

      // B finishes and clears it.
      resolveSecondScrollback('fresh frame');
      await pathB;
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 4: afterWrite generation guard (the chunked-write completion callback)
  // -------------------------------------------------------------------------
  describe('afterWrite generation guard', () => {
    it('a stale generation\'s deferred afterWrite is a no-op and cannot clobber a newer in-flight replay', async () => {
      let capturedAfterWriteA!: () => void;
      const effectsA = vi.fn();
      const resumeA = vi.fn();

      const ipcA: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('stale frame'),
      };

      // Path A's IPC resolves and its outer .then body runs (capturing
      // afterWrite), but the chunked write's completion is held by the test -
      // simulating an in-flight xterm.write callback that hasn't fired yet.
      await runReloadScrollbackPath(refs, ipcA, {
        onWrite: (_scrollback, afterWrite) => { capturedAfterWriteA = afterWrite; },
        onEffects: effectsA,
        onResume: resumeA,
      });
      expect(refs.scrollbackPendingRef.current).toBe(true);

      // Path B starts (bumps the generation) while A's write is still pending.
      const effectsB = vi.fn();
      const resumeB = vi.fn();
      const ipcB: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('fresh frame'),
      };
      const pathB = runReloadScrollbackPath(refs, ipcB, {
        onWrite: syncWrite(),
        onEffects: effectsB,
        onResume: resumeB,
      });

      // A's write finally "completes" - its afterWrite must be a no-op now:
      // no fit/scroll/focus side effect, no queue resume, no pending clear.
      capturedAfterWriteA();
      expect(effectsA).not.toHaveBeenCalled();
      expect(resumeA).not.toHaveBeenCalled();
      expect(refs.scrollbackPendingRef.current).toBe(true);

      await pathB;

      // B owns clearing it.
      expect(effectsB).toHaveBeenCalledOnce();
      expect(resumeB).toHaveBeenCalledOnce();
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

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('clears scrollbackPendingRef when getScrollback rejects', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockRejectedValue(new Error('ipc error')),
      };

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('clears scrollbackPendingRef when both IPCs reject simultaneously', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockRejectedValue(new Error('resize failed')),
        getScrollback: vi.fn().mockRejectedValue(new Error('scrollback failed')),
      };

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('does not call onWrite when an IPC rejects', async () => {
      const ipc: MockIpc = {
        resize: vi.fn().mockRejectedValue(new Error('killed')),
        getScrollback: vi.fn().mockResolvedValue('output'),
      };
      const onWrite = vi.fn();

      await runReloadScrollbackPath(refs, ipc, { onWrite });

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
      const firstPath = runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite() });

      // Fresh second path completes and sets pending=false
      const secondIpc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('fresh'),
      };
      await runReloadScrollbackPath(refs, secondIpc, { onWrite: syncWrite() });

      // Reject the stale first path - the catch guard checks generation mismatch
      rejectFirst(new Error('killed after second started'));
      await firstPath;

      // Still false - the stale rejection should not have re-set the flag
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 5: stuck-replay watchdog
  // -------------------------------------------------------------------------
  describe('scrollback watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('force-clears pending and resumes the queue if the chunked write never completes', async () => {
      const resume = vi.fn();
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('stuck frame'),
      };

      await runReloadScrollbackPath(refs, ipc, {
        // Never invokes afterWrite - simulates a dropped xterm.write callback.
        onWrite: () => {},
        onResume: resume,
      });
      expect(refs.scrollbackPendingRef.current).toBe(true);
      expect(resume).not.toHaveBeenCalled();

      vi.runAllTimers();

      expect(refs.scrollbackPendingRef.current).toBe(false);
      expect(resume).toHaveBeenCalledOnce();
    });

    it('does not fire for a generation that has already been superseded', async () => {
      const resumeA = vi.fn();
      const ipcA: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('stuck frame'),
      };
      await runReloadScrollbackPath(refs, ipcA, {
        onWrite: () => {},
        onResume: resumeA,
      });

      // A newer replay starts and arms its own watchdog, canceling A's timer.
      const resumeB = vi.fn();
      const ipcB: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('fresh frame'),
      };
      await runReloadScrollbackPath(refs, ipcB, {
        onWrite: syncWrite(),
        onResume: resumeB,
      });
      expect(refs.scrollbackPendingRef.current).toBe(false);

      // Advancing time must not touch anything: B already completed and
      // cleared its own timer, and A's timer was canceled when B armed.
      vi.runAllTimers();
      expect(resumeA).not.toHaveBeenCalled();
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('a healthy replay clears its own watchdog before it can fire', async () => {
      const resume = vi.fn();
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('normal frame'),
      };

      await runReloadScrollbackPath(refs, ipc, { onWrite: syncWrite(), onResume: resume });
      expect(refs.scrollbackPendingRef.current).toBe(false);

      vi.runAllTimers();

      // The watchdog was already canceled by afterWrite; running timers must
      // not invoke the resume callback a second time.
      expect(resume).toHaveBeenCalledOnce();
    });

    it('a later-arriving afterWrite for a force-recovered generation is a no-op (does not re-run effects/resume or re-clear pending)', async () => {
      const effects = vi.fn();
      const resume = vi.fn();
      let capturedAfterWrite!: () => void;
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('stuck frame'),
      };

      // The chunked write captures afterWrite but never calls it - the
      // watchdog's "never completes" case, except this write eventually DOES
      // complete, just after the watchdog already force-recovered.
      await runReloadScrollbackPath(refs, ipc, {
        onWrite: (_scrollback, afterWrite) => { capturedAfterWrite = afterWrite; },
        onEffects: effects,
        onResume: resume,
      });
      expect(refs.scrollbackPendingRef.current).toBe(true);
      expect(effects).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();

      // The watchdog fires: force-recovers and bumps the generation.
      vi.runAllTimers();
      expect(refs.scrollbackPendingRef.current).toBe(false);
      expect(resume).toHaveBeenCalledOnce();
      expect(effects).not.toHaveBeenCalled();

      // The delayed (not dropped) write finally completes. Its afterWrite
      // must be a no-op: the watchdog already bumped scrollbackGenerationRef,
      // so afterWrite's own generation guard bails before running effects,
      // resuming the queue again, or touching pending a second time.
      capturedAfterWrite();
      expect(effects).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledOnce();
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 6: settle notification (the replay-veil lift signal)
  // -------------------------------------------------------------------------
  describe('settle notification (onScrollbackSettled)', () => {
    it('fires exactly once after a successful replay, after the queue resume', async () => {
      const callOrder: string[] = [];
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('replayed frame'),
      };

      await runInitScrollbackPath(refs, ipc, false, {
        onWrite: syncWrite(),
        onResume: () => callOrder.push('resume'),
        onSettled: () => {
          callOrder.push('settled');
          // Pending must already be false when the notification fires: the
          // reveal render it schedules must not race the drop/hold gate.
          expect(refs.scrollbackPendingRef.current).toBe(false);
        },
      });

      expect(callOrder).toEqual(['resume', 'settled']);
    });

    it('fires on the empty-scrollback path', async () => {
      const settled = vi.fn();
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(''),
      };

      await runReloadScrollbackPath(refs, ipc, { onWrite: vi.fn(), onSettled: settled });

      expect(settled).toHaveBeenCalledOnce();
    });

    it('fires on the suppressed (cold-start) init path', async () => {
      const settled = vi.fn();
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('never fetched'),
      };

      await runInitScrollbackPath(refs, ipc, true, { onWrite: vi.fn(), onSettled: settled });

      expect(ipc.getScrollback).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledOnce();
    });

    it('fires on IPC rejection, without a queue resume', async () => {
      const settled = vi.fn();
      const resume = vi.fn();
      const ipc: MockIpc = {
        resize: vi.fn().mockRejectedValue(new Error('session killed')),
        getScrollback: vi.fn().mockResolvedValue('output'),
      };

      await runInitScrollbackPath(refs, ipc, false, {
        onWrite: syncWrite(),
        onResume: resume,
        onSettled: settled,
      });

      expect(settled).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      expect(refs.scrollbackPendingRef.current).toBe(false);
    });

    it('fires on watchdog force-recovery', async () => {
      vi.useFakeTimers();
      const settled = vi.fn();
      const ipc: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('stuck frame'),
      };

      await runInitScrollbackPath(refs, ipc, false, {
        // Never invokes afterWrite - simulates a dropped xterm.write callback.
        onWrite: () => {},
        onSettled: settled,
      });
      expect(settled).not.toHaveBeenCalled();

      vi.runAllTimers();
      expect(settled).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('does not fire from a stale generation: exactly one settle when a reload supersedes the mount replay', async () => {
      let capturedAfterWriteA!: () => void;
      const settledA = vi.fn();
      const ipcA: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('mount replay frame'),
      };

      // The mount replay's chunked write is held in flight.
      await runInitScrollbackPath(refs, ipcA, false, {
        onWrite: (_scrollback, afterWrite) => { capturedAfterWriteA = afterWrite; },
        onSettled: settledA,
      });
      expect(settledA).not.toHaveBeenCalled();

      // A reload supersedes it (e.g. overlay lift) and completes.
      const settledB = vi.fn();
      const ipcB: MockIpc = {
        resize: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue('reload frame'),
      };
      await runReloadScrollbackPath(refs, ipcB, { onWrite: syncWrite(), onSettled: settledB });
      expect(settledB).toHaveBeenCalledOnce();

      // The abandoned mount replay's afterWrite finally fires: its generation
      // guard bails before the settle, so no second notification.
      capturedAfterWriteA();
      expect(settledA).not.toHaveBeenCalled();
      expect(settledB).toHaveBeenCalledOnce();
    });
  });
});
