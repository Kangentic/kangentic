/**
 * Convert Azure DevOps rich-text HTML work item descriptions and
 * comments into Markdown. Azure returns HTML for these fields; every
 * other board adapter Kangentic supports (GitHub, Linear, Jira,
 * Asana, Trello) uses Markdown natively, so we normalize here.
 *
 * Pure string parsing - no DOM dependency, no Azure-specific state.
 * Lives alongside the Azure DevOps adapter because that's its only
 * consumer, but the logic itself is generic HTML->Markdown.
 *
 * Tested in tests/unit/azure-devops-html-converter.test.ts.
 */

/**
 * Strip all HTML tags from a string, repeating until nothing changes.
 *
 * One pass of this regex is in fact already a fixed point: a `<` survives a
 * pass only when it has no `>` after it or is immediately followed by one, and
 * removing text can never introduce a `>`. So the loop is a guard against a
 * future edit to the pattern, not a fix for a reachable input today.
 */
function stripTags(html: string): string {
  let previous = '';
  let current = html;
  while (current !== previous) {
    previous = current;
    current = current.replace(/<[^>]+>/g, '');
  }
  return current;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
};

/**
 * A numeric entity's code point, or null when it is outside Unicode's range.
 *
 * `String.fromCharCode` truncates to 16 bits, so every astral character came
 * out as an unrelated private-use one: an emoji written `&#128512;` decoded to
 * U+F600 rather than U+1F600. `fromCodePoint` pairs the surrogates instead, but
 * it THROWS above U+10FFFF where `fromCharCode` silently wrapped, so an absurd
 * entity has to be caught here and left as the author wrote it rather than
 * taking the whole work-item description down.
 */
function codePointOrNull(digits: string, radix: number): number | null {
  const codePoint = parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return null;
  return codePoint;
}

/**
 * Decode common HTML entities, exactly one level deep.
 *
 * One pass over an alternation, not a chain of `.replace()` calls, because no
 * ordering of a chain decodes exactly one level for every input. Whichever
 * entity runs first is the one that can be re-fed to a later pass: with `&amp;`
 * first, `&amp;lt;` decodes twice and a work item that literally says `&lt;`
 * renders as a stray angle bracket; with `&amp;` last, `&#38;amp;` decodes
 * twice instead. A single pass resumes scanning AFTER each replacement, so
 * nothing an entity decodes into can be read as part of another entity.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/gi,
    (match, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const codePoint = decimal !== undefined
        ? codePointOrNull(decimal, 10)
        : codePointOrNull(hex ?? '', 16);
      return codePoint === null ? match : String.fromCodePoint(codePoint);
    },
  );
}

/** Convert HTML (from Azure DevOps rich text) to markdown. */
export function convertHtmlToMarkdown(html: string): string {
  if (!html) return '';

  let result = html;

  // Handle line breaks and horizontal rules
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // Handle headings (h1 through h6)
  for (let level = 1; level <= 6; level++) {
    const prefix = '#'.repeat(level);
    const pattern = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    result = result.replace(pattern, (_, content) => `${prefix} ${stripTags(content).trim()}\n\n`);
  }

  // Handle code blocks (before inline code to avoid conflicts)
  result = result.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, content) => `\n\`\`\`\n${decodeEntities(content)}\n\`\`\`\n`);
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => `\n\`\`\`\n${decodeEntities(stripTags(content))}\n\`\`\`\n`);

  // Handle inline code
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => `\`${decodeEntities(content)}\``);

  // Handle bold and italic
  result = result.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  result = result.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // Handle links
  result = result.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Handle images
  result = result.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*?)["'][^>]*\/?>/gi, '![$2]($1)');
  result = result.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, '![]($1)');

  // Handle unordered lists
  result = result.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_fullMatch: string, itemContent: string) => `- ${stripTags(itemContent).trim()}\n`);
  });

  // Handle ordered lists
  result = result.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    let counter = 0;
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_fullMatch: string, itemContent: string) => {
      counter++;
      return `${counter}. ${stripTags(itemContent).trim()}\n`;
    });
  });

  // Handle paragraphs
  result = result.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // Handle divs (treat as block elements)
  result = result.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n');

  // Strip remaining HTML tags
  result = stripTags(result);

  // Decode HTML entities
  result = decodeEntities(result);

  // Clean up excessive whitespace
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.trim();

  return result;
}
