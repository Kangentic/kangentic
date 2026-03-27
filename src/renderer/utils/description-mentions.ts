export interface DescriptionMentionTrigger {
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r';
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? '')) {
    index -= 1;
  }
  return index + 1;
}

export function detectDescriptionMentionTrigger(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): DescriptionMentionTrigger | null {
  if (selectionStart !== selectionEnd) return null;

  const cursor = clampCursor(text, selectionStart);
  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (!token.startsWith('@')) return null;

  return {
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceDescriptionRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return {
    text: nextText,
    cursor: safeStart + replacement.length,
  };
}

export function extendDescriptionMentionRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string,
): number {
  if (!replacement.endsWith(' ')) return rangeEnd;
  return text[rangeEnd] === ' ' ? rangeEnd + 1 : rangeEnd;
}

export function basenameOfMentionPath(pathValue: string): string {
  const slashIndex = pathValue.lastIndexOf('/');
  if (slashIndex === -1) return pathValue;
  return pathValue.slice(slashIndex + 1);
}
