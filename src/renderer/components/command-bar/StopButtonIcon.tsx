/**
 * The Command Terminal's Stop glyph, carrying the same activity ring the task-detail header folds
 * into its pause button (`PauseButtonIcon`), but with a STOP square centered instead of pause bars -
 * the command terminal stops (kills the PTY); it never pauses. Activity is encoded by the ring:
 *   - thinking (agent working): a rotating active ring around the stop square.
 *   - idle/permission (needs you): a static attention ring around the stop square.
 *   - not yet running / no activity: the plain red CircleStop (rest state).
 *
 * Drawn in a terminal's header and, while one terminal is expanded, beside each of the others in
 * the panel rail's Running list, so the two Stop buttons can never look different.
 *
 * Ring and square are one packaged mark, so the hand-computed `47 16` dash that used to be
 * duplicated here and in `TaskDetailHeader` is gone. See `PauseButtonIcon` for why 20 is the
 * size that reproduces the old glyph exactly.
 *
 * These branches return DIFFERENT element types, so activity changing swaps the whole subtree
 * rather than re-rendering one, and a node destroyed mid-press makes Chromium drop the click.
 * The single `IconSlot` below the branching is the one element the swap does NOT destroy, and
 * it absorbs the pointer on the glyph's behalf. Wrapping once rather than inside each branch
 * is what makes that structural: a future branch cannot forget it. `PauseButtonIcon` has the
 * same shape over five branches and does the same.
 */

import type { ReactNode } from 'react';
import { CircleStop, Loader2 } from 'lucide-react';
import { ActivityMark } from '../ActivityMark';
import { IconSlot } from '../IconSlot';

interface StopButtonIconProps {
  isThinking: boolean;
  isIdle: boolean;
  stopping: boolean;
}

export function StopButtonIcon({ isThinking, isIdle, stopping }: StopButtonIconProps): ReactNode {
  // The slot is 20 across every state, while each glyph keeps the size it already drew at
  // (the 20px mark reads level with the 18px lucide glyphs), so the button never resizes.
  return <IconSlot size={20}>{stopGlyph({ isThinking, isIdle, stopping })}</IconSlot>;
}

function stopGlyph({ isThinking, isIdle, stopping }: StopButtonIconProps): ReactNode {
  if (stopping) return <Loader2 size={18} className="animate-spin" />;
  if (isThinking || isIdle) {
    return (
      <ActivityMark
        mark={isThinking ? 'control-stop-working' : 'control-stop-idle'}
        size={20}
        className={isThinking ? 'text-active' : 'text-attention'}
      />
    );
  }
  return <CircleStop size={18} />;
}
