import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import { formatDurationBetween } from '../../lib/datetime';
import type { ActivityReason } from '../../../shared/types';

/**
 * Plain-text summary of an `ActivityReason`. TaskCard's activity mark takes it
 * as its name and its Tooltip, explaining why the spinner is on (or why an idle
 * session is paused), and the Agent Monitor's rows and cards draw it too.
 *
 * Same priority ladder as the engine: permission > tool > subagent >
 * background-shell > turn-active > idle.
 *
 * The idle/permission cases append how long the session has needed the user
 * (`reason.since`, epoch ms - `ActivityEngine`'s `needsUserSince`), measured
 * against `now`. A caller with no clock of its own passes nothing and gets the
 * moment of the call: a tooltip's text going a few seconds stale between
 * re-renders is normal (matches formatRelativeTime's own Date.now() read), and a
 * card-count worth of per-second timers on a busy board is not a cost worth
 * paying for a hover label.
 *
 * A `.ts` module, so it uses the runtime macro: the monitor's view model, which
 * is plain TypeScript, calls it too.
 */
export function formatActivityReasonText(reason: ActivityReason, now: number = Date.now()): string {
  switch (reason.kind) {
    case 'idle': {
      const duration = formatDurationBetween(reason.since, now);
      return i18n._(msg`Idle for ${{ duration }}`);
    }
    case 'permission': {
      // One message per kind, so a language can place the duration where it
      // reads. A wait whose agent did not report its kind says only that the
      // agent waits on the user.
      const duration = formatDurationBetween(reason.since, now);
      if (reason.waitKind === 'question') return i18n._(msg`Asking you a question for ${{ duration }}`);
      if (reason.waitKind === 'approval') return i18n._(msg`Waiting for your approval for ${{ duration }}`);
      return i18n._(msg`Waiting on you for ${{ duration }}`);
    }
    case 'tool': {
      if (reason.currentTool) {
        const toolName = reason.currentTool;
        return i18n._(msg`Running ${{ toolName }}`);
      }
      const count = reason.pendingCount;
      return i18n._(msg`${plural({ count }, { one: '# tool in flight', other: '# tools in flight' })}`);
    }
    case 'subagent': {
      const count = reason.depth;
      return i18n._(msg`${plural({ count }, { one: '# subagent active', other: '# subagents active' })}`);
    }
    case 'background-shell': {
      const count = reason.count;
      if (reason.ids.length === 0) {
        return i18n._(msg`${plural({ count }, { one: '# background shell', other: '# background shells' })}`);
      }
      const shellIds = reason.ids.join(', ');
      return i18n._(msg`${plural({ count }, {
        one: msg`# background shell (${{ shellIds }})`,
        other: msg`# background shells (${{ shellIds }})`,
      })}`);
    }
    case 'turn-active':
      return i18n._(msg({ message: 'Thinking', context: 'Agent status' }));
  }
}
