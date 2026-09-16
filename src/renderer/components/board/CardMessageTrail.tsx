import type { ReactNode } from 'react';
import type { AppConfig, AssistantMessageTrailEntry } from '../../../shared/types';

/**
 * The agent message trail a card prints in the slot its description used, shared
 * by the board card (`TaskCard`) and the Agent Monitor card (`MonitorCard`) so
 * the Card Preview setting means the same thing on both.
 *
 * In `lines` mode, one truncated line per message, newest last. In `latest` mode
 * (the shipped default), the newest message alone, wrapped to the slot's clamp,
 * for a reader who would rather have one whole thought than three openings.
 *
 * TONE carries nothing here. It used to: older lines kept the description's
 * `fg-faint` and the newest was one step brighter, which was asked to mean both
 * "less important" and "live" and delivered neither. In `latest` mode it could
 * not even try, since the whole block IS the newest message. What separates the
 * two contents of this slot is now the CONTAINER and the CONDITION:
 *
 *   - `terminal` puts the block in `OutputPeek`'s own well (`MonitorCard`), so a
 *     running agent reads as the terminal rather than as card copy. Both cards
 *     pass it; it is a prop rather than a constant only so a caller that wants
 *     the bare form still has one.
 *   - Callers show a trail only while the session is RUNNING, the same condition
 *     the activity mark renders for, and fall back to the description otherwise.
 *     That is theirs to enforce, not this component's, because each card already
 *     owns its own fallback. It matters because a trail outlives its session
 *     (`message-trail-tracker.ts`), so without it a paused or Done card printed
 *     agent prose with no glyph and no bar to say so.
 *
 * FIXED height (one 16px `text-xs` line per slot) rather than content-sized,
 * for the reason `TaskCard`'s `CardStatusBar` gives: dnd-kit re-measures every
 * card below one that changes height mid-drag, and a grid of monitor cards
 * jittered when its wells were content-sized. A trail grows as the agent talks,
 * so a content-sized block would shift the lane on each of a fresh session's
 * first messages. The well adds its own 12px of padding on top of that height,
 * which is constant while the agent talks and steps only when a session starts
 * or stops, exactly as the footer already does.
 */

/** Lines the slot holds: the clamp per card density (1, 3, 5), shared by both cards. */
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

/**
 * The well both agent-output forms share, minus its margin (each card supplies
 * its own slot spacing). `MonitorCard`'s `OutputPeek` imports this rather than
 * repeating the classes, so the trail and the terminal peek cannot drift into
 * two slightly different boxes on the one grid that shows both.
 *
 * It lives here rather than in `MonitorCard` because the board card uses it too
 * and must not depend on a monitor module.
 */
export const TRAIL_WELL_CLASS = 'rounded bg-surface-hover/50 px-2 py-1.5 font-mono text-xs leading-4';

/** How the trail fills its slot: one truncated line per message, or the newest message alone wrapped to the clamp. */
export type TrailMode = 'lines' | 'latest';

/** The trail mode a Card Preview value asks for; null when the setting wants the description. */
export function trailModeFor(cardPreview: AppConfig['cardPreview']): TrailMode | null {
  if (cardPreview === 'agent-messages') return 'lines';
  if (cardPreview === 'agent-latest-message') return 'latest';
  return null;
}

export function CardMessageTrail({
  entries, lines, mode, lineClass, terminal = false, testId = 'task-card-trail',
}: {
  entries: AssistantMessageTrailEntry[];
  lines: ExcerptLines;
  mode: TrailMode;
  /** Tone for every line. One value, not a pair: see the note on TONE above. */
  lineClass: string;
  /** Render inside `OutputPeek`'s well, which is what both cards do. */
  terminal?: boolean;
  testId?: string;
}) {
  // The inner box keeps the fixed height in both modes, so the well always wraps
  // a box whose height never depends on what the agent said.
  const inWell = (inner: ReactNode) => (
    <div
      className={terminal ? TRAIL_WELL_CLASS : undefined}
      data-testid={testId}
      data-lines={lines}
      data-mode={mode}
      data-terminal={terminal ? 'true' : undefined}
    >
      {inner}
    </div>
  );

  if (mode === 'latest') {
    const newest = entries[entries.length - 1];
    if (!newest) return null;
    return inWell(
      // `break-words` because this is prose in a monospace face inside a narrow
      // column: a path or a URL longer than the well would otherwise push its
      // own line past the clamp instead of wrapping into it.
      <div className={`overflow-hidden ${TRAIL_HEIGHT_CLASS[lines]}`}>
        <div className={`text-xs break-words ${EXCERPT_CLAMP_CLASS[lines]} ${lineClass}`}>{newest.text}</div>
      </div>,
    );
  }
  return inWell(
    <div className={`flex flex-col overflow-hidden ${TRAIL_HEIGHT_CLASS[lines]}`}>
      {entries.slice(-lines).map((entry) => (
        <div key={entry.uuid} className={`text-xs truncate ${lineClass}`}>
          {entry.text}
        </div>
      ))}
    </div>,
  );
}
