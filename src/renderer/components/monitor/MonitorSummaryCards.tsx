import type { ReactNode } from 'react';
import { Mail, Loader2, CirclePause, FolderGit2 } from 'lucide-react';
import type { MonitorSessionRow } from '../../../shared/types';
import { useValuePulse } from '../../hooks/useValuePulse';
import { formatRelativeTime } from '../../lib/datetime';
import { summarize } from './monitor-view-model';

/**
 * The at-a-glance row above the controls.
 *
 * Proportioned after the usage dashboard's HERO tiles rather than its compact
 * ones - big numeral, roomy padding, a supporting line underneath - because on a
 * developer's monitor there is height to spare and a 48px tile with a 12px
 * numeral wastes it. No sparkline: these are instantaneous counts, not series,
 * and a fake trendline would imply history the tile does not have.
 *
 * Each tile carries its state's own tone, and only when the count is non-zero:
 * an amber "Needs you" reads as a call to action, whereas an amber ZERO would be
 * an alarm about nothing.
 *
 * Sized, not stretched. Filling the width with `grid-cols-4` gave four 640px
 * tiles of mostly empty card on a 2560px display, which is why the first version
 * of this band was pulled.
 */

interface SummaryTileProps {
  label: string;
  icon: ReactNode;
  value: number;
  sub?: string;
  title: string;
  testId: string;
  /** Applied to the numeral and the icon chip only while `value > 0`. */
  tone?: 'attention' | 'active';
}

function SummaryTile({ label, icon, value, sub, title, testId, tone }: SummaryTileProps) {
  // A constant resetKey is correct here (rather than a project id): the monitor
  // is a machine-global aggregate that never re-points to another context, so
  // there is no restore to suppress - every change IS a live change worth pulsing.
  const pulseRef = useValuePulse(String(value), { resetKey: 'monitor' });
  const lit = value > 0 && tone;

  return (
    <div
      className="w-[224px] flex-shrink-0 bg-surface-raised border border-edge rounded-lg px-4 pt-3 pb-3 flex flex-col"
      data-testid={testId}
      title={title}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0 ${
            lit === 'attention' ? 'bg-attention/10 text-attention'
              : lit === 'active' ? 'bg-active/10 text-active'
                : 'bg-surface-hover/60 text-fg-faint'
          }`}
          aria-hidden
        >
          {icon}
        </span>
        <span className="text-[11px] uppercase tracking-wider text-fg-muted truncate">{label}</span>
      </div>

      <span
        ref={pulseRef}
        className={`text-3xl font-semibold tabular-nums leading-none mt-2.5 ${
          lit === 'attention' ? 'text-attention' : lit === 'active' ? 'text-active' : 'text-fg'
        }`}
        data-testid={`${testId}-value`}
      >
        {value}
      </span>

      {/* Reserved whether or not there is a sub-line, so a tile that gains one
          later does not grow taller than its neighbours mid-session. */}
      <span className="text-[11px] text-fg-muted truncate mt-1.5 min-h-[15px]">{sub ?? ''}</span>
    </div>
  );
}

export function MonitorSummaryCards({ rows }: { rows: MonitorSessionRow[] }) {
  const { counts, projectCount, oldestNeedsYouSince, workingProjectCount, lastActiveAt } = summarize(rows);

  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3" data-testid="monitor-summary">
      {/* Labels use the app's own activity words (idle / active), the same ones
          the sidebar dots and board cards speak. */}
      <SummaryTile
        label="Idle"
        icon={<Mail size={14} />}
        value={counts['needs-you']}
        // The count alone always prompts "for how long?"; answer it here.
        sub={oldestNeedsYouSince === null ? undefined : `longest since ${formatRelativeTime(oldestNeedsYouSince)}`}
        tone="attention"
        testId="monitor-summary-needs-you"
        title="Agents waiting on a response from you, across every project"
      />
      <SummaryTile
        label="Active"
        icon={<Loader2 size={14} className={counts.working > 0 ? 'animate-spin' : ''} />}
        value={counts.working}
        // At zero the tile would otherwise sit under a blank line, which reads as
        // missing data rather than as a quiet machine. "last active 18 minutes ago"
        // answers the question a zero always raises, in the same relative-time
        // phrasing the Idle tile and the cards already use.
        sub={workingProjectCount > 0
          ? `across ${workingProjectCount} ${workingProjectCount === 1 ? 'project' : 'projects'}`
          : lastActiveAt === null ? undefined : `last active ${formatRelativeTime(lastActiveAt)}`}
        tone="active"
        testId="monitor-summary-working"
        title="Agents actively running right now, across every project"
      />
      {/* "Paused or waiting to start", not "suspended or queued": the user-facing
          control is Pause/Resume, and "suspended" is internal status vocabulary
          they never see anywhere else in the app. */}
      <SummaryTile
        label="Paused"
        icon={<CirclePause size={14} />}
        value={counts.idle}
        sub={counts.idle > 0 ? 'paused or waiting to start' : undefined}
        testId="monitor-summary-idle"
        title="Sessions you paused, plus any queued waiting for a free slot"
      />
      <SummaryTile
        label="Projects"
        icon={<FolderGit2 size={14} />}
        value={projectCount}
        sub={counts.finished > 0 ? `${counts.finished} recently finished` : 'with a live session'}
        testId="monitor-summary-projects"
        title="Projects with at least one live session"
      />
    </div>
  );
}
