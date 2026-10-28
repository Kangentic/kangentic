/**
 * GitHub's alert kinds (`> [!NOTE]` and the rest). The lazy pipeline reads a
 * blockquote's marker against them and MarkdownRenderer draws each one, so
 * they sit apart from the loader: the pipeline imports nothing from the
 * module that imports it.
 */

/** GitHub's five alert kinds, in the order GitHub's docs list them. */
export const MARKDOWN_ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;

export type MarkdownAlertKind = typeof MARKDOWN_ALERT_KINDS[number];

export function isMarkdownAlertKind(value: unknown): value is MarkdownAlertKind {
  return typeof value === 'string' && (MARKDOWN_ALERT_KINDS as readonly string[]).includes(value);
}
