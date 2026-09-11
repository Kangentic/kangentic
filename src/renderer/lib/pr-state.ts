import type { PRMergeReadiness, PRState } from '../../shared/types';

const OPEN_BADGE_CLASS = 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20';

/**
 * Shared presentation for a PR state, so the board card badge and the task
 * detail badge stay visually consistent: open=green, draft=gray, merged=purple,
 * closed=red. Color lives only on the standalone state chip (`badgeClass`: a
 * subtle tinted bg + colored text + ring); the PR icon and link text stay
 * neutral so each card carries the state hue exactly once. `null` (linked before
 * state tracking, or unknown) has an empty `label` and `badgeClass`, so no badge
 * renders and the plain PR link shows on its own.
 *
 * While the PR is OPEN, merge readiness folds into this same chip rather than
 * adding a second element and a second hue: `ready` keeps the open green (it
 * is the promise "a Merge click would succeed"), `blocked` is amber, and
 * `conflicts` is orange, chosen over red so it does not read as `closed` at a
 * glance. `unknown` (the host has no verdict yet) and null (never judged) keep
 * plain `open`, and the non-open states ignore readiness entirely: a stale
 * verdict on a merged PR must never show through.
 */
export function prStatePresentation(
  state: PRState | null | undefined,
  readiness?: PRMergeReadiness | null,
): { label: string; badgeClass: string } {
  switch (state) {
    case 'open':
      switch (readiness) {
        case 'ready':
          return { label: 'ready', badgeClass: OPEN_BADGE_CLASS };
        case 'blocked':
          return { label: 'blocked', badgeClass: 'bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/20' };
        case 'conflicting':
          return { label: 'conflicts', badgeClass: 'bg-orange-400/10 text-orange-400 ring-1 ring-orange-400/20' };
        default:
          return { label: 'open', badgeClass: OPEN_BADGE_CLASS };
      }
    case 'draft':
      return { label: 'draft', badgeClass: 'bg-fg-muted/10 text-fg-muted ring-1 ring-fg-muted/20' };
    case 'merged':
      return { label: 'merged', badgeClass: 'bg-purple-400/10 text-purple-400 ring-1 ring-purple-400/20' };
    case 'closed':
      return { label: 'closed', badgeClass: 'bg-red-400/10 text-red-400 ring-1 ring-red-400/20' };
    default:
      return { label: '', badgeClass: '' };
  }
}

/**
 * Supplementary tooltip for the chip while a merge verdict is folded into it.
 * The visible chip word is the always-on signal; this names the promise and
 * its caveat (the verdict is as fresh as the last PR refresh: the background
 * sweep or the task menu's Refresh PR). `undefined` whenever no verdict shows.
 * Kept out of `prStatePresentation`'s return object so its key shape stays
 * exactly `label` + `badgeClass`.
 */
export function prMergeReadinessTooltip(
  state: PRState | null | undefined,
  readiness: PRMergeReadiness | null | undefined,
): string | undefined {
  if (state !== 'open') return undefined;
  switch (readiness) {
    case 'ready':
      return 'Ready to merge as of the last PR refresh';
    case 'blocked':
      return 'Merge blocked by reviews, checks, or branch rules as of the last PR refresh';
    case 'conflicting':
      return 'Merge conflicts with the base branch as of the last PR refresh';
    default:
      return undefined;
  }
}
