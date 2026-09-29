/**
 * Tasks per summary call. Shared because the Task summaries card turns a count of
 * tasks into a count of calls ("about 68 calls") before any call is made, and
 * that has to be the size main actually batches at.
 */
export const SUMMARY_BATCH_SIZE = 10;
