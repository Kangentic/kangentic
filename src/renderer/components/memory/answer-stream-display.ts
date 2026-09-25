/**
 * Splits the working out of a PARTIAL answer, for display while it streams.
 *
 * The agent writes its `<grounds>` block before the answer. Shown raw, the
 * first thing the reader sees arrive is a table row and a quote, which reads
 * as the answer being wrong rather than as the answer being on its way. So the
 * block is held back while the stream runs, and the prose after it is what
 * appears.
 *
 * Renderer-side and deliberately looser than the main process's `parseGrounds`,
 * which runs on the COMPLETE text and decides what the settled answer says.
 * This only decides what to paint for a few hundred milliseconds:
 *
 * - An open `<grounds>` with no close yet: everything from the opener on is
 *   the working still being written, so nothing is shown. The reader sees the
 *   status line ("Searching your conversations") until prose arrives.
 * - A closed block: the text after it is the answer so far.
 * - No block: the text is the answer so far.
 *
 * Nothing structural is derived from this. Refs, view and rows all come from
 * the settled answer, which replaces the stream when it lands.
 */
export function parseGroundsForDisplay(partial: string): { text: string } {
  const closed = partial.match(/<grounds>[\s\S]*?<\/grounds>/i);
  if (closed) {
    const after = partial.slice((closed.index ?? 0) + closed[0].length);
    const before = partial.slice(0, closed.index ?? 0);
    return { text: (before + after).trim() };
  }
  const open = partial.search(/<grounds>/i);
  if (open !== -1) return { text: partial.slice(0, open).trim() };
  return { text: partial.trim() };
}
