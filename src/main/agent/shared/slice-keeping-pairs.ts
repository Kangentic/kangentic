/**
 * The first `maxChars` UTF-16 units of `text`, or one fewer when the cut would
 * split a surrogate pair (an emoji at the boundary). A lone surrogate prints as
 * U+FFFD and has no UTF-8 encoding, so an agent would read a broken character.
 */
export function sliceKeepingPairs(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lastKept = text.charCodeAt(maxChars - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? maxChars - 1 : maxChars;
  return text.slice(0, Math.max(end, 0));
}
