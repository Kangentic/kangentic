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
  testId?: string;
}

/** The one place the header action row's icon size lives. Bump here to resize
 *  every folder / changes / browser / conversation / shortcut glyph at once. */
const ICON_SIZE = 16;

/** Rest vs. toggled-on styling. Every variant carries `border` (transparent at
 *  rest) so an active toggle's accent border does not shift the pill 1px. */
const REST = 'bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover border-transparent';
const ACTIVE = 'bg-accent/15 text-accent-fg border-accent/30';

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
  testId,
}: HeaderActionButtonProps) {
  return (
    <Pill
      shape="square"
      onClick={onClick}
      className={`flex-shrink-0 border transition-colors ${active ? ACTIVE : REST}`}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <Icon size={ICON_SIZE} />
      {label}
    </Pill>
  );
}
