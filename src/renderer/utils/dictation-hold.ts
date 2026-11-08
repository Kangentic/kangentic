/**
 * The decisions behind a push-to-talk hold: what a press means, and which pointer
 * event ends a hold and how. Pure, so each case is tested on its own against the
 * measured event order (docs/architecture/dictation.md).
 */

import { isMouseCombo } from '../../shared/keybindings';
import type { DictationHoldEndReason } from '../../shared/types';
import { isMouseComboButton, matchesMouseRelease } from './keybindings';

/**
 * What a press of the push-to-talk input means.
 *
 * - `start`: nothing is running, so dictate.
 * - `finish`: already recording, so the release was missed. This press ends that
 *   hold. Swallowing it is what left the mic open until a further release.
 * - `ignore`: a keyboard auto-repeat, or a press while the last utterance is
 *   finishing. Starting then would drop its sink and the count of what it wrote,
 *   so the erase would remove nothing and the live text would stay in front of
 *   the refined text.
 */
export function decidePress(state: { active: boolean; finalizing: boolean; repeat: boolean }): 'start' | 'finish' | 'ignore' {
  if (state.repeat || state.finalizing) return 'ignore';
  return state.active ? 'finish' : 'start';
}

export interface HoldEnd {
  reason: DictationHoldEndReason;
  /** Only a lift of the bound button itself can be a tap that navigates. */
  mayNavigate: boolean;
  /** Whether the event is the bound button's own, to keep from the page. Anything
   *  else is a click or a stroke of the user's that must still arrive. */
  consume: boolean;
}

/** Whether a pointer event seen during a hold ends it, or null while it goes on. */
export function holdEndFromPointer(event: PointerEvent, combo: string): HoldEnd | null {
  if (!isMouseCombo(combo)) return null;
  if (event.type === 'pointercancel') {
    if (event.pointerType !== 'mouse') return null;
    return { reason: 'pointercancel', mayNavigate: false, consume: false };
  }
  if (!matchesMouseRelease(event, combo)) return null;
  if (!isMouseComboButton(event.button, combo)) return { reason: 'missed-release', mayNavigate: false, consume: false };
  if (event.type === 'pointerup') return { reason: 'released', mayNavigate: true, consume: true };
  if (event.type === 'pointermove') return { reason: 'lifted-with-other-button', mayNavigate: true, consume: false };
  return null;
}
