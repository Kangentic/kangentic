import type { ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useNow } from '../../hooks/useNow';
import type { ActivityReason } from '../../../shared/types';
import { activityReasonIcon } from './ActivityReasonTooltip';
import { formatActivityReasonText } from './activity-reason-text';
import { isStoppedReason } from './agent-wait';

/** How often a waiting mark re-reads the clock for its elapsed time: the text shows seconds. */
const WAIT_ELAPSED_TICK_MS = 1000;

export interface ActivityReasonTip {
  /**
   * The tip's text: the engine's reason, with how long a wait has lasted. Empty
   * for a stopped turn, which shows no tip (a person opens the task to read
   * why), and while the engine has reported no reason.
   */
  tipText: string;
  /** The reason's own glyph, which the tip leads with, or undefined when there is no tip. */
  icon: ReactNode | undefined;
  /** The mark's accessible name: the reason when there is one, else the state. */
  accessibleName: string;
}

/**
 * What an agent's activity mark says on hover and to a screen reader. The
 * board card's title row and the bottom panel's session tab both ask it, so
 * the two describe one session the same way.
 *
 * A mark that waits on the user (a finished turn, a question, an approval)
 * says how long it has waited, so it re-reads the clock every second, in the
 * calling component only: the tick re-renders that one mark and its tip.
 */
export function useActivityReasonTip({ activityReason, isIdle, isThinking }: {
  activityReason: ActivityReason | undefined;
  isIdle: boolean;
  isThinking: boolean;
}): ActivityReasonTip {
  const stopped = isStoppedReason(activityReason);
  const now = useNow(WAIT_ELAPSED_TICK_MS, isIdle && Boolean(activityReason) && !stopped);
  // Read once per render: the mark's name and its tip must match. A wait that
  // began after the last tick reads "0s" until the next one, at most a second.
  const reasonText = activityReason ? formatActivityReasonText(activityReason, now) : '';
  const tipText = stopped ? '' : reasonText;
  const accessibleName = reasonText !== ''
    ? reasonText
    : isThinking
      ? i18n._(msg({ message: 'Thinking', context: 'Agent status' }))
      : i18n._(msg({ message: 'Idle', context: 'Agent status' }));
  return {
    tipText,
    icon: tipText !== '' && activityReason ? activityReasonIcon(activityReason) : undefined,
    accessibleName,
  };
}
