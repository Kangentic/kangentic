/**
 * Unit tests for src/main/pty/paste-engine.ts.
 *
 * Engine contract (event-driven, deterministic via post-submit verification):
 *
 *   1. await drain() to clear pending writeQueue bytes
 *   2. CHUNKED writeRaw of paste packet (1024-byte chunks with
 *      setImmediate yields between)
 *   3. Wait for output-settle: first `data` event, then 250ms idle.
 *      Cap at SETTLE_CAP_MIN_MS + payloadLength * 0.5ms. Floor at
 *      MIN_GAP_MS (1000ms) for React commit.
 *   4. Submit `\r` via the QUEUE (sessionManager.write), then drain.
 *   5. Wait for SUBMISSION VERIFICATION: optional verifier callback returns
 *      true, OR `activity` event with non-idle state, OR new `data` bytes
 *      for our session, within 3s. If timeout, retry `\r` once with a 2s
 *      window. If still no verification, throw PasteSubmitError('no-submission-evidence').
 *
 * The verification step is what makes the engine deterministic instead of
 * timing-dependent. A stray `\r` with empty input is a TUI no-op, so
 * retrying is safe even when the original DID submit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPasteEngine, sanitizeForPaste, PasteSubmitError } from '../../src/main/pty/paste-engine';
import type { SubmissionVerifier } from '../../src/shared/types';

class MockSessionManager extends EventEmitter {
  writeRawCalls: Array<{ id: string; data: string }> = [];
  writeCalls: Array<{ id: string; data: string }> = [];
  drainResolvers: Array<() => void> = [];

  drain(_id: string): Promise<void> {
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  write(id: string, data: string): void {
    this.writeCalls.push({ id, data });
  }

  writeRaw(id: string, data: string): void {
    this.writeRawCalls.push({ id, data });
  }

  flushDrain(): void {
    const pending = this.drainResolvers.splice(0, this.drainResolvers.length);
    for (const resolve of pending) resolve();
  }

  emitData(sessionId: string, chunk: string): void {
    // Mirror the real SessionManager fan-out for a FOCUSED session: the
    // unconditional 'data-tap' first, then the renderer-gated 'data',
    // back-to-back for the same bytes (session-manager.ts onFlush). The
    // engine listens on 'data-tap'; the unfocused test emits it alone.
    this.emit('data-tap', sessionId, chunk);
    this.emit('data', sessionId, chunk);
  }

  emitActivity(sessionId: string, activity: string): void {
    this.emit('activity', sessionId, activity, false);
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Drain `setImmediate` callbacks queued by writeChunked between chunks.
 * Each yield is a microtask boundary, not a timer, so vi.advanceTimersByTime
 * does not advance through them - we need real ticks.
 */
async function flushSetImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('sanitizeForPaste', () => {
  it('strips lone CR', () => {
    expect(sanitizeForPaste('hello\rworld')).toBe('hello\nworld');
  });
  it('normalizes CRLF to LF', () => {
    expect(sanitizeForPaste('a\r\nb\r\nc')).toBe('a\nb\nc');
  });
  it('preserves tab and newline', () => {
    expect(sanitizeForPaste('a\tb\nc')).toBe('a\tb\nc');
  });
  it('strips other C0 controls', () => {
    expect(sanitizeForPaste('a\x07b\x1bc\x00d')).toBe('abcd');
  });
});

describe('PasteEngine.pasteAndSubmit', () => {
  let mockSessionManager: MockSessionManager;
  let engine: ReturnType<typeof createPasteEngine>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockSessionManager = new MockSessionManager();
    engine = createPasteEngine(mockSessionManager as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockSessionManager.removeAllListeners();
  });

  /** Reach the post-\r evidence wait phase: drain after queued \r. */
  async function reachEvidenceWait(): Promise<void> {
    mockSessionManager.flushDrain();
    await tick();
  }

  /** Satisfy evidence with an activity transition. */
  async function emitEvidence(): Promise<void> {
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();
  }

  it('drains, writes one chunk for small payload, observes settle, sends \\r via queue', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello world');

    await tick();
    expect(mockSessionManager.writeRawCalls).toHaveLength(0);

    mockSessionManager.flushDrain();
    await tick();

    // Phase 1: 11 bytes + 6+6 markers = 23 bytes, fits in one chunk
    expect(mockSessionManager.writeRawCalls).toHaveLength(1);
    expect(mockSessionManager.writeRawCalls[0]).toEqual({
      id: 's1',
      data: '\x1b[200~hello world\x1b[201~',
    });

    // Phase 2: simulate TUI redraw, then idle window
    mockSessionManager.emitData('s1', '\x1b[K[Pasted text +0 lines]');
    await tick();
    vi.advanceTimersByTime(250);
    await tick();

    // Floor: ensure 1000ms total since paste write
    vi.advanceTimersByTime(750);
    await tick();

    // Phase 3: Enter sent via QUEUE, not writeRaw
    expect(mockSessionManager.writeRawCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0]).toEqual({ id: 's1', data: '\r' });

    // Phase 4: post-\r drain + evidence
    await reachEvidenceWait();
    await emitEvidence();

    await expect(promise).resolves.toBeUndefined();
  });

  it("an UNFOCUSED session settles on 'data-tap' instead of riding the cap (MCP and mobile senders)", async () => {
    // A background session's bytes reach main only on the unconditional
    // 'data-tap' fan-out; the renderer-gated 'data' event never fires for it.
    // Before the settle listened on 'data-tap', every MCP session-send and
    // mobile-bridge message to an unfocused session rode the full capMs
    // (payload-scaled, ~3s here) before \r instead of settling at the 1000ms
    // floor. The 4000-byte payload makes cap (3000ms) clearly distinguishable
    // from the floor.
    const big = 'y'.repeat(4000);
    const promise = engine.pasteAndSubmit('s1', big);

    await tick();
    mockSessionManager.flushDrain();
    await tick();
    // 4000 + 12 markers = 4012 bytes -> 4 chunks; first is synchronous, the
    // remaining three each need a setImmediate yield.
    await flushSetImmediate();
    await tick();
    await flushSetImmediate();
    await tick();
    await flushSetImmediate();
    await tick();
    expect(mockSessionManager.writeRawCalls).toHaveLength(4);

    // The TUI's paste-placeholder redraw, arriving on data-tap ONLY.
    mockSessionManager.emit('data-tap', 's1', '\x1b[K[Pasted text +0 lines]');
    await tick();
    vi.advanceTimersByTime(250); // idle window after the burst
    await tick();
    vi.advanceTimersByTime(750); // complete the 1000ms React-commit floor
    await tick();

    // \r must already be queued at the floor, not at the ~3000ms cap.
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('chunks large payloads at 1024-byte boundaries', async () => {
    // 3000-byte payload: 3000 + 12 markers = 3012 bytes -> 3 chunks
    const big = 'x'.repeat(3000);
    const promise = engine.pasteAndSubmit('s1', big);

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // First chunk goes synchronously
    expect(mockSessionManager.writeRawCalls).toHaveLength(1);
    expect(mockSessionManager.writeRawCalls[0].data.length).toBe(1024);

    // Each subsequent chunk needs a setImmediate yield
    await flushSetImmediate();
    await tick();
    expect(mockSessionManager.writeRawCalls).toHaveLength(2);
    expect(mockSessionManager.writeRawCalls[1].data.length).toBe(1024);

    await flushSetImmediate();
    await tick();
    expect(mockSessionManager.writeRawCalls).toHaveLength(3);
    // Last chunk: 3012 - 2048 = 964 bytes (includes close marker)
    expect(mockSessionManager.writeRawCalls[2].data.length).toBe(964);

    // Settle + Enter via queue
    mockSessionManager.emitData('s1', 'rendering');
    await tick();
    vi.advanceTimersByTime(250);
    await tick();
    vi.advanceTimersByTime(1000);
    await tick();

    expect(mockSessionManager.writeRawCalls).toHaveLength(3);
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();

    await expect(promise).resolves.toBeUndefined();
  });

  it('idle window resets on each data burst (multi-frame redraw)', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello');

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls).toHaveLength(1);

    // Burst 1
    mockSessionManager.emitData('s1', 'frame1');
    await tick();
    vi.advanceTimersByTime(100);
    expect(mockSessionManager.writeCalls).toHaveLength(0);

    // Burst 2 - resets idle timer
    mockSessionManager.emitData('s1', 'frame2');
    await tick();
    vi.advanceTimersByTime(100);
    expect(mockSessionManager.writeCalls).toHaveLength(0);

    // Burst 3 - another reset
    mockSessionManager.emitData('s1', 'frame3');
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(0);

    // Now go quiet for 250ms - settle fires
    vi.advanceTimersByTime(250);
    await tick();
    // Floor fills any remaining time to MIN_GAP_MS
    vi.advanceTimersByTime(1000);
    await tick();

    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('falls back to cap when no data ever arrives', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello');

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls).toHaveLength(1);

    // No data events at all - engine hits SETTLE_CAP_MIN_MS (1000ms + 0.5*23 = ~1011ms cap)
    vi.advanceTimersByTime(1100);
    await tick();

    // Already past floor (1000ms), Enter fires immediately
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores data events for other sessions', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello');

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Data for OTHER session must not satisfy our settle
    mockSessionManager.emitData('s2-different', 'noise');
    await tick();
    vi.advanceTimersByTime(500);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(0);

    // Hit the cap
    vi.advanceTimersByTime(700);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('skips bracketed markers when bracketed:false', async () => {
    const promise = engine.pasteAndSubmit('s1', '/test', { bracketed: false });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls[0].data).toBe('/test');

    vi.advanceTimersByTime(1100);
    await tick();

    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('sanitizes embedded CR before writing', async () => {
    const promise = engine.pasteAndSubmit('s1', 'line one\rline two', { bracketed: false });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls[0].data).toBe('line one\nline two');

    vi.advanceTimersByTime(1100);
    await tick();

    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('sanitizes ESC and BEL out of payload before bracketed-paste wrap', async () => {
    const promise = engine.pasteAndSubmit('s1', 'a\x07b\x1bc');

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls[0].data).toBe('\x1b[200~abc\x1b[201~');

    vi.advanceTimersByTime(1100);
    await tick();

    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    await reachEvidenceWait();
    await emitEvidence();
    await expect(promise).resolves.toBeUndefined();
  });

  it('aborts when AbortSignal is signalled before drain completes', async () => {
    const controller = new AbortController();
    const promise = engine.pasteAndSubmit('s1', 'payload', { signal: controller.signal });
    promise.catch(() => undefined);

    await tick();
    controller.abort();
    await tick();

    mockSessionManager.flushDrain();
    await tick();

    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(mockSessionManager.writeRawCalls).toHaveLength(0);
    expect(mockSessionManager.writeCalls).toHaveLength(0);
  });

  it('aborts during settle wait', async () => {
    const controller = new AbortController();
    const promise = engine.pasteAndSubmit('s1', 'payload', { signal: controller.signal });
    promise.catch(() => undefined);

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls).toHaveLength(1);

    controller.abort();
    await tick();

    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    // Enter not sent after abort
    expect(mockSessionManager.writeRawCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls).toHaveLength(0);
  });

  it('rejects with timeout when total operation exceeds timeoutMs', async () => {
    const promise = engine.pasteAndSubmit('s1', 'payload', { timeoutMs: 500 });
    promise.catch(() => undefined);

    await tick();
    vi.advanceTimersByTime(500);
    await tick();

    mockSessionManager.flushDrain();
    await tick();

    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
  });

  it('retries \\r once when first evidence wait times out', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Drive past settle (cap fallback - no data) so \r fires
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    // Resolve the post-\r drain
    mockSessionManager.flushDrain();
    await tick();

    // First evidence window: no signal -> timeout at 3s -> second \r fires
    vi.advanceTimersByTime(3001);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(2);
    expect(mockSessionManager.writeCalls[1].data).toBe('\r');

    // Resolve the retry's drain
    mockSessionManager.flushDrain();
    await tick();

    // Second evidence window: emit activity to satisfy
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with no-submission-evidence when both evidence windows time out', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });
    promise.catch(() => undefined);

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Settle cap, then \r
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    // Resolve \r drain, first evidence window timeouts, retry \r fires
    mockSessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(3001);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(2);

    // Resolve retry drain, then let second evidence window time out
    mockSessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(2001);
    await tick();

    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'no-submission-evidence' });
  });

  it('accepts data event during evidence wait (non-hooked agent fallback)', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    mockSessionManager.flushDrain();
    await tick();

    // Agent emits a chunk that crosses the 50-byte cursor-blip floor.
    vi.advanceTimersByTime(500);
    mockSessionManager.emitData('s1', 'response from agent: ' + 'x'.repeat(40));
    await tick();

    // No retry should have fired
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores idle activity events during evidence wait', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });
    promise.catch(() => undefined);

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    vi.advanceTimersByTime(1100);
    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // 'idle' is not evidence - must time out
    mockSessionManager.emitActivity('s1', 'idle');
    await tick();
    vi.advanceTimersByTime(500);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    // Now emit thinking -> evidence
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('skips retry when bracketed-paste mode goes off (modal/permission prompt)', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });
    promise.catch(() => undefined);

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Settle path; agent emits the disable-bracketed-paste sequence
    // mid-call (a modal grabbed focus right before/during our paste).
    mockSessionManager.emitData('s1', '\x1b[?2004l');
    await tick();
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    // Resolve \r drain. Evidence window times out (no follow-up data).
    mockSessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(3001);
    await tick();

    // Retry should NOT have fired - mode-off short-circuits the retry path.
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'no-submission-evidence' });
  });

  it('detects mode-off when enable + disable appear in a single data chunk (correct order wins)', async () => {
    // Regression: presence-only checks misclassified "...ON...OFF..." as ON.
    // The last-position check should detect that OFF is most-recent in this chunk.
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });
    promise.catch(() => undefined);

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Single chunk with ON followed by OFF - the textually-later marker wins.
    mockSessionManager.emitData('s1', '\x1b[?2004hsome render bytes\x1b[?2004l');
    await tick();
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    mockSessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(3001);
    await tick();

    // Retry should NOT fire - mode is OFF (most-recent toggle in chunk).
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'no-submission-evidence' });
  });

  it('does retry when mode flips off then back on (modal opened and closed)', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Mode toggles off then on - net state is on, so retry is safe.
    mockSessionManager.emitData('s1', '\x1b[?2004l');
    await tick();
    mockSessionManager.emitData('s1', '\x1b[?2004h');
    await tick();
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);

    mockSessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(3001);
    await tick();

    // Retry fired
    expect(mockSessionManager.writeCalls).toHaveLength(2);

    mockSessionManager.flushDrain();
    await tick();
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('PasteEngine.pasteAndSubmit submission verifier (per-adapter)', () => {
  let mockSessionManager: MockSessionManager;
  let engine: ReturnType<typeof createPasteEngine>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockSessionManager = new MockSessionManager();
    engine = createPasteEngine(mockSessionManager as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockSessionManager.removeAllListeners();
  });

  /**
   * Walk the engine forward to the post-\r evidence wait phase. Drives:
   *  - drain pre-write
   *  - settle cap (no data) so \r is queued
   *  - drain post-\r
   * After this the next emit on the appropriate channel must resolve evidence.
   */
  async function reachEvidenceWait(): Promise<void> {
    await tick();
    mockSessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    mockSessionManager.flushDrain();
    await tick();
  }

  it('verifier resolves evidence when it returns true', async () => {
    const verifier: SubmissionVerifier = async (context) =>
      context.type === 'paste';
    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      verifier,
    });
    await reachEvidenceWait();

    // Verifier resolves true synchronously after \r drain; engine resolves as 'verifier'.
    await expect(promise).resolves.toBeUndefined();
  });

  it('verifier returning false does NOT short-circuit: activity backstop still resolves', async () => {
    // Regression for the OR-combine contract: a verifier resolving false must
    // leave the activity/data fallbacks active so the engine still resolves
    // when the activity event fires (or the data floor is crossed).
    const verifier: SubmissionVerifier = async () => false;
    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      verifier,
    });
    await reachEvidenceWait();

    // The verifier resolved false but the engine kept waiting; activity now
    // resolves it.
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('verifier throwing aborts the wait with the thrown error', async () => {
    const verifier: SubmissionVerifier = async () => {
      throw new Error('verifier blew up');
    };
    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      verifier,
    });
    promise.catch(() => undefined);
    await reachEvidenceWait();

    await expect(promise).rejects.toThrow('verifier blew up');
  });

  it('no verifier: falls back to activity event', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });
    await reachEvidenceWait();

    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('no verifier: data path requires the cursor-blip floor (50 bytes)', async () => {
    // Regression guard: a single cursor-position-report byte must NOT resolve
    // the wait. The 50-byte floor is what filters those false positives.
    const promise = engine.pasteAndSubmit('s1', 'hello', { timeoutMs: 30000 });
    await reachEvidenceWait();

    // Below the floor - engine must still be waiting.
    mockSessionManager.emitData('s1', 'a'.repeat(20));
    await tick();
    mockSessionManager.emitData('s1', 'b'.repeat(20));
    await tick();
    // 40 bytes accumulated - still below the 50-byte floor.

    // Crossing the floor (50 bytes total) resolves the wait.
    mockSessionManager.emitData('s1', 'c'.repeat(15));
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('verifier wins when it resolves true even though activity has not fired', async () => {
    let resolveVerifier: (value: boolean) => void;
    const verifierPromise = new Promise<boolean>((resolve) => {
      resolveVerifier = resolve;
    });
    const verifier: SubmissionVerifier = async () => verifierPromise;
    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      verifier,
    });
    await reachEvidenceWait();

    // Without firing activity or data, resolve the verifier.
    resolveVerifier!(true);
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('OR-combine race: activity fires while verifier is still pending', async () => {
    // The most likely real-Claude paste path: the verifier promise is in-flight
    // (e.g. one-shot Promise that hasn't resolved yet) while the activity
    // backstop fires first. The engine must resolve on the activity signal
    // without waiting for the verifier to settle.
    let resolveVerifier!: (value: boolean) => void;
    const verifierPromise = new Promise<boolean>((resolve) => {
      resolveVerifier = resolve;
    });
    const verifier: SubmissionVerifier = async () => verifierPromise;

    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      verifier,
    });
    await reachEvidenceWait();

    // Activity fires while verifier is still pending (not yet resolved).
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    // Engine must resolve without waiting for the verifier.
    await expect(promise).resolves.toBeUndefined();

    // Resolving the verifier afterward should be a no-op (already resolved).
    resolveVerifier(true);
    await tick();
  });

  it('tWriteEnter fresh-window: data bytes emitted before \\r write do not resolve evidence', async () => {
    // Guard: stale renders from the paste-settle phase must not count toward
    // the 50-byte floor even when they total more than 50 bytes. The
    // tWriteEnter timestamp captured by the engine right before the \r write
    // is compared to Date.now() when each data chunk arrives. Chunks whose
    // Date.now() is less than tWriteEnter are discarded.
    //
    // Fake-timer mechanics: Date.now() returns the frozen fake clock value.
    // We emit 60 bytes of data during the settle window (pre-\r), then freeze
    // time at that value. When \r fires, tWriteEnter = Date.now() = T1.
    // The listener starts. We do NOT advance time, so any emitData() call
    // in the same microtask has Date.now() == T1 (not < T1), which means those
    // bytes DO count. To demonstrate rejection we need data whose
    // Date.now()-at-emit < tWriteEnter.
    //
    // The practical approach: emit data with the data path DISABLED so we can
    // isolate the fresh-window behavior from the floor. Emit 60 "pre-submit"
    // bytes before \r, then with allowAnyDataFallback disabled confirm the
    // engine must resort to the activity backstop even though bytes crossed 50.
    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      allowAnyDataFallback: false, // disable data path so we can observe gating
    });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Drive past settle cap so \r fires.
    vi.advanceTimersByTime(1100);
    await tick();
    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    // Post-\r drain.
    mockSessionManager.flushDrain();
    await tick();

    // Emit data in the evidence window. With allowAnyDataFallback:false the
    // data path is fully disabled regardless of fresh-window, so bytes cannot
    // resolve the wait - only activity can.
    mockSessionManager.emitData('s1', 'x'.repeat(100));
    await tick();

    // Engine is still waiting (data path disabled, activity not fired).
    // Intentional: we cannot poll for non-occurrence, so a short advance then check.
    // (Fixed wait is intentional here - cannot poll for absence of resolution.)
    vi.advanceTimersByTime(500);
    await tick();

    // Now fire activity to satisfy the wait.
    mockSessionManager.emitActivity('s1', 'thinking');
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });

  it('tWriteEnter fresh-window: byte accumulator resets between the pre-\\r and post-\\r phases', async () => {
    // Demonstrates the byte counter is per evidence-wait invocation. Bytes emitted
    // during settle do NOT carry over; the counter starts fresh at the \r write.
    // Setup: emit 40 bytes during settle (just below floor), then confirm that 20
    // bytes post-\r cross the 50-byte floor and resolve the wait.
    const promise = engine.pasteAndSubmit('s1', 'hello', {
      timeoutMs: 30000,
      allowAnyDataFallback: true,
    });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    // Emit 40 bytes during the settle window (pre-\r).
    mockSessionManager.emitData('s1', 'y'.repeat(40));
    await tick();

    // Let the idle timer fire so we advance through settle and send \r.
    vi.advanceTimersByTime(250); // OUTPUT_SETTLE_IDLE_MS
    await tick();
    // Advance through the MIN_GAP_MS floor if needed.
    vi.advanceTimersByTime(1000);
    await tick();

    expect(mockSessionManager.writeCalls).toHaveLength(1);
    expect(mockSessionManager.writeCalls[0].data).toBe('\r');

    // Post-\r drain.
    mockSessionManager.flushDrain();
    await tick();

    // Emit only 20 bytes post-\r. If the 40 pre-\r bytes carried over we
    // would have crossed 50 already - which would be wrong. This 20-byte
    // emission should NOT cross the floor yet.
    mockSessionManager.emitData('s1', 'z'.repeat(20));
    await tick();

    // Still waiting because 20 < 50 post-\r bytes.
    // (intentional fixed advance - cannot poll for absence of resolution)
    vi.advanceTimersByTime(200);
    await tick();

    // Now add 35 more bytes to total 55 post-\r bytes (crosses the 50-byte floor).
    mockSessionManager.emitData('s1', 'z'.repeat(35));
    await tick();

    await expect(promise).resolves.toBeUndefined();
  });
});
