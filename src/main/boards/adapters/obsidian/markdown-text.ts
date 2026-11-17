/**
 * Reading Obsidian's inline syntax out of note text: tags, and the lines that
 * sit inside a code block, where nothing is a tag, a task or an embed.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;
// A tag is `#` after the start of a line or whitespace, then letters, digits,
// `_`, `-` or `/`. Obsidian treats a tag made only of digits as text.
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;

/**
 * For each line, whether it sits inside a fenced code block (fences included).
 * A fence closes only on the same character, at least as long as the one that
 * opened it, so a ``` line inside a ~~~ block is code, not a close.
 */
export function codeLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let openFence: string | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line)?.[1];
    if (fence && (openFence === null || (fence[0] === openFence[0] && fence.length >= openFence.length))) {
      mask.push(true);
      openFence = openFence === null ? fence : null;
      continue;
    }
    mask.push(openFence !== null);
  }
  return mask;
}

/** A tag's text as Obsidian reads it: a trailing `/` dropped, and nothing for a tag made only of digits. */
function tagText(raw: string): string | null {
  const tag = raw.replace(/\/+$/, '');
  return tag !== '' && /\D/.test(tag) ? tag : null;
}

/** The inline `#tags` in a piece of text, without the `#`, outside inline code. */
export function inlineTags(text: string): string[] {
  const withoutCode = text.replace(INLINE_CODE, ' ');
  const tags: string[] = [];
  for (const match of withoutCode.matchAll(INLINE_TAG)) {
    const tag = tagText(match[1]);
    if (tag) tags.push(tag);
  }
  return tags;
}

/**
 * The text with each tag `inlineTags` reads taken out. A digit-only `#123` and
 * anything inside inline code stay as written.
 */
export function stripInlineTags(text: string): string {
  let result = '';
  let position = 0;
  for (const code of text.matchAll(INLINE_CODE)) {
    const start = code.index ?? 0;
    result += stripTagsOutsideCode(text.slice(position, start)) + code[0];
    position = start + code[0].length;
  }
  return result + stripTagsOutsideCode(text.slice(position));
}

function stripTagsOutsideCode(text: string): string {
  return text.replace(INLINE_TAG, (whole, raw: string) => (tagText(raw) ? ' ' : whole));
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
