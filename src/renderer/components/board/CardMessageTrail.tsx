import type { AppConfig, AssistantMessageTrailEntry } from '../../../shared/types';

/**
 * The agent message trail a card prints in the slot its description used, shared
 * by the board card (`TaskCard`) and the Agent Monitor card (`MonitorCard`) so
 * the Card Preview setting means the same thing on both.
 *
 * In `lines` mode, one truncated line per message, newest last: older lines
 * keep the tone of the description they replaced; the newest is one step
 * brighter so the eye lands on it and the block reads as live. In `latest`
 * mode, the newest message alone, wrapped to the slot's clamp, for a reader who
 * would rather have one whole thought than three openings.
 *
 * FIXED height (one 16px `text-xs` line per slot) rather than content-sized,
 * for the reason `TaskCard`'s `CardStatusBar` gives: dnd-kit re-measures every
 * card below one that changes height mid-drag, and a grid of monitor cards
 * jittered when its wells were content-sized. A trail grows as the agent talks,
 * so a content-sized block would shift the lane on each of a fresh session's
 * first messages.
 */

/** Lines the slot holds: the board's clamp per density (1, 3, 5) and the monitor's row budget (2, 4). */
export type ExcerptLines = 1 | 2 | 3 | 4 | 5;

/** The description's own clamp at each line count, for the fallback that keeps content-sized. */
export const EXCERPT_CLAMP_CLASS: Record<ExcerptLines, string> = {
  1: 'truncate',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
};

/** One 16px `text-xs` line per slot. */
export const TRAIL_HEIGHT_CLASS: Record<ExcerptLines, string> = {
  1: 'h-4',
  2: 'h-8',
  3: 'h-12',
  4: 'h-16',
  5: 'h-20',
};

/** How the trail fills its slot: one truncated line per message, or the newest message alone wrapped to the clamp. */
export type TrailMode = 'lines' | 'latest';

/** The trail mode a Card Preview value asks for; null when the setting wants the description. */
export function trailModeFor(cardPreview: AppConfig['cardPreview']): TrailMode | null {
  if (cardPreview === 'agent-messages') return 'lines';
  if (cardPreview === 'agent-latest-message') return 'latest';
  return null;
}

export function CardMessageTrail({
  entries, lines, mode, olderLineClass, newestLineClass, testId = 'task-card-trail',
}: {
  entries: AssistantMessageTrailEntry[];
  lines: ExcerptLines;
  mode: TrailMode;
  olderLineClass: string;
  newestLineClass: string;
  testId?: string;
}) {
  if (mode === 'latest') {
    const newest = entries[entries.length - 1];
    if (!newest) return null;
    return (
      <div className={TRAIL_HEIGHT_CLASS[lines]} data-testid={testId} data-lines={lines} data-mode="latest">
        <div className={`text-xs ${EXCERPT_CLAMP_CLASS[lines]} ${newestLineClass}`}>{newest.text}</div>
      </div>
    );
  }
  const shown = entries.slice(-lines);
  return (
    <div className={`flex flex-col ${TRAIL_HEIGHT_CLASS[lines]}`} data-testid={testId} data-lines={lines} data-mode="lines">
      {shown.map((entry, index) => (
        <div
          key={entry.uuid}
          className={`text-xs truncate ${index === shown.length - 1 ? newestLineClass : olderLineClass}`}
        >
          {entry.text}
        </div>
      ))}
    </div>
  );
}
