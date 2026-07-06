import type { ComponentType } from 'react';
import { Pill } from './Pill';

interface HeaderActionButtonProps {
  /** Icon component rendered at the shared header size. Accepts Lucide icons and
   *  the shortcut icon-registry components (both take a `size` prop). */
  icon: ComponentType<{ size?: number }>;
  onClick: () => void;
  /** Native tooltip text. */
  title: string;
  /** Accessible label for icon-only buttons; omit when `label` is shown. */
  ariaLabel?: string;
  /** Optional trailing text (shortcut buttons render icon + label). */
  label?: string;
  /** Toggle buttons (changes / browser): accent styling when on. */
  active?: boolean;
  /** Muted, non-interactive styling for when the action has nothing to act on
   *  (e.g. no conversation history yet). `title` should still explain why. */
  disabled?: boolean;
  testId?: string;
  /** 'normal' (default) is the header action row's usual size (16px icon,
   *  Pill size="md") - the folder / changes / browser / conversation /
   *  shortcut pills. 'small' is a compact icon-only variant (12px icon,
   *  Pill size="xs") for inline placements like a per-message copy button,
   *  where a full header-sized button would overwhelm the row. Both share
   *  the exact same colors/hover/rounding so they read as the same kind of
   *  control at a glance, just sized for their context. */
  size?: 'normal' | 'small';
  /** Extra classes appended after the variant styling (e.g. a hover-reveal
   *  opacity transition for an inline placement). Never overrides colors. */
  className?: string;
}

/** The one place the header action row's icon size lives. Bump here to resize
 *  every folder / changes / browser / conversation / shortcut glyph at once. */
const ICON_SIZE_NORMAL = 16;
const ICON_SIZE_SMALL = 14;

/** Rest vs. toggled-on vs. disabled styling. Every variant carries `border`
 *  (transparent at rest) so an active toggle's accent border does not shift
 *  the pill 1px. Disabled drops all hover styling and dims further than rest
 *  so it reads as non-interactive at a glance, not just a duller version of rest. */
const REST = 'bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover border-transparent';
const ACTIVE = 'bg-accent/15 text-accent-fg border-accent/30';
const DISABLED = 'bg-surface-hover/20 text-fg-faint/50 border-transparent cursor-not-allowed';

/**
 * Shared header action button: an icon-forward square {@link Pill} used across
 * the task-detail and command-terminal window headers (the folder, changes,
 * browser, conversation, and shortcut pills). It centralizes the muted icon
 * styling, the toggle (`active`) accent variant, and the icon size, so the whole
 * header action row restyles from one place instead of eight copy-pasted
 * className strings. `Pill` owns only structural layout; this owns the look.
 */
export function HeaderActionButton({
  icon: Icon,
  onClick,
  title,
  ariaLabel,
  label,
  active,
  disabled,
  testId,
  size = 'normal',
  className,
}: HeaderActionButtonProps) {
  // Pill's px/py pair (and, for size="md", its min-w-[40px]) is tuned for a
  // pill WITH text (wider than tall reads fine there), but most callers here
  // are icon-only, where the same padding/min-width made a visibly wide
  // rectangle around a small glyph. Tighten it, but keep it a touch wider than
  // tall (not a strict square) so a "normal" button still feels like a solid,
  // chunky click target rather than a thin sliver - `!` forces the override
  // since Tailwind's generated source order (not this string's order) decides
  // which of two same-specificity utilities wins. "small" scales the same
  // width:height ratio down (36x30 -> 26x22) rather than being its own,
  // differently-proportioned shape. A `label` present keeps Pill's wider
  // default, which is what text wants.
  const squareUpIconOnly = label ? '' : size === 'small' ? '!px-[5px]' : '!min-w-0 !px-[9px]';

  return (
    <Pill
      shape="square"
      size={size === 'small' ? 'xs' : 'md'}
      onClick={onClick}
      disabled={disabled}
      className={`flex-shrink-0 border transition-colors ${disabled ? DISABLED : active ? ACTIVE : REST} ${squareUpIconOnly} ${className ?? ''}`}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <Icon size={size === 'small' ? ICON_SIZE_SMALL : ICON_SIZE_NORMAL} />
      {label}
    </Pill>
  );
}
