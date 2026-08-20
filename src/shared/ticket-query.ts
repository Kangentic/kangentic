// Shared parser for the "#<number>" ticket-search syntax. A task's ticket
// number is its integer `display_id`, shown throughout the UI as `#N`. When a
// search query is a `#` followed by digits, we match tasks by `display_id`
// (prefix) instead of substring-matching title/description.
//
// This lives in `src/shared/` so the one `#`-trigger rule is single-sourced
// across the main process (the unified search core / MCP `kangentic_search`)
// and the renderer (the board toolbar filter). Keeping the trigger in one place
// is what stops the two surfaces from disagreeing about what counts as a ticket
// query.

/**
 * Parse a search query as a ticket lookup.
 *
 * Returns the digit string when `query` (after trimming) is a `#` immediately
 * followed by one or more digits, otherwise `null`.
 *
 * Examples: `"#42"` -> `"42"`, `"#4"` -> `"4"`, `"  #7 "` -> `"7"`;
 * `"foo"`, `"#"`, `"#4a"`, `"42"`, `""` -> `null`.
 *
 * A bare number (no `#`) is deliberately NOT a ticket query, so numeric text
 * search (a title containing a number) keeps working. The `#` is required.
 */
export function parseTicketQuery(query: string): string | null {
  const match = query.trim().match(/^#(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Prefix-match a task's `display_id` against parsed ticket digits.
 *
 * Prefix (not exact) so a live filter narrows as the user types: `"4"` matches
 * `4, 40, 41, 400, ...` and `"42"` matches `42, 420, 421, ...`. Compared as the
 * canonical decimal string, so a leading-zero query like `"04"` matches nothing
 * (no task's number renders as `04`), which is the intended behavior.
 */
export function matchesTicketPrefix(displayId: number, digits: string): boolean {
  return String(displayId).startsWith(digits);
}
