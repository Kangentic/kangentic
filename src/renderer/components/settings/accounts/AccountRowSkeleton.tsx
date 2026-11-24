import { RateLimitTrack } from '../../terminal/rate-limit-meter';
import { CardTile, SKELETON_BAR_CLASS } from '../settings-card';
import {
  ACCOUNT_ROW_TOP_LINE_CLASS,
  ACCOUNT_USAGE_GRID_CLASS,
  ACCOUNT_USAGE_PERCENT_CELL_CLASS,
  ACCOUNT_USAGE_RESET_CELL_CLASS,
} from './account-row-layout';

/**
 * One usage line of the skeleton row, in the cells `AccountRow`'s usage grid lays out: the window's
 * icon and name, the track with its percent, and the reset time. The track is the real empty one, as
 * a window that has not started draws it.
 */
function SkeletonUsageLine() {
  return (
    <>
      <span className="flex h-4 items-center gap-1.5">
        <span className="h-[11px] w-[11px] rounded-full bg-fg/[0.08]" />
        <span className={`h-3 w-[60px] ${SKELETON_BAR_CLASS}`} />
      </span>
      <span className="flex h-4 min-w-0 items-center gap-1.5">
        <RateLimitTrack limitWindow={null} now={0} className="min-w-[40px] flex-1" />
        <span className={`flex justify-end ${ACCOUNT_USAGE_PERCENT_CELL_CLASS}`}>
          <span className={`h-3 w-6 ${SKELETON_BAR_CLASS}`} />
        </span>
      </span>
      <span className={`h-4 gap-1.5 ${ACCOUNT_USAGE_RESET_CELL_CLASS}`}>
        <span className="h-[11px] w-[11px] rounded-full bg-fg/[0.08]" />
        <span className={`h-3 w-12 ${SKELETON_BAR_CLASS}`} />
      </span>
    </>
  );
}

/**
 * An account row with nothing known yet (task #1202), on `AccountRow`'s own layout classes
 * (`account-row-layout.ts`): the 24px top line, then the usage grid with two lines, so the real row
 * lands in its place at the same height. A first launch has one account, which shows no Active or
 * Switch to, so it has no action slot. Nothing moves.
 */
export function AccountRowSkeleton() {
  return (
    <CardTile className="flex flex-col" testId="account-row-skeleton">
      <div className={ACCOUNT_ROW_TOP_LINE_CLASS} aria-hidden="true">
        <span className={`h-3 w-[118px] ${SKELETON_BAR_CLASS}`} />
        <span className="h-[18px] w-[34px] flex-shrink-0 rounded border border-edge" />
      </div>
      <div className={ACCOUNT_USAGE_GRID_CLASS} aria-hidden="true">
        <SkeletonUsageLine />
        <SkeletonUsageLine />
      </div>
    </CardTile>
  );
}
