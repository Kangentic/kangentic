import { type MouseEvent } from 'react';
import { GitPullRequest, ExternalLink } from 'lucide-react';
import { Pill } from './Pill';
import { prStatePresentation, prMergeReadinessTooltip } from '../lib/pr-state';
import type { PRMergeReadiness, PRState } from '../../shared/types';

/**
 * Standalone PR state chip (open=green, draft=gray, merged=purple, closed=red).
 * Renders nothing for an unlinked / unknown state. Colors come from the shared
 * `prStatePresentation` so the badge stays in sync wherever it appears. While
 * the PR is open, a known merge verdict folds into the same chip (`ready` /
 * `blocked` / `conflicts`), with a supplementary tooltip naming the caveat.
 *
 * Deliberately a tight span, not a `Pill`: it nests inside the `PrLink` pill and
 * must be visibly shorter than the link's text line, which two equally-sized
 * pills cannot achieve. `leading-none` + `py-px` keep it compact and centered.
 */
function PrStateBadge({
  state,
  readiness,
}: {
  state: PRState | null | undefined;
  readiness: PRMergeReadiness | null | undefined;
}) {
  const { label, badgeClass } = prStatePresentation(state, readiness);
  if (!label) return null;
  return (
    <span
      data-testid="pr-state-badge"
      title={prMergeReadinessTooltip(state, readiness)}
      className={`inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium leading-none ${badgeClass}`}
    >
      {label}
    </span>
  );
}

interface PrLinkProps {
  prUrl: string;
  prNumber: number | null;
  prState: PRState | null | undefined;
  /**
   * Optional so a caller that predates readiness (or a row that never judged
   * it) degrades to the plain state chip rather than failing to compile.
   */
  prMergeReadiness?: PRMergeReadiness | null;
  testId: string;
  className?: string;
}

/**
 * Clickable linked-PR row, shared by the board card and the task-detail header
 * so the markup and affordance stay identical. Reads as interactive at rest (a
 * resting chip background, not a hover-only underline) and carries a trailing
 * external-link icon signaling it opens in the browser. The state shows as a
 * standalone `PrStateBadge`, not inline text. Compact (`xs`) so it sits neatly
 * beside the board card title and the task-detail header title.
 */
export function PrLink({ prUrl, prNumber, prState, prMergeReadiness, testId, className }: PrLinkProps) {
  // pr_number can be null (a PR linked before number tracking); fall back to a
  // bare "PR" label rather than rendering the literal string "PR #null".
  const prLabel = prNumber != null ? `PR #${prNumber}` : 'PR';
  return (
    <Pill
      shape="square"
      size="xs"
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        window.electronAPI.shell.openExternal(prUrl);
      }}
      className={`bg-surface-hover/50 hover:bg-surface-hover text-fg-secondary hover:text-fg transition-colors ${className ?? ''}`}
      title={`Open ${prLabel} in browser`}
      data-testid={testId}
    >
      <GitPullRequest size={12} className="text-fg-muted" />
      {prLabel}
      <PrStateBadge state={prState} readiness={prMergeReadiness} />
      <ExternalLink size={11} className="opacity-60" />
    </Pill>
  );
}
