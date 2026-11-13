/**
 * Tells Sentry when an agent's history view stops being recognized, once per agent
 * per launch. The find bar's history view (`AgentHistoryView`) knows the view is
 * open by reading the agent's screen, which an agent update can change without
 * notice. When that happens the host puts the agent back and the bar quietly keeps
 * the on-screen search, which is safe and silent: without a report, nobody would
 * know the whole-conversation search had stopped working.
 *
 * Only `unrecognized-view` reports. `did-not-open` is also what a dialog that
 * ignores the key produces, an expected state on every machine.
 *
 * Main-only: the pty host never imports analytics or Sentry
 * (`pty-host-out-of-process.md`), so the host returns the outcome and main reports
 * it here. The event carries the agent's name and nothing from its screen.
 */

import { reportHandledError } from '../analytics/error-reporting';

const reported = new Set<string>();

export function reportUnrecognizedHistoryView(agentName: string | null): void {
  const agent = agentName ?? 'unknown';
  if (reported.has(agent)) return;
  reported.add(agent);
  // Fingerprinted, so one agent's drift is one issue whichever caller saw it.
  reportHandledError(new Error('Agent history view was not recognized'), { source: 'history_view', agent }, {}, ['history-view', agent]);
}

/** Forget what this launch reported. Tests only. */
export function resetHistoryViewReports(): void {
  reported.clear();
}
