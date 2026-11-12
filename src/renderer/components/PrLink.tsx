import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Pill } from './Pill';
import { Tooltip } from './Tooltip';
import { useLinkOpener } from '../hooks/useLinkOpener';
import { prStatePresentation, prPillPresentation, prMergeReadinessTooltip } from '../lib/pr-state';
import type { PRMergeReadiness, PRState } from '../../shared/types';

interface PrLinkProps {
  prUrl: string;
  prNumber: number | null;
  prState: PRState | null | undefined;
  /**
   * Optional so a caller that predates readiness (or a row that never judged
   * it) degrades to the plain state pill rather than failing to compile.
   */
  prMergeReadiness?: PRMergeReadiness | null;
  /**
   * The task the PR belongs to, so Ctrl or Cmd click can open it in the
   * Kangentic browser of that task's window when one is open (`useLinkOpener`).
   */
  taskId?: string | null;
  testId: string;
  className?: string;
}

/**
 * What a PR's open control says on hover: the PR and the state it is in (the
 * readiness sentence while a verdict shows, else the state word, "merged" or
 * "draft"), then where a click and a Ctrl or Cmd click open it. Shared by the
 * pill and the icon-only button so the two can never word it differently.
 */
function usePrOpenTip(
  prNumber: number | null,
  prState: PRState | null | undefined,
  prMergeReadiness: PRMergeReadiness | null | undefined,
): { label: string; detail: string | undefined } {
  const { t } = useLingui();
  const label = prNumber != null ? t`PR #${prNumber}` : t`Pull request`;
  const detail = prMergeReadinessTooltip(prState, prMergeReadiness)
    ?? (prStatePresentation(prState, prMergeReadiness).label || undefined);
  return { label, detail };
}

/**
 * The compact PR pill, shared by the board card and the Agent Monitor card so
 * the markup and affordance stay identical: one state glyph, "PR #38", and a
 * muted open icon, the whole pill tinted to the state (`prPillPresentation`).
 * No state word is drawn; the glyph and the tint carry it and the tooltip says
 * it. While checks are queued or running, an inset ring pulses at 2800ms
 * (`.kng-pr-pulse`). Clicking opens the PR.
 */
export function PrLink({ prUrl, prNumber, prState, prMergeReadiness, taskId, testId, className }: PrLinkProps) {
  const { t } = useLingui();
  const ringRef = useRef<HTMLSpanElement>(null);
  const openTip = usePrOpenTip(prNumber, prState, prMergeReadiness);
  const opener = useLinkOpener(taskId);
  const { glyph: Glyph, toneClass, pulse } = prPillPresentation(prState, prMergeReadiness);
  // Anchor the pulse to the document timeline, as ActivityMark does for the
  // activity marks, so every running pill breathes in phase and a re-mount
  // (a project switch, a restored window) continues the cycle instead of
  // replaying it from the start.
  useLayoutEffect(() => {
    const ring = ringRef.current;
    if (!ring || typeof ring.getAnimations !== 'function') return;
    for (const animation of ring.getAnimations()) animation.startTime = 0;
  }, [pulse]);

  // pr_number can be null (a PR linked before number tracking); fall back to a
  // bare "PR" label rather than rendering the literal string "PR #null".
  const prLabel = prNumber != null ? t`PR #${prNumber}` : t`PR`;
  return (
    <Tooltip label={openTip.label} detail={openTip.detail} rows={opener.rows}>
      <Pill
        shape="square"
        size="xs"
        // Beside a count chip on a board card the pill is stretched to half the
        // row; its content starts at the left, as the chip's does. At content
        // width (everywhere else) start and center draw the same.
        justify="start"
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          opener.open(prUrl, event);
        }}
        className={`relative transition-colors ${toneClass} hover:brightness-125 ${className ?? ''}`}
        data-testid={testId}
        data-pr-state={prState ?? 'unknown'}
        data-pr-readiness={prMergeReadiness ?? ''}
      >
        <Glyph size={13} className="flex-shrink-0" aria-hidden="true" />
        {prLabel}
        <ExternalLink size={11} className="flex-shrink-0 opacity-60" aria-hidden="true" />
        {pulse && (
          <span
            ref={ringRef}
            aria-hidden="true"
            data-testid={`${testId}-pulse`}
            className="kng-pr-pulse pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-current"
          />
        )}
      </Pill>
    </Tooltip>
  );
}

interface PrOpenButtonProps {
  prUrl: string;
  prNumber: number | null;
  prState: PRState | null | undefined;
  prMergeReadiness?: PRMergeReadiness | null;
  /** As on `PrLink`: the task whose window may offer a Kangentic browser. */
  taskId?: string | null;
  testId: string;
  className?: string;
}

/**
 * The PR's open control with no pill around it: one open icon, for a place that
 * already names the pull request (the Changes panel's Pull request section).
 * Its tooltip is the pill's, so the PR's number and state are still one hover
 * away where no pill is drawn.
 */
export function PrOpenButton({ prUrl, prNumber, prState, prMergeReadiness, taskId, testId, className }: PrOpenButtonProps) {
  const { t } = useLingui();
  const openTip = usePrOpenTip(prNumber, prState, prMergeReadiness);
  const opener = useLinkOpener(taskId);
  return (
    <Tooltip label={openTip.label} detail={openTip.detail} rows={opener.rows}>
      <button
        type="button"
        aria-label={t`Open pull request`}
        onClick={(event: MouseEvent) => opener.open(prUrl, event)}
        className={`flex items-center text-fg-muted hover:bg-surface-hover hover:text-fg transition-colors ${className ?? ''}`}
        data-testid={testId}
        data-pr-state={prState ?? 'unknown'}
        data-pr-readiness={prMergeReadiness ?? ''}
      >
        <ExternalLink size={11} className="flex-shrink-0" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
