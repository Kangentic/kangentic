import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Pill } from './Pill';
import { Tooltip } from './Tooltip';
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
  testId: string;
  className?: string;
}

/**
 * The compact PR pill, shared by the board card, the Agent Monitor card and
 * the Changes panel header so the markup and affordance stay identical: one
 * state glyph, "PR #38", and a muted open icon, the whole pill tinted to the
 * state (`prPillPresentation`). No state word is drawn; the glyph and the tint
 * carry it and the tooltip says it. While checks are queued or running, an
 * inset ring pulses at 2800ms (`.kng-pr-pulse`). Clicking opens the PR.
 */
export function PrLink({ prUrl, prNumber, prState, prMergeReadiness, testId, className }: PrLinkProps) {
  const { t } = useLingui();
  const ringRef = useRef<HTMLSpanElement>(null);
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
  const openTip = prNumber != null ? t`Open PR #${prNumber} in default browser` : t`Open PR in default browser`;
  // The tip names the state the glyph and tint stand for: the readiness
  // sentence while a verdict shows, else the state word ("merged", "draft").
  const detail = prMergeReadinessTooltip(prState, prMergeReadiness)
    ?? (prStatePresentation(prState, prMergeReadiness).label || undefined);
  return (
    <Tooltip label={openTip} detail={detail}>
      <Pill
        shape="square"
        size="xs"
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          window.electronAPI.shell.openExternal(prUrl);
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
