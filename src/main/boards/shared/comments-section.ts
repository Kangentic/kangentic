import { convertHtmlToMarkdown } from './html-to-markdown';

/** One comment, as a provider's adapter hands it over: rendered HTML plus who and when. */
export interface ImportedComment {
  author: string | null;
  /** ISO 8601 instant. */
  createdAt: string;
  /** The comment body as HTML (ADO's `text`, Jira's `renderedBody`). */
  html: string;
}

/**
 * Format comments as the `## Comments` section an imported item's description
 * ends with. Shared by every adapter that folds comments in at import time
 * (Azure DevOps, Jira), so the section reads the same whatever the provider.
 */
export function formatCommentsSection(comments: ImportedComment[]): string {
  const lines = ['## Comments', ''];
  for (const comment of comments) {
    const author = comment.author?.trim() || 'Unknown';
    lines.push(`### ${author} - ${formatCommentDate(comment.createdAt)}`);
    lines.push('');
    lines.push(convertHtmlToMarkdown(comment.html));
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Format an ISO date string for comment display. */
function formatCommentDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch { // report-ok: a date the provider sent malformed shows as sent; nothing else depends on it
    return isoDate;
  }
}
