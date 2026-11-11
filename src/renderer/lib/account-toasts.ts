import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import type { AgentAccountSwitched, AgentAccountSwitchResult, AgentAccountsAllFull } from '../../shared/agent-accounts';
import { agentDisplayName } from '../utils/agent-display-name';
import { formatDuration } from '../utils/format-session';
import { formatMonthDayTime } from './datetime';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The toast for a session that reached its usage limit and continues on another account. */
export function describeAccountSwitched(switched: AgentAccountSwitched, taskTitle: string | null): { title: string; message: string } {
  const accountName = switched.accountName ?? agentDisplayName(switched.agent);
  return {
    title: i18n._(msg`Switched account`),
    message: taskTitle
      ? i18n._(msg`"${{ taskTitle }}" continues on ${{ accountName }}.`)
      : i18n._(msg`A session continues on ${{ accountName }}.`),
  };
}

/**
 * The toast for a Switch to. The row moving to the top is on screen; what it did to the agent's
 * running sessions happens on the board behind the panel, so the toast says that: how many
 * moved, how many could not be, or that new sessions start on the account when none was running.
 */
export function describeAccountSwitchResult(result: AgentAccountSwitchResult): { title: string; message: string; variant: 'success' | 'error' } {
  if (!result.ok) {
    return { title: i18n._(msg`Couldn't switch account`), message: i18n._(msg`The account is no longer in the list.`), variant: 'error' };
  }
  const agentName = result.agent ? agentDisplayName(result.agent) : '';
  const accountName = result.accountName ?? agentName;
  const failed = result.failed;
  if (failed > 0) {
    return {
      title: i18n._(msg`Couldn't move every session`),
      message: i18n._(msg`${plural({ failed }, { one: '# running session stays on its account.', other: '# running sessions stay on their accounts.' })}`),
      variant: 'error',
    };
  }
  const moved = result.moved;
  return {
    title: i18n._(msg`Switched account`),
    message: moved > 0
      ? i18n._(msg`${plural({ moved }, { one: '# running session', other: '# running sessions' })} moved to ${{ accountName }}.`)
      : i18n._(msg`New ${{ agentName }} sessions start on ${{ accountName }}.`),
    variant: 'success',
  };
}

/** The toast for an agent whose every account is at its limit: when its sessions continue. */
export function describeAccountsAllFull(allFull: AgentAccountsAllFull, nowMs: number): { title: string; message: string } {
  const agentName = agentDisplayName(allFull.agent);
  const title = i18n._(msg`All accounts at their limit`);
  const untilResetMs = allFull.resetsAt === null ? null : allFull.resetsAt * 1000 - nowMs;
  if (untilResetMs === null || untilResetMs <= 0) {
    return { title, message: i18n._(msg`${{ agentName }} sessions continue when the first account resets.`) };
  }
  if (untilResetMs < DAY_MS) {
    const duration = formatDuration(untilResetMs);
    return { title, message: i18n._(msg`${{ agentName }} sessions continue in ${{ duration }}, when the first account resets.`) };
  }
  const resetMoment = formatMonthDayTime((allFull.resetsAt ?? 0) * 1000);
  return { title, message: i18n._(msg`${{ agentName }} sessions continue ${{ resetMoment }}, when the first account resets.`) };
}
