import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { CountBadge } from '../../../CountBadge';
import { Tooltip } from '../../../Tooltip';

/** Height (px) of the always-visible section header row. Shared with
 *  ChangesPanel's history resize math (the drag measures from the rail bottom,
 *  which includes this row). */
export const HISTORY_SECTION_HEADER_PX = 28;

interface ChangesHistorySectionProps {
  /** Expanded state (per task, persisted; open is the default). */
  open: boolean;
  onToggle: () => void;
  /** Body height (px) while open - live during a drag, stored otherwise. */
  bodyHeight: number;
  /** Commit count once the graph has loaded; null renders no badge. */
  commitCount: number | null;
  /** Whether the commit list hit its cap (the count is a floor, not a total). */
  truncated: boolean;
  /** What the commits belong to: the live task's branch (the default) or a completed task.
   *  Picks a whole sentence, so a translation can order the words as it needs to. */
  countScope?: 'branch' | 'task';
  /** False while the user is dragging the section's resize handle, so the
   *  height tracks the pointer 1:1 (never animate during a drag); the height
   *  transition applies only to the discrete open/close toggle. */
  animateHeight: boolean;
  /** The commit graph body (kept MOUNTED while collapsed - clipped to height 0
   *  - so the count stays live, the fs-watch listener survives, and expanding
   *  is instant. Fetch cadence is parity with the old always-on band, not a
   *  regression). */
  children: React.ReactNode;
}

/**
 * The Changes rail's History section: a VS Code-style collapsible section at
 * the BOTTOM of the rail, open by default. The header row is always visible;
 * the body holds the commit graph at a per-task height, resized by the handle
 * ChangesPanel renders directly above this section while open. A selected
 * commit needs no marker here: the selection bar at the top of the rail names
 * it whether or not this section is open.
 */
export function ChangesHistorySection({ open, onToggle, bodyHeight, commitCount, truncated, countScope = 'branch', animateHeight, children }: ChangesHistorySectionProps) {
  const { t } = useLingui();
  const countTip = commitCount === null
    ? ''
    : truncated
      ? t`Showing the latest ${plural(commitCount, { one: '# commit', other: '# commits' })}`
      : countScope === 'task'
        ? t`${plural(commitCount, { one: '# commit for this task', other: '# commits for this task' })}`
        : t`${plural(commitCount, { one: '# commit on this branch', other: '# commits on this branch' })}`;
  return (
    <div className="flex flex-col min-h-0 flex-shrink border-t border-edge" data-testid="changes-history-section">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-shrink-0 items-center gap-1.5 px-2 text-left text-fg-secondary hover:bg-surface-hover hover:text-fg transition-colors"
        style={{ height: HISTORY_SECTION_HEADER_PX }}
        data-testid="changes-history-toggle"
      >
        <ChevronRight size={14} className={`flex-shrink-0 text-fg-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-xs font-medium"><Trans>History</Trans></span>
        {commitCount !== null && (
          // The pill widens with each digit, so the graph's 200-commit cap
          // renders without clipping. Tinted from the toggle's tone, so it
          // brightens with the label on hover.
          <Tooltip label={countTip}>
            <span className="inline-flex">
              <CountBadge count={commitCount} variant="tinted" size="pill" testId="changes-history-count" />
            </span>
          </Tooltip>
        )}
      </button>
      {/* Mounted while collapsed, clipped to height 0 (see the children prop
          doc). The height transition fires only on the open/close CHANGE, so a
          hydrated-open restore paints at its final height with no replay, and
          a drag (animateHeight false) tracks the pointer 1:1. */}
      <div
        className={`min-h-0 overflow-hidden ${animateHeight ? 'transition-[height] duration-200 ease-out motion-reduce:transition-none [.no-motion_&]:transition-none' : ''}`}
        style={{ height: open ? bodyHeight : 0 }}
        aria-hidden={open ? undefined : true}
      >
        {children}
      </div>
    </div>
  );
}
