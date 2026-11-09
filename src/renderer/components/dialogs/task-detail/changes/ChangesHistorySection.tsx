import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { CountBadge } from '../../../CountBadge';
import { Tooltip } from '../../../Tooltip';
import { ChangesRailSection } from './ChangesRailSection';

interface ChangesHistorySectionProps {
  /** Expanded state (remembered across tasks; closed is the default). */
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
   *  is instant). */
  children: React.ReactNode;
}

/**
 * The Changes rail's History section, at the BOTTOM of the rail. The header row
 * is always visible; the body holds the commit graph at a per-task height,
 * resized by the handle ChangesPanel renders directly above this section while
 * open. A selected commit needs no marker here: the selection bar at the top of
 * the rail names it whether or not this section is open.
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
    <ChangesRailSection
      open={open}
      onToggle={onToggle}
      label={<Trans>History</Trans>}
      trailing={commitCount !== null && (
        // The pill widens with each digit, so the graph's 200-commit cap
        // renders without clipping. Tinted from the toggle's tone, so it
        // brightens with the label on hover.
        <Tooltip label={countTip}>
          <span className="inline-flex">
            <CountBadge count={commitCount} variant="tinted" size="pill" testId="changes-history-count" />
          </span>
        </Tooltip>
      )}
      testIdPrefix="changes-history"
      bodyHeight={bodyHeight}
      animateHeight={animateHeight}
    >
      {children}
    </ChangesRailSection>
  );
}
