/**
 * Claude Code stores a bracketed paste in the transcript wrapped in tags of its
 * own, an id on both ends, the pasted text on the lines between:
 *
 * `<pasted_content id="af6a">\n...\n</pasted_content id="af6a">`
 *
 * Measured on Claude Code 2.1.329 (#1138). The wrapper is Claude's bookkeeping,
 * not what was pasted. Left in, its words joined the text the typed-message
 * ledger hashes (`typedMessageKey`), so a column message Kangentic pasted no
 * longer matched the key it recorded, and a Text match on the user's message
 * read the column's contract as the owner's words. Only the tags go; the
 * pasted text stays, a person's own paste included.
 */

const OPENING_PREFIX = '<pasted_content';

/**
 * Claude's ids are a few hex digits. The bound keeps a stray `<pasted_content id="`
 * with no closing quote from scanning the rest of a long line.
 */
const OPENING_TAG = /<pasted_content(?: id="([^"<>\n]{0,64})")?>/g;
const CLOSING_TAG = /<\/pasted_content(?: id="([^"<>\n]{0,64})")?>/g;

interface ClosingTag {
  start: number;
  end: number;
}

/** The first closing tag in `tags` (in text order) that starts at or after `from`. */
function firstClosingFrom(tags: readonly ClosingTag[] | undefined, from: number): ClosingTag | null {
  if (tags === undefined) return null;
  let low = 0;
  let high = tags.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tags[middle].start < from) low = middle + 1;
    else high = middle;
  }
  return tags[low] ?? null;
}

/**
 * `text` with each of Claude's paste wrappers replaced by the text it wraps.
 * A wrapper closes at the first closing tag with its own id or with none, and
 * one line break is dropped inside each end, `\r\n` included. Every tag is
 * found in one pass, so a line that quotes an opening tag many times with no
 * closing one stays linear.
 */
export function unwrapPastedContent(text: string): string {
  if (!text.includes(OPENING_PREFIX)) return text;

  // Closing tags by the id they carry; `''` is one with no id.
  const closingById = new Map<string, ClosingTag[]>();
  for (const match of text.matchAll(CLOSING_TAG)) {
    const id = match[1] ?? '';
    const tags = closingById.get(id) ?? [];
    tags.push({ start: match.index, end: match.index + match[0].length });
    closingById.set(id, tags);
  }
  if (closingById.size === 0) return text;

  let unwrapped = '';
  let copiedUpTo = 0;
  for (const match of text.matchAll(OPENING_TAG)) {
    if (match.index < copiedUpTo) continue;
    const bodyStart = match.index + match[0].length;
    const sameId = firstClosingFrom(closingById.get(match[1] ?? ''), bodyStart);
    const noId = match[1] === undefined ? null : firstClosingFrom(closingById.get(''), bodyStart);
    const closing = sameId === null ? noId : noId === null || sameId.start < noId.start ? sameId : noId;
    if (closing === null) continue;
    const body = text.slice(bodyStart, closing.start).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    unwrapped += text.slice(copiedUpTo, match.index) + body;
    copiedUpTo = closing.end;
  }
  return copiedUpTo === 0 ? text : unwrapped + text.slice(copiedUpTo);
}
