import React from 'react';
import { ActivityMark, type ActivityMarkName } from '../ActivityMark';
import type { CommandTerminalTone } from '../../stores/session-store/transient-session-slice';

/**
 * The Command Terminal glyph: a terminal icon whose state lives IN the glyph rather than in a
 * separate corner badge. The stroke color is the aggregate activity of a project's terminals
 * (green while working / warm amber when one needs you / muted rest, via the --kng-active /
 * --kng-attention tokens), and the working state BLINKS its prompt like a live shell.
 * The center morphs from the shell prompt to a `+` when rendered for the "New terminal" button,
 * so that button reads as a terminal glyph (not a bare plus).
 *
 * One of the three files `ui-conventions.md` exempts from the lucide-only / no-inline-SVG rule,
 * and the only one that holds the exemption second-hand: it draws nothing itself, it wraps
 * `ActivityMark`. The geometry comes from `@kangentic/branding`'s `terminal-*` marks.
 * It was previously hand-authored here and was byte-identical to the packaged art (same rect,
 * chevron, plus, and the working dash it carried then), which is exactly the duplication the
 * shared set exists to remove. This component stays as the app-facing wrapper because it owns
 * the tone -> mark mapping and the `data-activity` / `data-plus` test contract.
 *
 * Shared by the title bar (20px, the project-wide toggle) and the project sidebar (14px, per
 * project row). Callers outside the title bar MUST pass their own `testId`: the default belongs
 * to the title-bar toggle, and reusing it would make that button's test locators ambiguous.
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

  // `showPlus` wins: the "New terminal" button is an ACTION, so it never animates. Rest and
  // needs-you share the `terminal-idle` geometry and differ only in tone, which is why the
  // packaged set ships no separate `-rest` mark.
  const mark: ActivityMarkName = showPlus
    ? 'terminal-new'
    : isWorking
      ? 'terminal-working'
      : 'terminal-idle';

  return (
    <ActivityMark
      mark={mark}
      size={size}
      className={colorClass}
      data-testid={testId}
      data-activity={tone}
      data-plus={showPlus ? 'true' : 'false'}
    />
  );
}
