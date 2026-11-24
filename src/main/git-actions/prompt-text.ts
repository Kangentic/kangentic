/** Text an agent reads, in a tag that says what it is. */
export function block(tag: string, text: string): string {
  return `<${tag}>\n${text}\n</${tag}>`;
}

/** `text` cut to `maxChars` from its start or its end, never through a surrogate pair. */
export function cutText(text: string, maxChars: number, keep: 'head' | 'tail' = 'head'): string {
  if (text.length <= maxChars) return text;
  if (keep === 'head') return text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, '');
  return text.slice(text.length - maxChars).replace(/^[\uDC00-\uDFFF]/, '');
}
