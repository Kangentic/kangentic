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

/** Strip all HTML tags from a string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
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
