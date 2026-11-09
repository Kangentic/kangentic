import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import {
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';
import type { PRMergeReadiness, PRState } from '../../shared/types';

const OPEN_BADGE_CLASS = 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20';
/** In flight: sky, so it reads as progress rather than as any of the pass / fail hues. */
const IN_FLIGHT_BADGE_CLASS = 'bg-sky-400/10 text-sky-400 ring-1 ring-sky-400/20';
/** Red means an agent can fix it: a failed check or a merge conflict. */
const FIXABLE_BADGE_CLASS = 'bg-red-400/10 text-red-400 ring-1 ring-red-400/20';
const BLOCKED_BADGE_CLASS = 'bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/20';
const MERGED_BADGE_CLASS = 'bg-purple-400/10 text-purple-400 ring-1 ring-purple-400/20';
/** Finished without merging, or not started: grey, so it never reads as "needs fixing". */
const NEUTRAL_BADGE_CLASS = 'bg-surface-hover/50 text-fg-muted ring-1 ring-fg-muted/20';

/**
 * Shared presentation for a PR state, as a word and a tint: the toast that
 * reports a link ("PR #38 linked, checks failing"), the completed task's
 * strip, and the pill's tooltip all read it, so the word stays one vocabulary.
 * `null` (linked before state tracking, or unknown) has an empty `label` and
 * `badgeClass`.
 *
 * While the PR is OPEN, merge readiness folds into the same word and tint:
 * `ready` keeps the open green (the promise "a Merge click would succeed"),
 * `failing` and `conflicting` are red (an agent can fix both), `blocked` (a
 * review or branch rule) is amber, and `queued` / `running` are sky, distinct
 * from every pass / fail hue. `unknown` (the host has no verdict yet) and null
 * (never judged) keep plain `open`, and the non-open states ignore readiness
 * entirely: a stale verdict on a merged PR must never show through. Closed is
 * grey, so a finished PR never looks like one that needs fixing.
 */
export function prStatePresentation(
  state: PRState | null | undefined,
  readiness?: PRMergeReadiness | null,
): { label: string; badgeClass: string } {
  switch (state) {
    case 'open':
      switch (readiness) {
        case 'ready':
          return { label: i18n._(msg`ready`), badgeClass: OPEN_BADGE_CLASS };
        case 'failing':
          return { label: i18n._(msg`checks failing`), badgeClass: FIXABLE_BADGE_CLASS };
        case 'blocked':
          return { label: i18n._(msg`blocked`), badgeClass: BLOCKED_BADGE_CLASS };
        case 'conflicting':
          return { label: i18n._(msg`conflicts`), badgeClass: FIXABLE_BADGE_CLASS };
        case 'queued':
          return { label: i18n._(msg`queued`), badgeClass: IN_FLIGHT_BADGE_CLASS };
        case 'running':
          return { label: i18n._(msg`running`), badgeClass: IN_FLIGHT_BADGE_CLASS };
        default:
          return { label: i18n._(msg`open`), badgeClass: OPEN_BADGE_CLASS };
      }
    case 'draft':
      return { label: i18n._(msg`draft`), badgeClass: NEUTRAL_BADGE_CLASS };
    case 'merged':
      return { label: i18n._(msg`merged`), badgeClass: MERGED_BADGE_CLASS };
    case 'closed':
      return { label: i18n._(msg`closed`), badgeClass: NEUTRAL_BADGE_CLASS };
    default:
      return { label: '', badgeClass: '' };
  }
}

/**
 * The compact PR pill's look: one lucide glyph for the state, the state's tint
 * on the whole pill, and whether its edge pulses (checks in flight). The word
 * is not drawn; the glyph and the tint carry it, and the pill's tooltip says
 * it. A PR with no known state is the neutral pill with the plain PR glyph.
 */
export function prPillPresentation(
  state: PRState | null | undefined,
  readiness?: PRMergeReadiness | null,
): { glyph: LucideIcon; toneClass: string; pulse: boolean } {
  switch (state) {
    case 'open': {
      const toneClass = prStatePresentation(state, readiness).badgeClass;
      const glyph = readiness === 'conflicting' ? GitMergeConflict : GitPullRequest;
      return { glyph, toneClass, pulse: readiness === 'queued' || readiness === 'running' };
    }
    case 'draft':
      return { glyph: GitPullRequestDraft, toneClass: NEUTRAL_BADGE_CLASS, pulse: false };
    case 'merged':
      return { glyph: GitMerge, toneClass: MERGED_BADGE_CLASS, pulse: false };
    case 'closed':
      return { glyph: GitPullRequestClosed, toneClass: NEUTRAL_BADGE_CLASS, pulse: false };
    default:
      return { glyph: GitPullRequest, toneClass: NEUTRAL_BADGE_CLASS, pulse: false };
  }
}

/**
 * Supplementary tooltip sentence while a merge verdict shows. Names the
 * promise and its caveat (the verdict is as fresh as the last PR refresh: the
 * background sweep or the task menu's Refresh PR). `undefined` whenever no
 * verdict shows.
 */
export function prMergeReadinessTooltip(
  state: PRState | null | undefined,
  readiness: PRMergeReadiness | null | undefined,
): string | undefined {
  if (state !== 'open') return undefined;
  switch (readiness) {
    case 'ready':
      return i18n._(msg`Ready to merge as of the last PR refresh`);
    case 'failing':
      return i18n._(msg`A check or build failed as of the last PR refresh`);
    case 'blocked':
      return i18n._(msg`Merge blocked by reviews or branch rules as of the last PR refresh`);
    case 'conflicting':
      return i18n._(msg`Merge conflicts with the base branch as of the last PR refresh`);
    case 'queued':
      return i18n._(msg`Required checks or policies are queued as of the last PR refresh`);
    case 'running':
      return i18n._(msg`Required checks or policies are running as of the last PR refresh`);
    default:
      return undefined;
  }
}
