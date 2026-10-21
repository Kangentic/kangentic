/**
 * The retrieval worker's queue for Conversation viewer history reads (a page, a
 * turn's page, a timeline): one at a time, never piled up.
 *
 * The worker answers every other request as it arrives, and main's call timer
 * KILLS the worker when a call passes 15 s (three kills and it stays off). A
 * reader scrolling fast, or dragging the scrollbar across a long transcript,
 * can ask for pages faster than they read, so these reads are serialized here,
 * with two guards that keep any one of them far inside that timer:
 *
 * - a depth cap: past it a request answers `busy` at once, and the viewer asks
 *   again on its next scroll;
 * - a wait cap: a request that waited longer than it answers `busy` unread;
 * - a whole-call deadline: a request still unanswered after it answers `busy`
 *   whatever it is doing, waiting or running. The wait cap alone is checked only
 *   when a request starts, so a read that ran long held every request behind it
 *   past main's timer. One did: a 1-byte cache check walked a 97 MB file a byte
 *   at a time, and main killed the worker on the timeline call queued behind it.
 *   A read that outlives its deadline keeps the queue until it ends, so the
 *   reads behind it answer `busy` too, never a kill.
 *
 * A newer request from the same window (`requestKey`) supersedes its queued
 * older one, so a drag that settles somewhere new never waits behind reads for
 * places the reader has already left. One read at a time also bounds memory:
 * a page is one window of at most `HISTORY_PAGE_BYTES` of source.
 */
import PQueue from 'p-queue';

export type HistoryReadOutcome<Value> =
  | { ran: true; value: Value }
  | { ran: false; reason: 'busy' | 'superseded' };

export interface HistoryReadQueueOptions {
  /** Requests queued or running past which a new one answers `busy`. */
  maxDepth: number;
  /** How long a request may wait before it answers `busy` unread. */
  maxWaitMs: number;
  /** How long a request may take in all, waiting and running, before it answers `busy`. */
  maxTotalMs: number;
  now?: () => number;
}

export interface HistoryReadQueue {
  run<Value>(requestKey: string | undefined, job: () => Promise<Value>): Promise<HistoryReadOutcome<Value>>;
}

export function createHistoryReadQueue(options: HistoryReadQueueOptions): HistoryReadQueue {
  const queue = new PQueue({ concurrency: 1 });
  const now = options.now ?? (() => Date.now());
  const latestTicketByKey = new Map<string, number>();
  let nextTicket = 1;

  return {
    async run<Value>(requestKey: string | undefined, job: () => Promise<Value>): Promise<HistoryReadOutcome<Value>> {
      if (queue.size + queue.pending >= options.maxDepth) return { ran: false, reason: 'busy' };
      const ticket = nextTicket;
      nextTicket += 1;
      if (requestKey) latestTicketByKey.set(requestKey, ticket);
      const enqueuedAt = now();
      let answered = false;
      const work = queue.add(async (): Promise<HistoryReadOutcome<Value>> => {
        try {
          if (answered) return { ran: false, reason: 'busy' };
          if (requestKey && latestTicketByKey.get(requestKey) !== ticket) return { ran: false, reason: 'superseded' };
          if (now() - enqueuedAt > options.maxWaitMs) return { ran: false, reason: 'busy' };
          return { ran: true, value: await job() };
        } finally {
          if (requestKey && latestTicketByKey.get(requestKey) === ticket) latestTicketByKey.delete(requestKey);
        }
      }).then((outcome) => outcome ?? { ran: false as const, reason: 'busy' as const });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<HistoryReadOutcome<Value>>((resolve) => {
        deadlineTimer = setTimeout(() => resolve({ ran: false, reason: 'busy' }), options.maxTotalMs);
      });
      try {
        return await Promise.race([work, deadline]);
      } finally {
        answered = true;
        clearTimeout(deadlineTimer);
      }
    },
  };
}

/**
 * The worker's one history queue. The deadline sits well inside main's 15 s
 * call timer (`INTERACTIVE_TIMEOUT_MS`), with room for the hop to main and back.
 */
export const historyReadQueue = createHistoryReadQueue({ maxDepth: 8, maxWaitMs: 5_000, maxTotalMs: 10_000 });
