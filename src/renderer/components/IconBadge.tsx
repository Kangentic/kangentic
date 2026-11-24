import { ArrowUp, GitCommitHorizontal, Play, X } from 'lucide-react';

/** What an overlay badge says: the icon alone says it, with no count beside it. */
export type IconBadgeKind = 'problems' | 'uncommitted' | 'unpushed' | 'running';

interface IconBadgeProps {
  kind: IconBadgeKind;
  /** Breathe, for something alive right now. Opacity only, and still with Animations off. */
  pulse?: boolean;
  /**
   * 'overlay' (default) clears the icon it sits on with a ring of the window's surface. 'tip' is the
   * same badge leading a tooltip row, on the tip's inverted ground.
   */
  placement?: 'overlay' | 'tip';
  testId?: string;
  /** An agent is driving the page the badge stands for; stamped as `data-driving`. */
  driving?: boolean;
}

const FILL: Record<IconBadgeKind, string> = {
  // A palette red, as CountBadge's danger tone: white on red-600 is 4.8:1 in every theme.
  problems: 'bg-red-600 text-white',
  uncommitted: 'bg-fg-secondary text-surface-raised',
  unpushed: 'bg-fg-secondary text-surface-raised',
  running: 'bg-active text-surface-raised',
};

/** On the tip's inverted ground the grey swaps with it, so it stays a dark disc on light and the reverse. */
const TIP_FILL: Record<IconBadgeKind, string> = {
  ...FILL,
  uncommitted: 'bg-surface-hover text-fg',
  unpushed: 'bg-surface-hover text-fg',
};

/** Heavier strokes than lucide's 2: at 8 to 12px a 2 in 24 box is under a pixel. */
function BadgeGlyph({ kind }: { kind: IconBadgeKind }) {
  switch (kind) {
    case 'problems': return <X size={9} strokeWidth={4} />;
    case 'uncommitted': return <GitCommitHorizontal size={12} strokeWidth={2.8} />;
    case 'unpushed': return <ArrowUp size={9} strokeWidth={4} />;
    // Nudged: a triangle's box center sits left of its visual one.
    case 'running': return <Play size={8} fill="currentColor" className="translate-x-[0.5px]" />;
  }
}

/**
 * A 14px icon badge overlaid on a header button, the size the title bar's
 * unread count has. One per button, at the same corner, so the Changes button's
 * git state and the Browser button's live page read as one family. Decorative:
 * the button's tooltip says it in words.
 */
export function IconBadge({ kind, pulse, placement = 'overlay', testId, driving }: IconBadgeProps) {
  const overlay = placement === 'overlay';
  return (
    <span
      aria-hidden="true"
      className={`flex size-3.5 items-center justify-center rounded-full ${overlay ? `pointer-events-none absolute -right-1 -top-0.5 ring-2 ring-surface-raised ${FILL[kind]}` : TIP_FILL[kind]} ${pulse ? 'animate-pulse' : ''}`}
      data-testid={testId}
      data-badge={kind}
      data-driving={driving ? 'true' : undefined}
    >
      <BadgeGlyph kind={kind} />
    </span>
  );
}
