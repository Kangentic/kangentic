/**
 * The document variant's rehype pipeline. Reached ONLY through the dynamic
 * import in markdown-document-plugins.ts: a static import from anywhere else
 * puts parse5 back on the startup path, and the build's lazy-chunk check fails.
 *
 * The order is load-bearing:
 * 1. rehype-raw parses the HTML a README carries (`<p align="center">`,
 *    `<picture>`) into real nodes.
 * 2. rehype-slug gives each heading GitHub's id for it.
 * 3. rehype-sanitize keeps GitHub's allowed set and prefixes every id it keeps
 *    with `user-content-`. Slug runs before it so heading ids get the prefix
 *    too: an unprefixed id could collide with the app's own (a README heading
 *    "Root" beside the app's `#root`). The link handler adds the prefix back
 *    when it follows `#section` (anchorElementIds in markdown-repo-link.ts).
 * 4. GitHub alerts run after the sanitizer, which strips the `data-*`
 *    attribute they add. That order also means a `<div data-alert>` written in
 *    the document itself never survives to pass as one.
 */
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import { isMarkdownAlertKind } from './markdown-alert-kinds';
import type { DocumentRehypePlugins } from './markdown-document-plugins';

type AttributeLists = NonNullable<SanitizeSchema['attributes']>;

/**
 * GitHub's schema with `title` dropped from every element: the renderer shows
 * no native tooltips (.claude/rules/one-tooltip.md), and a document's own
 * `title` attribute would be one.
 */
function withoutTitleAttribute(attributes: AttributeLists): AttributeLists {
  const filtered: AttributeLists = {};
  for (const [tagName, definitions] of Object.entries(attributes)) {
    filtered[tagName] = (definitions ?? []).filter((definition) => definition !== 'title');
  }
  return filtered;
}

export const DOCUMENT_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: withoutTitleAttribute(defaultSchema.attributes ?? {}),
};

/** `[!NOTE]` and its siblings, alone on the first line of a blockquote, any case, as GitHub reads them. */
const ALERT_MARKER = /^\[!([a-z]+)\][ \t]*(?:\r?\n|$)/i;

function firstElementChild(node: Element): Element | null {
  for (const child of node.children) {
    if (child.type === 'element') return child;
    if (child.type === 'text' && child.value.trim() !== '') return null;
  }
  return null;
}

/**
 * Turn a blockquote that opens with an alert marker into the alert's `div`,
 * marker removed. The renderer draws its icon and title from `data-alert`.
 */
function convertAlert(blockquote: Element): void {
  const paragraph = firstElementChild(blockquote);
  if (paragraph === null || paragraph.tagName !== 'p') return;
  const leadingText = paragraph.children[0];
  if (leadingText === undefined || leadingText.type !== 'text') return;
  const match = ALERT_MARKER.exec(leadingText.value);
  if (match === null) return;
  const kind = match[1].toLowerCase();
  if (!isMarkdownAlertKind(kind)) return;

  leadingText.value = leadingText.value.slice(match[0].length);
  if (leadingText.value === '') paragraph.children.shift();
  // `> [!NOTE]` on a line of its own, then a blank `>` line: the marker was
  // the whole paragraph, so nothing of it is left to show.
  const emptied = paragraph.children.every((child) => child.type === 'text' && child.value.trim() === '');
  if (emptied) blockquote.children = blockquote.children.filter((child) => child !== paragraph);

  blockquote.tagName = 'div';
  blockquote.properties = { dataAlert: kind };
}

function visitAlerts(children: Array<RootContent | ElementContent>): void {
  for (const child of children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'blockquote') convertAlert(child);
    visitAlerts(child.children);
  }
}

/** The rehype step for GitHub alerts (`> [!NOTE]`, `> [!WARNING]`, ...). */
export function rehypeGithubAlerts() {
  return (tree: Root): void => {
    visitAlerts(tree.children);
  };
}

export const DOCUMENT_REHYPE_PLUGINS: DocumentRehypePlugins = [
  rehypeRaw,
  rehypeSlug,
  [rehypeSanitize, DOCUMENT_SANITIZE_SCHEMA],
  rehypeGithubAlerts,
];
