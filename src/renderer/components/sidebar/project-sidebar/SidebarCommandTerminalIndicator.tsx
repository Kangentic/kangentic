import React from 'react';
import { CommandTerminalIcon } from '../../command-bar/CommandTerminalIcon';
import type { CommandTerminalTone } from '../../../stores/session-store/transient-session-slice';

export interface SidebarCommandTerminalIndicatorProps {
  projectId: string;
  projectName: string;
  count: number;
  tone: CommandTerminalTone;
  onOpen: (projectId: string) => void;
}

function labelFor(count: number, tone: CommandTerminalTone): string {
  const noun = count === 1 ? 'Command Terminal' : 'Command Terminals';
  // Presentational tone, already bucketed upstream by the shared classifiers.
  // Mind the last branch: it is reached for `rest`, NOT for the `idle` tone.
  // "Idle" is this app's word for "needs you" (see `requiresUserInteraction`),
  // so a merely-resting terminal must not borrow it - saying "(idle)" here would
  // read, in both the tooltip and the accessible name, as the opposite state.
  const state = tone === 'thinking' // activity-state-ok: presentational tone, not an ActivityState
    ? 'working'
    : tone === 'idle' // activity-state-ok: presentational tone, not an ActivityState
      ? 'needs you'
      : 'resting';
  return `${count} ${noun} running (${state})`;
}

/**
 * Per-project Command Terminal presence in the sidebar row. Command Terminal PTYs
 * survive hiding the layer AND switching projects, so without this the only signal
 * a background project still has terminals running is the title-bar glyph, which
 * only ever reflects the project you are currently looking at.
 *
 * Reuses the title bar's glyph and tone language rather than inventing a second
 * vocabulary, so a terminal waiting on input reads the same everywhere. It sits
 * BESIDE the agent thinking/idle counts (`SidebarActivityCounts`), never merged
 * into them: a Command Terminal is not a task agent.
 *
 * Lives in the row's right-aligned cluster and always prints its count, so it forms
 * an icon+digit pair matching the agent counts and the three indicators stack into
 * one tabular column down the list.
 *
 * Clicking jumps to that project and reopens its Command Terminal layer.
 */
export const SidebarCommandTerminalIndicator = React.memo(function SidebarCommandTerminalIndicator({
  projectId,
  projectName,
  count,
  tone,
  onOpen,
}: SidebarCommandTerminalIndicatorProps) {
  if (count === 0) return null;

  const label = labelFor(count, tone);
  // The tone class lives on the button so the digit inherits it via currentColor.
  // Keeping `text-active` / `text-attention` OFF the digit span matters: the sidebar
  // specs assert `span.text-active` / `span.text-attention` resolve to the AGENT
  // counts alone, and a tone-classed digit here would collide with them.
  const toneClass = tone === 'thinking' // activity-state-ok: presentational tone, not an ActivityState
    ? 'text-active'
    : tone === 'idle' // activity-state-ok: presentational tone, not an ActivityState
      ? 'text-attention'
      : 'text-fg-muted';

  return (
    <button
      type="button"
      // The row is a dnd-kit sortable with a 5px pointer activation constraint and
      // its own onClick; both have to be held off so this reads as its own control.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(projectId);
      }}
      className={`flex-shrink-0 flex items-center gap-1 rounded px-0.5 text-[11px] tabular-nums outline-none transition-colors hover:bg-surface-hover/60 ${toneClass}`}
      title={`${label}\nClick to open`}
      aria-label={`${projectName}: ${label}`}
      data-testid={`project-terminals-${projectId}`}
      data-activity={tone}
      data-count={count}
    >
      {/* 16 to match SidebarActivityCounts' row size, so all three indicators stay one
          tabular column. Change both together or the row goes ragged. */}
      <CommandTerminalIcon size={16} tone={tone} testId={`project-terminal-icon-${projectId}`} />
      {/* The count always prints, even at 1. Suppressing it left a lone glyph in a row
          of icon+digit pairs, where it read as a count that had lost its number. */}
      <span className="flex items-center justify-center min-w-[1ch] font-semibold" style={{ height: 16 }}>
        {count}
      </span>
    </button>
  );
});
