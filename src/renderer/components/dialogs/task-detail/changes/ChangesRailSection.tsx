import React from 'react';
import { ChevronRight } from 'lucide-react';

/** Height (px) of a rail section's always-visible header row. Shared with
 *  ChangesPanel's History resize math (the drag measures from the rail bottom,
 *  which includes this row). */
export const RAIL_SECTION_HEADER_PX = 28;

interface ChangesRailSectionProps {
  /** Expanded state. Remembered across tasks (AppConfig), closed by default. */
  open: boolean;
  onToggle: () => void;
  /** The section's name, beside the chevron ("History", "Checks"). */
  label: React.ReactNode;
  /** What follows the label in the header row: the section's count or progress badge. */
  trailing?: React.ReactNode;
  /** Prefix for `<prefix>-section` and `<prefix>-toggle` test ids. */
  testIdPrefix: string;
  /** The body's height while open: a fixed px height (History's, resized by a
   *  handle) or `'content'` (sized to its rows, capped by `maxBodyHeight`). */
  bodyHeight: number | 'content';
  /** The cap on a content-sized body; it scrolls past it. */
  maxBodyHeight?: number;
  /** A fixed-height body's open/close transition. Pass false while the user
   *  drags it, so the height tracks the pointer 1:1. A content-sized body never
   *  animates, so it leaves this out. */
  animateHeight?: boolean;
  /** The body, kept MOUNTED while collapsed (clipped to height 0), so what it
   *  reads stays live and expanding is instant. */
  children: React.ReactNode;
}

/**
 * One VS Code-style collapsible section of the Changes rail: a 28px header row
 * (chevron, label, trailing badge) that toggles the body below it. History and
 * Checks are both built from it, so the two read as one family.
 */
export function ChangesRailSection({
  open,
  onToggle,
  label,
  trailing,
  testIdPrefix,
  bodyHeight,
  maxBodyHeight,
  animateHeight = false,
  children,
}: ChangesRailSectionProps) {
  const contentSized = bodyHeight === 'content';
  return (
    <div className="flex flex-col min-h-0 flex-shrink border-t border-edge" data-testid={`${testIdPrefix}-section`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-shrink-0 items-center gap-1.5 px-2 text-left text-fg-secondary hover:bg-surface-hover hover:text-fg transition-colors"
        style={{ height: RAIL_SECTION_HEADER_PX }}
        data-testid={`${testIdPrefix}-toggle`}
      >
        <ChevronRight size={14} className={`flex-shrink-0 text-fg-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-xs font-medium">{label}</span>
        {trailing}
      </button>
      {/* Mounted while collapsed, clipped to height 0. A fixed-height body
          transitions on the open/close CHANGE only, so a restore paints at its
          final height with no replay; a content-sized body cannot animate to
          `auto` and simply appears. */}
      <div
        className={`min-h-0 ${contentSized ? (open ? 'overflow-y-auto' : 'overflow-hidden') : 'overflow-hidden'} ${!contentSized && animateHeight ? 'transition-[height] duration-200 ease-out motion-reduce:transition-none [.no-motion_&]:transition-none' : ''}`}
        style={contentSized
          ? (open ? { maxHeight: maxBodyHeight } : { height: 0 })
          : { height: open ? bodyHeight : 0 }}
        aria-hidden={open ? undefined : true}
      >
        {children}
      </div>
    </div>
  );
}
