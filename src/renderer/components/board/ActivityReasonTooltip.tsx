import type { ReactNode } from 'react';
import { Wrench, Users, Terminal } from 'lucide-react';
import { ActivityMark } from '../ActivityMark';
import { formatActivityReasonText } from './activity-reason-text';
import { waitMarkForReason } from './agent-wait';
import type { ActivityReason } from '../../../shared/types';

/**
 * The glyph for a reason's kind, the one `ActivityReasonTooltip` below draws, with no colour
 * class: it takes the colour of the text it leads. TaskCard's Tooltip opens with it.
 */
export function activityReasonIcon(reason: ActivityReason): ReactNode {
  switch (reason.kind) {
    case 'idle': return <ActivityMark mark="agent-idle" size={12} />;
    case 'permission': return <ActivityMark mark={waitMarkForReason(reason)} size={12} />;
    case 'tool': return <Wrench size={12} />;
    case 'subagent': return <Users size={12} />;
    case 'background-shell': return <Terminal size={12} />;
    case 'turn-active': return <ActivityMark mark="agent-working" size={12} />;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * Renders a tiny icon + label pair describing the engine's reason
 * for the current activity state. Used as the body of a hover
 * tooltip on the TaskCard's activity indicator.
 *
 * Icons map directly to reason kinds. The two that describe agent activity itself come from
 * the shared branding set (so they match the TaskCard indicator exactly); the rest name a
 * specific cause and have no counterpart there, so they stay lucide:
 *   idle             - ActivityMark 'agent-idle'    (matches the TaskCard idle indicator)
 *   permission       - ActivityMark 'agent-question' or 'agent-approval', by the wait's kind
 *                      (matches the TaskCard waiting indicator; an unknown kind is a question)
 *   turn-active      - ActivityMark 'agent-working' (matches the TaskCard thinking indicator)
 *   tool             - Wrench
 *   subagent         - Users
 *   background-shell - Terminal
 */
export function ActivityReasonTooltip({ reason, now }: {
  reason: ActivityReason;
  /**
   * The moment the elapsed idle / permission wait is measured against, epoch
   * ms. Supplied by the host rather than read from the clock here: a render
   * must be pure (React's compiler rules), and the host decides how often the
   * duration ticks.
   */
  now: number;
}): ReactNode {
  // The label is the same text the card's Tooltip and the monitor read.
  const label = formatActivityReasonText(reason, now);
  switch (reason.kind) {
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <ActivityMark mark="agent-idle" size={12} className="text-attention" />
          <span>{label}</span>
        </span>
      );
    case 'permission':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <ActivityMark mark={waitMarkForReason(reason)} size={12} className="text-attention" />
          <span>{label}</span>
        </span>
      );
    case 'tool':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Wrench size={12} className="text-blue-400" />
          <span>{label}</span>
        </span>
      );
    case 'subagent':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Users size={12} className="text-purple-400" />
          <span>{label}</span>
        </span>
      );
    case 'background-shell':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Terminal size={12} className="text-active" />
          <span>{label}</span>
        </span>
      );
    case 'turn-active':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <ActivityMark mark="agent-working" size={12} className="text-active" />
          <span>{label}</span>
        </span>
      );
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
