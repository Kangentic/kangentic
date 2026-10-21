/**
 * The Conversation viewer's history paging bounds, shared by the worker that
 * reads pages and the window that holds them.
 *
 * A page is 8 MiB of source: measured on real Claude transcripts of 32 to
 * 548 MB, one page costs the retrieval worker 27 to 34 MB of peak memory and 18
 * to 185 ms, and sends at most 0.9 MB of entries (`docs/conversation-history-paging-audit.md`).
 * It equals the conversation indexer's window and the transcript archive's row,
 * so an archived page is one archive row.
 *
 * A window holds at most 8 pages on top of the tail it polls, across all of its
 * sessions, so its memory stays bounded however large the transcript grows.
 */
export const HISTORY_PAGE_BYTES = 8 * 1024 * 1024;

export const HISTORY_WINDOW_MAX_PAGES = 8;

/** The most page source a window holds at once. */
export const HISTORY_WINDOW_MAX_BYTES = HISTORY_PAGE_BYTES * HISTORY_WINDOW_MAX_PAGES;
