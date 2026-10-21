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
 * - a wait cap: a request that waited longer than it answers `busy` unread.
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
      const outcome = await queue.add(async (): Promise<HistoryReadOutcome<Value>> => {
        try {
          if (requestKey && latestTicketByKey.get(requestKey) !== ticket) return { ran: false, reason: 'superseded' };
          if (now() - enqueuedAt > options.maxWaitMs) return { ran: false, reason: 'busy' };
          return { ran: true, value: await job() };
        } finally {
          if (requestKey && latestTicketByKey.get(requestKey) === ticket) latestTicketByKey.delete(requestKey);
        }
      });
      return outcome ?? { ran: false, reason: 'busy' };
    },
  };
}

/** The worker's one history queue. */
export const historyReadQueue = createHistoryReadQueue({ maxDepth: 8, maxWaitMs: 5_000 });
