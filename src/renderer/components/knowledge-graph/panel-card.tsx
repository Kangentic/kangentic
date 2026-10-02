/**
 * The Knowledge Graph left panel's card chrome: the surface every card draws
 * and the header that folds it. The controls stack uses it for its four cards,
 * and the Index card uses it on its own while there is no map to control.
 */

import type React from 'react';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { InfoHint } from './PanelRow';

/** A group's small caps label inside a card, its help behind an info hint. */
export function GroupLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
      <span>{children}</span>
      {hint ? <InfoHint text={hint} /> : null}
    </div>
  );
}

/**
 * The one way from the Knowledge Graph to Settings > Knowledge Graph: in the
 * Index panel, and on the card shown while the Knowledge Graph is off. The
 * Settings card's own button look (its Rebuild), full width.
 */
export function OpenSettingsButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Change the sources, the model and the agent, or rebuild the index, in Settings > Knowledge Graph"
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-edge-input bg-surface-control text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg cursor-pointer"
      data-testid={testId}
    >
      <Settings size={13} aria-hidden />
      Open Settings
    </button>
  );
}

/** Card chrome shared by the panel's cards. No `overflow` here: nothing inside
 *  a card may clip. */
export const CARD_SURFACE_CLASS = 'rounded-lg border border-edge bg-surface-raised/80 backdrop-blur-md shadow-xl';
export const CARD_CLASS = `flex-shrink-0 ${CARD_SURFACE_CLASS}`;

export function SectionHeader({
  icon,
  label,
  collapsed,
  onToggle,
  testId,
  /** Where the section's body appears. A `side` header keeps its chevron
   *  pointing at the flyout rather than rotating down onto content that is not
   *  underneath it. */
  opens = 'down',
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  testId: string;
  opens?: 'down' | 'side';
}) {
  // A side header shades while its flyout is open, so the flyout reads as
  // coming from it; a header that opens downward has its body to show that.
  const flyoutOpen = opens === 'side' && !collapsed;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex w-full items-center gap-2 rounded-[7px] px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
        flyoutOpen ? 'bg-surface-hover text-fg' : 'text-fg-secondary hover:text-fg'
      }`}
      aria-expanded={!collapsed}
      data-testid={testId}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {opens === 'side' ? (
        <ChevronRight size={13} aria-hidden />
      ) : (
        <ChevronDown
          size={13}
          aria-hidden
          className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
      )}
    </button>
  );
}
