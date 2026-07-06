/**
 * Turn a raw user query into a safe FTS5 MATCH expression. User input must
 * never reach MATCH raw: a bare `-`, `"`, `*`, `NEAR`, `AND`, or a column
 * filter (`col:`) is FTS5 syntax and would either throw a "malformed MATCH"
 * error or silently misfire.
 *
 * Strategy: split on whitespace, drop embedded double quotes, wrap every token
 * as a quoted phrase (which disables all operator interpretation), join with
 * spaces (implicit AND), and append `*` to the LAST token for prefix matching
 * so as-you-type search finds partial words. Returns null when nothing
 * queryable remains, so the caller skips the lexical pass entirely.
 */
export function escapeFtsMatchQuery(query: string): string | null {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '').trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  const lastIndex = tokens.length - 1;
  const parts = tokens.map((token, index) => {
    const phrase = `"${token}"`;
    // Prefix-match only the final token: partial words as the user types.
    return index === lastIndex ? `${phrase}*` : phrase;
  });

  return parts.join(' ');
}
