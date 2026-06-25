import type { ReactNode } from 'react';
import { Wrench, Users, Terminal, Lock, Loader2, Mail } from 'lucide-react';
import type { ActivityReason } from '../../../shared/types';

/**
 * Plain-text summary of an `ActivityReason`. Used as a `title` attribute
 * on TaskCard's activity icon so users get a native browser tooltip
 * explaining why the spinner is on (or why an idle session is paused).
 *
 * Same priority ladder as the engine: permission > tool > subagent >
 * background-shell > turn-active > idle.
 */
export function formatActivityReasonText(reason: ActivityReason): string {
  switch (reason.kind) {
    case 'idle': return 'Idle';
    case 'permission': return 'Awaiting permission';
    case 'tool': {
      if (reason.currentTool) return `Running ${reason.currentTool}`;
      return `${reason.pendingCount} tool${reason.pendingCount === 1 ? '' : 's'} in flight`;
    }
    case 'subagent': return `${reason.depth} subagent${reason.depth === 1 ? '' : 's'} active`;
    case 'background-shell': {
      const idsHint = reason.ids.length > 0 ? ` (${reason.ids.join(', ')})` : '';
      return `${reason.count} background shell${reason.count === 1 ? '' : 's'}${idsHint}`;
    }
    case 'turn-active': return 'Thinking';
  }
}

/**
 * Renders a tiny icon + label pair describing the engine's reason
 * for the current activity state. Used as the body of a hover
 * tooltip on the TaskCard's activity indicator.
 *
 * Lucide icons map directly to reason kinds:
 *   tool             - Wrench
 *   subagent         - Users
 *   background-shell - Terminal
 *   permission       - Lock
 *   turn-active      - Loader2 (spinning)
 *   idle             - Mail (matches the existing TaskCard idle icon)
 */
export function ActivityReasonTooltip({ reason }: { reason: ActivityReason }): ReactNode {
  switch (reason.kind) {
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Mail size={12} className="text-attention" />
          <span>Idle</span>
        </span>
      );
    case 'permission':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Lock size={12} className="text-attention" />
          <span>Awaiting permission</span>
        </span>
      );
    case 'tool':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Wrench size={12} className="text-blue-400" />
          <span>
            {reason.currentTool ? `Running ${reason.currentTool}` : `${reason.pendingCount} tool${reason.pendingCount === 1 ? '' : 's'} in flight`}
          </span>
        </span>
      );
    case 'subagent':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Users size={12} className="text-purple-400" />
          <span>{reason.depth} subagent{reason.depth === 1 ? '' : 's'} active</span>
        </span>
      );
    case 'background-shell':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Terminal size={12} className="text-active" />
          <span>
            {reason.count} background shell{reason.count === 1 ? '' : 's'}
            {reason.ids.length > 0 ? ` (${reason.ids.join(', ')})` : ''}
          </span>
        </span>
      );
    case 'turn-active':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint">
          <Loader2 size={12} className="text-active animate-spin" />
          <span>Thinking</span>
        </span>
      );
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
