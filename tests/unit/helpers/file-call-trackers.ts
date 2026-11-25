/**
 * Stand-ins for `fs.promises` calls that count how many are in flight at once,
 * for tests that pin a concurrency bound (the line-count worker, and the diff
 * service's inline count and size pass).
 *
 * Each helper hands back an implementation and its counters. It does not install
 * the mock, because one suite mocks the module (`vi.mocked(fs.promises.open)`) and
 * another spies on it (`vi.spyOn(fs.promises, 'open')`). Every call waits on a
 * later turn of the event loop, the way a real file call does, so calls started
 * together overlap.
 */

/** Resolves on a later turn of the event loop, the way a real file call does. */
export function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface OpenFileHandleTracker {
  /** Stands in for `fs.promises.open`. Cast it with `as never` where the mock is typed. */
  open: () => Promise<{
    read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
    close: () => Promise<void>;
  }>;
  /** Handles open right now. Zero once every one was closed. */
  readonly openHandles: number;
  /** The most handles that were open at the same moment. */
  readonly peakOpenHandles: number;
}

/** An `open` whose every handle reads `content`, counting the handles held open. */
export function trackOpenFileHandles(content: Buffer): OpenFileHandleTracker {
  let openHandles = 0;
  let peakOpenHandles = 0;
  return {
    open: async () => {
      openHandles += 1;
      peakOpenHandles = Math.max(peakOpenHandles, openHandles);
      await nextEventLoopTurn();
      return {
        read: async (buffer, offset, length, position) => {
          await nextEventLoopTurn();
          content.copy(buffer, offset, position, position + length);
          return { bytesRead: length, buffer };
        },
        close: async () => {
          await nextEventLoopTurn();
          openHandles -= 1;
        },
      };
    },
    get openHandles() { return openHandles; },
    get peakOpenHandles() { return peakOpenHandles; },
  };
}

export interface CallsInFlightTracker<TResult> {
  /** Stands in for the call. Cast it with `as never` where the mock is typed. */
  call: () => Promise<TResult>;
  /** Calls started so far. */
  readonly totalCalls: number;
  /** The most calls that were in flight at the same moment. */
  readonly peakInFlight: number;
}

/** A call that answers `resultOf(callIndex)` on a later turn, counting the calls in flight. */
export function trackCallsInFlight<TResult>(resultOf: (callIndex: number) => TResult): CallsInFlightTracker<TResult> {
  let totalCalls = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  return {
    call: async () => {
      const callIndex = totalCalls;
      totalCalls += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await nextEventLoopTurn();
      inFlight -= 1;
      return resultOf(callIndex);
    },
    get totalCalls() { return totalCalls; },
    get peakInFlight() { return peakInFlight; },
  };
}
