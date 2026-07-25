import type { TranscriptEntry } from '../../shared/types';

/**
 * The one line a phone's session list shows under a task title: the agent's
 * most recent assistant text, collapsed to plain prose.
 *
 * Kept small on purpose. This rides on the activity feed the phone already
 * receives, replacing a per-session transcript-window request that measured
 * 2.3 to 34.6 KB (to keep a string under 200 characters) and 0.7 to 3.8
 * seconds of desktop work each.
 */
export const MESSAGE_PREVIEW_MAX_CHARS = 200;

/** A line that is pure decoration: rules, box-drawing, table borders, dash/ellipsis runs. */
const DECORATION_ONLY_LINE = /^[\s\-=_*~#>|+:.·‒-―…−⋯⎯⏤─-╿▀-▟]+$/;
/** A code-fence delimiter line (```ts, ~~~). */
const CODE_FENCE_LINE = /^(?:`{3,}|~{3,})[\w-]*$/;
/** Leading markdown structure markers: headings, blockquotes, bullets, ordered lists. */
const LEADING_STRUCTURE_MARKERS = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,3}[.)]\s+)+/;
/**
 * Terminal-UI chrome a phone has no glyph for, so it renders as tofu boxes:
 * Miscellaneous Technical (agent status indicators), the private-use area
 * (icon fonts), variation selectors, and the replacement character.
 */
const UNRENDERABLE_CHROME = /[\u2300-\u23FF\uE000-\uF8FF\uFFFD]/gu;
const VARIATION_SELECTORS = /[\uFE00-\uFE0F]/gu;

/** Collapse markdown prose to a single plain line; empty when it was decoration through and through. */
function collapseToPreviewText(text: string): string {
  const keptLines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (CODE_FENCE_LINE.test(line)) continue;
    if (DECORATION_ONLY_LINE.test(line)) continue;
    keptLines.push(line.replace(LEADING_STRUCTURE_MARKERS, ''));
  }
  return keptLines
    .join(' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(UNRENDERABLE_CHROME, '')
    .replace(VARIATION_SELECTORS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The newest assistant text in the transcript that still says something once
 * decoration is stripped, capped for a two-line card. Returns null when no
 * assistant entry carries prose - the caller then sends nothing rather than
 * blanking a preview the phone already has.
 */
export function lastAssistantPreview(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'assistant') continue;
    const text = entry.blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text.length === 0) continue;
    const collapsed = collapseToPreviewText(text);
    if (collapsed.length === 0) continue;
    return collapsed.length > MESSAGE_PREVIEW_MAX_CHARS ? collapsed.slice(0, MESSAGE_PREVIEW_MAX_CHARS) : collapsed;
  }
  return null;
}
