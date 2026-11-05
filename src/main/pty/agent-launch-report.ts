/**
 * Tells Sentry, and the local log, about an agent launch that never started.
 *
 * Nothing throws when this happens: a typed command that never ran leaves a
 * shell at its prompt, and `spawn_failed` fires only on failures before the PTY
 * is written to. The agent-absence sweep is the one thing that sees it, and it
 * says nothing about why.
 *
 * The event carries a fixed message and tags, never command text or a path: a
 * command holds the task's prompt. The shell tag comes from a fixed list so a
 * configured shell's path, or a distro's name, cannot reach it.
 *
 * Main-only: the pty host never imports Sentry (`pty-host-out-of-process.md`).
 */

import { reportHandledError } from '../analytics/error-reporting';
import { shellProgramName } from '../../shared/shell-quote';
import type { ManagedSession } from './session-registry';

const REPORTED_SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'fish', 'nu', 'pwsh', 'powershell', 'sh', 'dash', 'ksh', 'cmd']);

function shellLabelOf(shell: string): string {
  const program = shellProgramName(shell);
  return REPORTED_SHELLS.has(program) ? program : 'other';
}

/**
 * True for a session the sweep found agentless that never showed its agent
 * started. Only an adapter that reports a start can say so
 * (`AgentParser.reportsAgentStart`): for any other, silence proves nothing.
 */
export function launchNeverStarted(session: ManagedSession): boolean {
  if (session.reportsAgentStart !== true) return false;
  if (typeof session.agentStartObservedAt === 'number') return false;
  if (typeof session.altScreenEnteredAt === 'number') return false;
  return typeof session.agentEndSignaledAt !== 'number';
}

/** One handled report and one local warning for a launch that never started. */
export function reportAgentNeverStarted(session: ManagedSession, now: number = Date.now()): void {
  const shell = shellLabelOf(session.shell);
  const typedLineBytes = session.typedLineBytes ?? 0;
  const launcher = session.launcherUsed === true ? 'yes' : 'no';
  const sessionAgeSeconds = Math.round((now - Date.parse(session.startedAt)) / 1000);
  console.warn(
    `[AGENT-LAUNCH] session=${session.id.slice(0, 8)} never started: shell=${shell} typedLineBytes=${typedLineBytes} launcher=${launcher} ageSeconds=${sessionAgeSeconds}`,
  );
  reportHandledError(new Error('Agent launch never started'), {
    source: 'agent_launch',
    platform: process.platform,
    shell,
    typed_line_bytes: String(typedLineBytes),
    session_age_s: String(sessionAgeSeconds),
    launcher,
  });
}
