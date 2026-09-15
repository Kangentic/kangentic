import type { AssistantMessageTrailEntry, TranscriptEntry } from '../../../shared/types';

/**
 * An agent's recent assistant prose, collapsed to plain one-line previews.
 *
 * Two consumers read the same function so they cannot disagree about what the
 * agent last said: the mobile bridge's session list (one line per session, see
 * `lastAssistantPreview`) and the desktop board card's message trail (the
 * newest few lines, see `assistantMessagePreviews`). The mobile line rides the
 * activity feed the phone already receives, replacing a per-session
 * transcript-window request that measured 2.3 to 34.6 KB and 0.7 to 3.8
 * seconds of desktop work each; the board trail rides a main-side tail read
 * pushed on change, never a per-card transcript fetch.
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

export interface AssistantMessagePreviewOptions {
  /** How many of the newest prose-bearing assistant entries to return. */
  count: number;
  /** Hard cap on each returned line. Sliced, not word-wrapped: the card truncates anyway. */
  maxChars: number;
}

/**
 * The newest `count` assistant entries that still say something once
 * decoration is stripped, oldest first, each collapsed to one plain line.
 *
 * Walks back from the end and stops as soon as `count` are found, so the cost
 * is bounded by how far back the prose is, not by the transcript's length. An
 * entry that is tool-use only, or decoration through and through, is skipped
 * without consuming a slot. Each result carries the entry's uuid so a caller
 * accumulating across reads can tell a new line from one it already holds.
 */
export function assistantMessagePreviews(
  entries: readonly TranscriptEntry[],
  { count, maxChars }: AssistantMessagePreviewOptions,
): AssistantMessageTrailEntry[] {
  if (count <= 0) return [];
  const found: AssistantMessageTrailEntry[] = [];
  for (let index = entries.length - 1; index >= 0 && found.length < count; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'assistant') continue;
    const text = entry.blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text.length === 0) continue;
    const collapsed = collapseToPreviewText(text);
    if (collapsed.length === 0) continue;
    found.push({
      uuid: entry.uuid,
      ts: entry.ts,
      text: collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed,
    });
  }
  found.reverse();
  return found;
}

/**
 * The newest assistant text in the transcript that still says something once
 * decoration is stripped, capped for a two-line phone card. Returns null when
 * no assistant entry carries prose - the caller then sends nothing rather than
 * blanking a preview the phone already has.
 */
export function lastAssistantPreview(entries: readonly TranscriptEntry[]): string | null {
  return assistantMessagePreviews(entries, { count: 1, maxChars: MESSAGE_PREVIEW_MAX_CHARS })[0]?.text ?? null;
}
