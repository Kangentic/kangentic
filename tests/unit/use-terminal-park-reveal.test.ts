/**
 * Cross-module contract test for the parked-terminal write gating in
 * useTerminal.ts: the REAL incoming-write-queue composed with the REAL
 * parked-terminals registry, plus a mirror of reloadScrollback's observable
 * contract (set pending -> fetch -> write -> clear pending -> kick), exactly
 * as useTerminal wires them:
 *
 *   shouldDrop: () => suppressDataRef.current || isTerminalParked(sessionId)
 *   shouldHold: () => scrollbackPendingRef.current
 *   onTerminalReveal(sessionId, () => reloadScrollback({ skipResize, skipFocus }))
 *
 * Locks the three-phase transition: while parked, live bytes are
 * acked-and-dropped (never held - an indefinitely-parked window must not
 * wedge the main-process backpressure watermarks); the reveal edge triggers
 * exactly one scrollback reload; bytes arriving DURING the reveal replay are
 * held and flush strictly after the replayed frame.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { createIncomingWriteQueue } from '../../src/renderer/utils/incoming-write-queue';
import {
  isTerminalParked,
  syncParkedTerminals,
  onTerminalReveal,
} from '../../src/renderer/utils/parked-terminals';

function fakeTerminal(): { term: Terminal; writes: string[] } {
  const writes: string[] = [];
  const term = {
    write(data: string, callback?: () => void): void {
      writes.push(data);
      if (callback) queueMicrotask(callback);
    },
  } as unknown as Terminal;
  return { term, writes };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  syncParkedTerminals(new Set());
});

describe('park -> ack-and-drop -> reveal -> scrollback catch-up', () => {
  it('drops-and-acks while parked, reloads once on reveal, and holds mid-replay bytes until after the replayed frame', async () => {
    const sessionId = 'sess-parked';
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const scrollbackPendingRef = { current: false };

    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => isTerminalParked(sessionId),
      shouldHold: () => scrollbackPendingRef.current,
      ack,
      chunkSize: 64,
    });

    // Mirror of reloadScrollback's observable contract for the reveal path.
    let reloadCount = 0;
    let releaseReplay: (() => void) | null = null;
    const reloadScrollback = () => {
      reloadCount += 1;
      scrollbackPendingRef.current = true;
      // The chunked scrollback write completes when the test releases it,
      // then afterWrite clears pending and kicks the queue.
      releaseReplay = () => {
        term.write('REPLAYED-FRAME', () => {
          scrollbackPendingRef.current = false;
          queue.kick();
        });
      };
    };
    const unsubscribe = onTerminalReveal(sessionId, reloadScrollback);

    // Phase 1: parked. Live bytes are acked-and-dropped, never held.
    syncParkedTerminals(new Set([sessionId]));
    queue.push('streamed-while-parked');
    await flush();
    expect(writes).toEqual([]);
    const ackedWhileParked = ack.mock.calls.reduce((sum, call) => sum + call[0], 0);
    expect(ackedWhileParked).toBe('streamed-while-parked'.length);

    // Phase 2: reveal. Exactly one reload fires and pending now holds the queue.
    syncParkedTerminals(new Set());
    expect(reloadCount).toBe(1);
    expect(scrollbackPendingRef.current).toBe(true);

    // Live bytes arriving mid-replay are held (not written, not acked).
    ack.mockClear();
    queue.push('live-during-replay');
    await flush();
    expect(writes).toEqual([]);
    expect(ack).not.toHaveBeenCalled();

    // Phase 3: the replay frame paints, pending clears, held bytes flush after.
    releaseReplay?.();
    await flush();
    expect(writes).toEqual(['REPLAYED-FRAME', 'live-during-replay']);
    const ackedAfterReveal = ack.mock.calls.reduce((sum, call) => sum + call[0], 0);
    expect(ackedAfterReveal).toBe('live-during-replay'.length);

    // Republishing the same visible state fires no second reload.
    syncParkedTerminals(new Set());
    expect(reloadCount).toBe(1);

    unsubscribe();
  });
});
