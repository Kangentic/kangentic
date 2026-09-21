/**
 * The shared opt-out marker reader for the convention scans in `tests/unit/`.
 *
 * Roughly a dozen scans let a site opt out with a `// <name>-ok: <reason>`
 * comment, and every one of them used to answer "is this line marked?" its own
 * way. Five different answers were in the tree at once: same line plus the one
 * line above; a fixed three-line window; a JSX-aware upward walk; whole-file;
 * and, in one case, a contiguous comment block. They look identical to whoever
 * writes the comment, so the blast radius of a marker depended on which scan
 * happened to read it, and nothing said which you were getting.
 *
 * That is not theoretical. A two-line reason above a violation silently failed
 * to mark it under the line-above rule, because the nearest line was the tail of
 * the reason rather than the marker, and the failure message then said to add a
 * marker that was already there.
 *
 * Three association rules survive here, because three genuinely different code
 * shapes need them. Pick by shape, not by taste, and the call site then says
 * which it chose:
 *
 *   - `hasOptOutMarker` for ordinary statements. The marker sits on the line or
 *     in the comment block directly above it.
 *   - `hasJsxOptOutMarker` for a JSX element, whose opening tag can span many
 *     lines, so the marker may sit above an attribute list rather than adjacent
 *     to the matched line.
 *   - `hasFileScopedOptOut` when a violation cannot be resolved to one line at
 *     all, which is true only where the real exemption lives on an ancestor the
 *     scan cannot see statically.
 *
 * Every rule requires a REASON after the colon. A bare `// sync-write-ok:` does
 * not mark anything, which is the one property `guarded-sync-writes.test.ts`
 * already enforced and is now uniform.
 *
 * Ten markers read through here. Four still do not: `popover-width-ok` is
 * line-only by design (see `popover-inflow-menu.test.ts`), and
 * `archived-filter-ok`, `agent-focus-ok`, and `cookie-copy-ok` keep the private
 * readers this module exists to replace. Migrating those three needs nothing
 * from here but the import.
 */

/**
 * A runaway guard on the upward walks, not the association rule. It only stops
 * a file that is one enormous comment from being walked end to end.
 */
const MARKER_WALK_CAP = 60;

/**
 * Build the pattern for a marker name (`'select-none-ok'`, no colon).
 *
 * A marker has to OPEN a comment. The pattern wants a comment opener that is
 * itself at the start of the line or preceded by whitespace, then the name,
 * then a colon and a reason. All four opener forms are accepted, because
 * markers legitimately appear in line comments, block comments, JSDoc
 * continuation lines, and brace-wrapped JSX comments, and the opener may
 * follow code on the same line as a trailing comment.
 *
 * The colon plus a non-space character is what rejects a bare marker with no
 * reason. The opener is what rejects PROSE that quotes a marker rather than
 * using one, and that half is not theoretical. The comment above the
 * `whatsNewEvaluated` declaration in
 * `src/renderer/hooks/useWhatsNewOnLaunch.ts` reads "deliberately not a
 * `// hmr-safe:` opt-out". Matching the bare name plus a colon, the backtick
 * that closes the quote counted as the reason, so the sentence denying the
 * opt-out read as the opt-out itself. A quoted marker is preceded by a
 * backtick instead of whitespace, which is exactly what the anchor catches.
 */
function markerPattern(markerName: string): RegExp {
  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?://|\\{/\\*+|/\\*+|\\*+)\\s*${escaped}:\\s*\\S`);
}

/**
 * The marker is on the line itself, or anywhere in the contiguous comment block
 * directly above it. A blank line or any code between the comment and the line
 * ends the block, so a stale marker cannot reach down an arbitrary distance.
 */
export function hasOptOutMarker(lines: string[], lineIndex: number, markerName: string): boolean {
  const pattern = markerPattern(markerName);
  if (pattern.test(lines[lineIndex] ?? '')) return true;

  for (let scan = lineIndex - 1; scan >= 0 && lineIndex - scan <= MARKER_WALK_CAP; scan--) {
    const trimmed = lines[scan].trim();
    if (pattern.test(trimmed)) return true;
    if (!/^(\/\/|\/\*|\*)/.test(trimmed)) return false;
  }
  return false;
}

/**
 * The JSX variant. A React element's opening tag spans as many lines as it has
 * attributes, so the marker routinely sits above the attribute list rather than
 * next to the line the scan matched. The walk therefore climbs through
 * attribute lines and the opening tag, and stops the moment it leaves this
 * element: a closing tag means it has climbed into a sibling, and anything
 * above an opening tag that is not a comment belongs to something else.
 *
 * It is a line walk, not a JSX parser, and one hole is known and left open: a
 * sibling written as a MULTI-LINE self-closing element has a tail (`/>` on its
 * own line) that is indistinguishable from our own attribute list, so a marker
 * above such a sibling can still reach the element below it. Closing that needs
 * real bracket matching. The single-line form, which is the common one, is
 * handled. Prefer putting the marker on the element's own line when the
 * surrounding JSX is dense.
 */
export function hasJsxOptOutMarker(lines: string[], lineIndex: number, markerName: string): boolean {
  const pattern = markerPattern(markerName);
  if (pattern.test(lines[lineIndex] ?? '')) return true;

  let passedOpeningTag = false;
  for (let scan = lineIndex - 1; scan >= 0 && lineIndex - scan <= MARKER_WALK_CAP; scan--) {
    const trimmed = lines[scan].trim();
    if (trimmed === '') continue;
    if (pattern.test(trimmed)) return true;

    if (/^(\/\/|\/\*|\*)/.test(trimmed)) continue;
    // A closing tag means we have climbed out of this element into a sibling:
    // whatever is above belongs to something else.
    if (trimmed.startsWith('</')) return false;
    // A self-closing element written on one line is a COMPLETE sibling, so
    // anything above it belongs to that sibling, not to us. Without this it is
    // indistinguishable from our own opening tag and the marker leaks down to
    // the next element.
    if (trimmed.startsWith('<') && trimmed.endsWith('/>')) return false;
    if (passedOpeningTag) return false;
    // The opening tag itself. Above it, only a comment block still counts.
    if (trimmed.startsWith('<')) {
      passedOpeningTag = true;
      continue;
    }
    // Still inside the attribute list.
  }
  return false;
}

/**
 * Whole-file scope: one marker anywhere exempts every site in the file.
 *
 * This is the loosest rule by a wide margin and is correct only where the real
 * exemption is invisible to a static scan, so no line-level answer exists to
 * give. The light-dismiss action-cursor scan is the case: an ancestor's
 * `data-no-dismiss` covers its whole subtree through `closest()`, and static
 * ancestry checking across components is not possible. Reach for this only with
 * that kind of reason, and say so at the call site.
 */
export function hasFileScopedOptOut(contents: string, markerName: string): boolean {
  return markerPattern(markerName).test(contents);
}
