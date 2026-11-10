import React from 'react';
import { ChevronRight } from 'lucide-react';

/** Height (px) of a rail section's always-visible header row. Shared with
 *  ChangesPanel's History resize math (the drag measures from the rail bottom,
 *  which includes this row). */
export const RAIL_SECTION_HEADER_PX = 28;

interface ChangesRailSectionProps {
  /** Expanded state, owned by the host: remembered across tasks (AppConfig) and
   *  closed by default. The one exception is Pull request, which ChangesPanel
   *  holds open while its PR has something to fix. */
  open: boolean;
  onToggle: () => void;
  /** The section's name, beside the chevron ("History", "Pull request"). */
  label: React.ReactNode;
  /** What follows the label in the header row: the section's count or progress badge. */
  trailing?: React.ReactNode;
  /** A control at the right end of the header row, beside the toggle and never
   *  inside it (a button cannot hold a button): the Pull request section's
   *  open-in-browser button. It works while the section is collapsed. */
  actions?: React.ReactNode;
  /** False when the section has nothing to open (a PR with no checks and no
   *  conflict): the header is a plain row with no chevron, and no body mounts. */
  collapsible?: boolean;
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
 * (chevron, label, trailing badge, an optional action) that toggles the body
 * below it. History and Pull request are both built from it, so the two read as
 * one family.
 */
export function ChangesRailSection({
  open,
  onToggle,
  label,
  trailing,
  actions,
  collapsible = true,
  testIdPrefix,
  bodyHeight,
  maxBodyHeight,
  animateHeight = false,
  children,
}: ChangesRailSectionProps) {
  const contentSized = bodyHeight === 'content';
  // Shared by the toggle and the plain header, so the two stay aligned. An
  // action beside the label brings its own padding, so the label side gives up
  // half of its right inset: the rail is 220px by default and a title, a count
  // and an action have to share it.
  const headerLayoutClass = `flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 ${actions ? 'pr-1' : 'pr-2'} text-fg-secondary`;
  const headerLabel = <span className="min-w-0 truncate text-xs font-medium">{label}</span>;
  return (
    <div className="flex flex-col min-h-0 flex-shrink border-t border-edge" data-testid={`${testIdPrefix}-section`}>
      <div className="flex flex-shrink-0 items-center" style={{ height: RAIL_SECTION_HEADER_PX }}>
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={`${headerLayoutClass} text-left hover:bg-surface-hover hover:text-fg transition-colors`}
            data-testid={`${testIdPrefix}-toggle`}
          >
            <ChevronRight size={14} className={`flex-shrink-0 text-fg-muted transition-transform ${open ? 'rotate-90' : ''}`} />
            {headerLabel}
            {trailing}
          </button>
        ) : (
          // Nothing to open: the label keeps the chevron's column so it lines
          // up with the sections around it.
          <div className={headerLayoutClass} data-testid={`${testIdPrefix}-header`}>
            <span className="w-[14px] flex-shrink-0" aria-hidden="true" />
            {headerLabel}
            {trailing}
          </div>
        )}
        {actions}
      </div>
      {/* Mounted while collapsed, clipped to height 0. A fixed-height body
          transitions on the open/close CHANGE only, so a restore paints at its
          final height with no replay; a content-sized body cannot animate to
          `auto` and simply appears. */}
      {collapsible && (
        <div
          className={`min-h-0 ${contentSized ? (open ? 'overflow-y-auto' : 'overflow-hidden') : 'overflow-hidden'} ${!contentSized && animateHeight ? 'transition-[height] duration-200 ease-out motion-reduce:transition-none [.no-motion_&]:transition-none' : ''}`}
          style={contentSized
            ? (open ? { maxHeight: maxBodyHeight } : { height: 0 })
            : { height: open ? bodyHeight : 0 }}
          aria-hidden={open ? undefined : true}
        >
          {children}
        </div>
      )}
    </div>
  );
}
