/**
 * Tasks per summary call. Shared because Settings > Knowledge Graph turns a
 * count of tasks into a count of calls before any call is made (the Task
 * summaries line's info, and Rebuild's confirmation of what it will spend),
 * and that has to be the size main actually batches at.
 */
export const SUMMARY_BATCH_SIZE = 10;
