/**
 * Pure markdown-aware editing helpers for DescriptionEditor: list continuation
 * on Enter, Tab/Shift+Tab indent scoped to list items, bold/italic/link
 * wrapping, and paste heuristics (URL-over-selection, HTML worth converting).
 *
 * Every edit helper returns a range-replacement descriptor (or null, meaning
 * "let the browser do its native thing") rather than a new string, so the
 * caller can apply it through `execCommand('insertText'/'delete')` and keep
 * the textarea's native undo stack intact.
 */

export interface MarkdownEdit {
  replaceStart: number;
  replaceEnd: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
}

const LIST_MARKER_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s*)?/;
const INDENT_UNIT = '  ';

function lineBoundsAt(value: string, caret: number): { lineStart: number; lineEnd: number } {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const nextNewline = value.indexOf('\n', caret);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  return { lineStart, lineEnd };
}

/**
 * Enter inside a list item continues it with the next marker (incrementing an
 * ordered marker, resetting a checkbox to unchecked). Enter on a marker with
 * no other content on the line clears the marker instead of nesting an empty
 * item - judged against the line's full content, not the caret position, so
 * `- ` with trailing whitespace or a caret parked mid-marker both count as
 * empty. Only applies to a collapsed caret; the caller is responsible for not
 * calling this when there is a selection.
 */
export function continueListOnEnter(value: string, caret: number): MarkdownEdit | null {
  const { lineStart, lineEnd } = lineBoundsAt(value, caret);
  const line = value.slice(lineStart, lineEnd);
  const match = LIST_MARKER_RE.exec(line);
  if (!match) return null;

  const prefixLength = match[0].length;
  const restOfLine = line.slice(prefixLength);
  if (restOfLine.trim().length === 0) {
    return {
      replaceStart: lineStart,
      replaceEnd: lineEnd,
      insert: '',
      selectionStart: lineStart,
      selectionEnd: lineStart,
    };
  }

  const [, indent, markerToken, spacer, checkboxToken] = match;
  const orderedMatch = /^(\d+)([.)])$/.exec(markerToken);
  const nextMarkerToken = orderedMatch ? `${parseInt(orderedMatch[1], 10) + 1}${orderedMatch[2]}` : markerToken;
  const nextCheckbox = checkboxToken ? '[ ] ' : '';
  const insert = `\n${indent}${nextMarkerToken}${spacer}${nextCheckbox}`;

  return {
    replaceStart: caret,
    replaceEnd: caret,
    insert,
    selectionStart: caret + insert.length,
    selectionEnd: caret + insert.length,
  };
}

function leadingSpaceCount(line: string, max: number): number {
  let count = 0;
  while (count < max && line[count] === ' ') count += 1;
  return count;
}

/** Remap an offset within the pre-edit `covered` text to its position within
 *  the rewritten text, given each line's net length change (`deltas`). An
 *  offset inside whitespace being removed (a negative delta) clamps to the
 *  start of that line's remaining content rather than going negative. */
function remapOffset(offsetWithinCovered: number, originalLines: string[], deltas: number[]): number {
  let originalCursor = 0;
  let newCursor = 0;
  for (let index = 0; index < originalLines.length; index += 1) {
    const line = originalLines[index];
    const lineEndOriginal = originalCursor + line.length;
    if (offsetWithinCovered <= lineEndOriginal) {
      const withinLine = offsetWithinCovered - originalCursor;
      const delta = deltas[index];
      const newWithinLine = delta < 0 ? Math.max(0, withinLine + delta) : withinLine + delta;
      return newCursor + newWithinLine;
    }
    newCursor += line.length + deltas[index] + 1;
    originalCursor = lineEndOriginal + 1;
  }
  return newCursor;
}

export interface IndentOptions {
  outdent?: boolean;
}

/**
 * Tab/Shift+Tab indent or outdent every line the selection covers, by a
 * two-space unit - but only when the FIRST covered line is a list item, so
 * Tab keeps its normal focus-movement behavior everywhere else. Returns null
 * when there is nothing to indent (not a list) or nothing to outdent (already
 * at zero indent), so the caller does not preventDefault and native Tab fires.
 *
 * Known limitation: forward Tab has no indent cap, so a caret parked anywhere
 * in a list swallows every forward Tab, and a keyboard-only user cannot move
 * focus to the next field from there. Shift+Tab still escapes backward once
 * the line is fully outdented. Capping forward Tab (to a multi-line selection
 * or a caret in the leading-whitespace region, the way GitHub's editor does)
 * would close it; that is an open item, not an oversight.
 */
export function indentListSelection(
  value: string,
  start: number,
  end: number,
  options: IndentOptions = {},
): MarkdownEdit | null {
  const { outdent = false } = options;
  const rangeStart = value.lastIndexOf('\n', start - 1) + 1;
  const searchFrom = Math.max(start, end);
  const nextNewlineIndex = value.indexOf('\n', searchFrom);
  const rangeEnd = nextNewlineIndex === -1 ? value.length : nextNewlineIndex;

  const firstLineEnd = value.indexOf('\n', rangeStart);
  const firstLine = value.slice(rangeStart, firstLineEnd === -1 ? value.length : firstLineEnd);
  if (!LIST_MARKER_RE.test(firstLine)) return null;

  const covered = value.slice(rangeStart, rangeEnd);
  const lines = covered.split('\n');

  const deltas: number[] = outdent
    ? lines.map((line) => -leadingSpaceCount(line, INDENT_UNIT.length))
    : lines.map((line) => (line.length > 0 ? INDENT_UNIT.length : 0));

  if (deltas.every((delta) => delta === 0)) return null;

  const rewritten = lines.map((line, index) => {
    const delta = deltas[index];
    if (delta > 0) return `${INDENT_UNIT}${line}`;
    if (delta < 0) return line.slice(-delta);
    return line;
  });

  const insert = rewritten.join('\n');

  return {
    replaceStart: rangeStart,
    replaceEnd: rangeEnd,
    insert,
    selectionStart: rangeStart + remapOffset(start - rangeStart, lines, deltas),
    selectionEnd: rangeStart + remapOffset(end - rangeStart, lines, deltas),
  };
}

/**
 * Toggle a symmetric marker (`**` bold, `_` italic) around the selection.
 * Unwraps if the selection is already immediately wrapped; with a collapsed
 * caret, inserts the pair and places the caret between them.
 */
export function toggleWrap(value: string, start: number, end: number, marker: string): MarkdownEdit {
  const before = value.slice(Math.max(0, start - marker.length), start);
  const after = value.slice(end, end + marker.length);
  const selected = value.slice(start, end);

  if (start !== end && before === marker && after === marker) {
    return {
      replaceStart: start - marker.length,
      replaceEnd: end + marker.length,
      insert: selected,
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
    };
  }

  const insert = `${marker}${selected}${marker}`;
  const caretInside = start + marker.length;
  return {
    replaceStart: start,
    replaceEnd: end,
    insert,
    selectionStart: caretInside,
    selectionEnd: caretInside + selected.length,
  };
}

/**
 * `[selection](url)` with the caret left inside the parens ready to type the
 * url; a collapsed caret gives `[]()` with the caret inside the brackets.
 */
export function linkSelection(value: string, start: number, end: number): MarkdownEdit {
  const selected = value.slice(start, end);
  const insert = `[${selected}]()`;
  const caretInside = start === end ? start + 1 : start + 1 + selected.length + 2;
  return {
    replaceStart: start,
    replaceEnd: end,
    insert,
    selectionStart: caretInside,
    selectionEnd: caretInside,
  };
}

/** A single-line absolute URL: no internal whitespace (so a multi-line or
 *  multi-word clipboard paste never qualifies), starting with a URL scheme. */
export function isSingleLineAbsoluteUrl(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(trimmed);
}

/** Pasting a URL over a non-empty selection turns the selected text into a
 *  markdown link to that URL. Returns null for a collapsed caret or when the
 *  pasted text is not a single-line absolute URL. */
export function linkFromPastedUrl(value: string, start: number, end: number, pastedText: string): MarkdownEdit | null {
  if (start === end || !isSingleLineAbsoluteUrl(pastedText)) return null;
  const url = pastedText.trim();
  const selected = value.slice(start, end);
  const insert = `[${selected}](${url})`;
  return {
    replaceStart: start,
    replaceEnd: end,
    insert,
    selectionStart: start + insert.length,
    selectionEnd: start + insert.length,
  };
}

const STRUCTURAL_HTML_TAG_RE = /<(a|h[1-6]|ul|ol|li|pre|code|table|blockquote|strong|b|em|i)\b/i;

/**
 * Whether pasted `text/html` is worth converting to markdown, versus falling
 * through to the plain-text paste. Many apps set `text/html` on content that
 * is really just styled plain text (e.g. per-line `<div><span style=...>`
 * with no structural tags) - converting that would mangle indentation for no
 * gain. Convert only when the fragment has at least one element plain text
 * would lose: a link, heading, list, code block, table, blockquote, or
 * bold/italic run.
 *
 * Deliberately size-unbounded. Conversion parses and walks the tree
 * synchronously on the renderer's only thread, so a multi-megabyte paste (a
 * whole web page, a wide spreadsheet range) can stall the window - but nobody
 * has measured where that starts to hurt, and capping it silently downgrades a
 * large rich paste to plain text. Pick the threshold from a measurement before
 * adding one, and put it at the call site next to the preventDefault decision
 * rather than in here: a 600KB fragment IS worth converting, it is only
 * expensive, and this predicate should not answer a question it is not named
 * for.
 */
export function shouldConvertPastedHtml(html: string): boolean {
  return STRUCTURAL_HTML_TAG_RE.test(html);
}

/**
 * Apply an edit to a live textarea via `execCommand`, so the browser fires a
 * real `input` event (React's `onChange` and the mentions hook's
 * `onChangeCapture` both run, and the native undo stack gets one step instead
 * of being replaced wholesale). Falls back to a direct value/onChange update
 * plus a deferred `setSelectionRange` if `execCommand` is unsupported.
 */
export function applyTextareaEdit(
  textarea: HTMLTextAreaElement,
  edit: MarkdownEdit,
  onChange: (value: string) => void,
): void {
  textarea.focus();

  // Inserting nothing over a collapsed caret is a genuine no-op, and it has to
  // be handled before touching execCommand: `delete` on a collapsed range is a
  // backspace, so it would eat the character before the caret. That is
  // reachable from the paste path, where an HTML fragment can pass
  // shouldConvertPastedHtml and still convert to an empty string (`<strong>`
  // and `<em>` with no content both do), or the plain-text fallback can be ''.
  // The empty-insert edits worth applying (continueListOnEnter clearing a bare
  // marker) always cover a real range, so this guard never reaches them.
  if (edit.insert.length === 0 && edit.replaceStart === edit.replaceEnd) {
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    return;
  }

  textarea.setSelectionRange(edit.replaceStart, edit.replaceEnd);

  const applied =
    edit.insert.length > 0
      ? document.execCommand('insertText', false, edit.insert)
      : document.execCommand('delete');

  if (applied) {
    // Synchronous, deliberately NOT deferred to a frame. execCommand already
    // put the final text in the DOM, so React's re-render sees an unchanged
    // value and leaves the selection alone. Deferring instead would let a
    // queued callback from an earlier edit land after a later one (key
    // autorepeat on Enter outruns the frame rate) and yank the caret backward.
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    return;
  }

  // Fallback for a host where execCommand is unavailable: drive the value
  // through React and restore the selection after the re-render commits,
  // matching useDescriptionMentions' selectItem.
  const nextValue = `${textarea.value.slice(0, edit.replaceStart)}${edit.insert}${textarea.value.slice(edit.replaceEnd)}`;
  onChange(nextValue);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  });
}
