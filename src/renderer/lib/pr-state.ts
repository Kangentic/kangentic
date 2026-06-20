import type { PRState } from '../../shared/types';

/**
 * Shared presentation for a PR state, so the board card badge and the task
 * detail badge stay visually consistent: open=green, draft=gray, merged=purple,
 * closed=red. Color lives only on the standalone state chip (`badgeClass`: a
 * subtle tinted bg + colored text + ring); the PR icon and link text stay
 * neutral so each card carries the state hue exactly once. `null` (linked before
 * state tracking, or unknown) has an empty `label` and `badgeClass`, so no badge
 * renders and the plain PR link shows on its own.
 */
export function prStatePresentation(
  state: PRState | null | undefined,
): { label: string; badgeClass: string } {
  switch (state) {
    case 'open':
      return { label: 'open', badgeClass: 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20' };
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
