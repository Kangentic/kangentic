/**
 * Reading Obsidian's inline syntax out of note text: tags, and the lines that
 * sit inside a code block, where nothing is a tag, a task or an embed.
 */

const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`[^`\n]*`/g;
// A tag is `#` after the start of a line or whitespace, then letters, digits,
// `_`, `-` or `/`. Obsidian treats a tag made only of digits as text.
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;

/** For each line, whether it sits inside a fenced code block (fences included). */
export function codeLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      mask.push(true);
      inFence = !inFence;
      continue;
    }
    mask.push(inFence);
  }
  return mask;
}

/** The inline `#tags` in a piece of text, without the `#`, outside inline code. */
export function inlineTags(text: string): string[] {
  const withoutCode = text.replace(INLINE_CODE, ' ');
  const tags: string[] = [];
  for (const match of withoutCode.matchAll(INLINE_TAG)) {
    const tag = match[1].replace(/\/+$/, '');
    if (tag !== '' && /\D/.test(tag)) tags.push(tag);
  }
  return tags;
}

/** The inline tags of a whole note body, code blocks left out. */
export function bodyTags(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const mask = codeLineMask(lines);
  return lines.flatMap((line, index) => (mask[index] ? [] : inlineTags(line)));
}

/** Tags without a leading `#`, first spelling kept, duplicates dropped regardless of case. */
export function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.replace(/^#+/, '').trim();
    if (tag === '' || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result;
}

/** The file name without its folder or its `.md`. */
export function noteName(vaultPath: string): string {
  const fileName = vaultPath.split('/').pop() ?? vaultPath;
  return fileName.replace(/\.md$/i, '');
}
