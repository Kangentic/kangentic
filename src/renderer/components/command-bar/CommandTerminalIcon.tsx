import React from 'react';
import type { CommandTerminalTone } from '../../stores/session-store/transient-session-slice';

/**
 * The Command Terminal glyph: a custom terminal icon whose state lives IN the
 * glyph rather than in a separate corner badge. The stroke color is the aggregate
 * activity of a project's terminals (green while working / warm amber when one
 * needs you / muted rest, via the --kng-active / --kng-attention tokens), and the
 * working border MARCHES (a dash flows around the perimeter). The center morphs
 * from the shell prompt to a `+` when rendered for the "New terminal" button, so
 * that button reads as a terminal glyph (not a bare plus). 24 viewBox at
 * strokeWidth 2 to match the neighbouring lucide icons.
 *
 * A deliberate inline-SVG exception to the lucide-only icon convention
 * (`ui-conventions.md`): no lucide glyph carries a marching activity border, and
 * the prompt/plus morph is specific to this control.
 *
 * Shared by the title bar (20px, the project-wide toggle) and the project sidebar
 * (14px, per project row). Callers outside the title bar MUST pass their own
 * `testId`: the default belongs to the title-bar toggle, and reusing it would make
 * that button's test locators ambiguous.
 */
export function CommandTerminalIcon({
  tone,
  showPlus = false,
  size = 20,
  testId = 'quick-session-icon',
}: {
  tone: CommandTerminalTone;
  showPlus?: boolean;
  size?: number;
  testId?: string;
}): React.ReactNode {
  // `tone` is a derived PRESENTATIONAL union (rest | thinking | idle); the idle-vs-active
  // bucketing already happened upstream via isActive / requiresUserInteraction when this
  // tone was computed, so these are per-tone affordances, not a hand-rolled ActivityState bucket.
  const isWorking = tone === 'thinking'; // activity-state-ok: presentational tone, not an ActivityState
  const needsAttention = tone === 'idle'; // activity-state-ok: presentational tone, not an ActivityState
  const colorClass = isWorking ? 'text-active' : needsAttention ? 'text-attention' : '';
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={colorClass}
      data-testid={testId}
      data-activity={tone}
      data-plus={showPlus ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/* Terminal screen border. While an agent works it marches (a dash flows
          around the perimeter); pathLength normalizes the dash math to 100. */}
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="3"
        pathLength={100}
        strokeDasharray={isWorking ? '65 35' : undefined}
        className={isWorking ? 'animate-march-border' : undefined}
      />
      {showPlus ? (
        // The add affordance, centered in the terminal (replaces the prompt).
        <>
          <path d="M12 8.5 V15.5" />
          <path d="M8.5 12 H15.5" />
        </>
      ) : (
        // The shell prompt: chevron + caret line.
        <>
          <path d="M7.5 9.5 L10.5 12 L7.5 14.5" />
          <path d="M12.5 14.5 H16.5" />
        </>
      )}
    </svg>
  );
}
