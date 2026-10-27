import { Bot } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { BackgroundCallTotals, BackgroundModelCount, BackgroundUsage } from '../../../shared/types';
import { BACKGROUND_CALL_JOB_LABELS } from '../../../shared/background-call-jobs';
import { translateText } from '../../i18n/translate';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost } from '../../utils/format-session';
import { Tooltip } from '../Tooltip';
import {
  backgroundCallsTitle,
  backgroundMetricText,
  backgroundModelLine,
  backgroundTokens,
  formatCallCount,
} from './background-display';

interface BackgroundCellProps {
  label: string;
  totals: BackgroundCallTotals;
  models: readonly BackgroundModelCount[];
  metric: UsageMetricMode;
  /** The cell's last line: the model line for a job, the other metric for Total. */
  footnote: string;
  isTotal: boolean;
  /** Extra classes for the cell's position in the grid (its left rule). */
  positionClassName: string;
  testId: string;
}

function BackgroundCell({ label, totals, models, metric, footnote, isTotal, positionClassName, testId }: BackgroundCellProps) {
  const value = backgroundMetricText(totals, metric);
  return (
    <Tooltip label={backgroundCallsTitle(totals, models)}>
      <div
        className={`min-w-0 flex flex-col gap-0.5 ${positionClassName}`}
        data-testid={testId}
      >
        <span className="text-[11px] uppercase tracking-wider text-fg-muted truncate">{label}</span>
        <span
          className={`font-semibold tabular-nums truncate ${isTotal ? 'text-base' : 'text-sm'} ${value === null ? 'text-fg-faint' : 'text-fg'}`}
          data-testid={`${testId}-value`}
        >
          {value ?? '-'}
        </span>
        <span className="text-[11px] text-fg-muted tabular-nums truncate">{formatCallCount(totals.calls)}</span>
        {footnote && <span className="text-[11px] text-fg-faint truncate">{footnote}</span>}
      </div>
    </Tooltip>
  );
}

/** The Total cell's last line: the metric the toggle is NOT showing, so both
 *  totals are on screen whichever way it is set. */
function otherMetricLine(totals: BackgroundCallTotals, metric: UsageMetricMode): string {
  if (metric === 'cost') {
    if (totals.reportedCalls === 0) return '';
    const tokenCount = formatTokenCount(backgroundTokens(totals));
    return i18n._(msg`${tokenCount} tokens`);
  }
  return totals.costUsd === null ? '' : formatCost(totals.costUsd);
}

/**
 * The headless agent calls Kangentic made on the user's behalf in the range
 * (Condition checks, workflow step checks, task summaries, task titles and
 * terminal names), as their own card under the KPI strip. These are never
 * added to the session tiles above: none of them is a session.
 *
 * A Total cell and one cell per job, each with its value in the selected
 * metric, its call count, and the model it ran on. Collapses from six columns
 * to three by container width, so it holds at the 900px window floor with a
 * wide sidebar.
 */
export function BackgroundCard({ background, metric }: { background: BackgroundUsage | undefined; metric: UsageMetricMode }) {
  const { t } = useLingui();
  // Optional: a payload cached from an older build has no Background figures,
  // which reads the same as a range with no calls.
  const totals = background?.totals;
  const hasCalls = totals !== undefined && totals.calls > 0;
  const allModels = background ? background.byJob.flatMap((job) => job.models) : [];

  return (
    <section
      aria-label={t`Background calls`}
      className="@container bg-surface-raised border border-edge rounded-lg px-4 py-3"
      data-testid="background-card"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Bot size={14} className="text-fg-muted flex-shrink-0" aria-hidden />
        <span className="text-[11px] uppercase tracking-wider text-fg-muted flex-shrink-0"><Trans>Background</Trans></span>
        <span className="text-[11px] text-fg-faint truncate">
          <Trans>Headless agent calls Kangentic makes for you, kept out of the totals above</Trans>
        </span>
      </div>
      {!hasCalls || !background ? (
        <div className="text-sm text-fg-faint pt-3.5 pb-1" data-testid="background-card-empty">
          <Trans>No background calls in this range</Trans>
        </div>
      ) : (
        <div className="grid grid-cols-3 @[720px]:grid-cols-6 gap-y-3 mt-2.5">
          <BackgroundCell
            label={t`Total`}
            totals={background.totals}
            models={allModels}
            metric={metric}
            footnote={otherMetricLine(background.totals, metric)}
            isTotal
            positionClassName="pr-3.5"
            testId="background-total"
          />
          {background.byJob.map((job, index) => (
            <BackgroundCell
              key={job.job}
              label={translateText(BACKGROUND_CALL_JOB_LABELS[job.job])}
              totals={job}
              models={job.models}
              metric={metric}
              footnote={backgroundModelLine(job.models)}
              isTotal={false}
              // The cell that starts the second row of the three-column layout
              // (index 2 here, the fourth cell overall) drops its rule there.
              positionClassName={index === 2
                ? 'pr-3.5 @[720px]:pl-3.5 @[720px]:border-l @[720px]:border-edge'
                : 'px-3.5 border-l border-edge'}
              testId={`background-job-${job.job}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
