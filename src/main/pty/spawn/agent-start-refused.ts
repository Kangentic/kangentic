import fs from 'node:fs';
import type { StartBlockedReason } from '../../../shared/types';

// The refusals of an agent's start that come before it has a PTY. A module of
// its own, importing nothing that reports, so the launch report can read a
// refusal's `reason` without an import cycle through `pty-spawn.ts`.

/**
 * An agent's start refused before it had a PTY. `SessionManager` puts `reason`
 * on the task's card, for a start and for a queued promotion alike.
 */
export abstract class AgentStartRefusedError extends Error {
  abstract readonly reason: StartBlockedReason;
}

/** Which folder a refused agent lost, for its card: Resume recreates a worktree and nothing else. */
export function startBlockedReasonForCwd(cwd: string): StartBlockedReason {
  return /[\\/]\.kangentic[\\/]worktrees[\\/]/.test(cwd) ? 'worktree-missing' : 'folder-missing';
}

/**
 * An agent session's folder is gone, so it was not started.
 *
 * A plain shell may land in the home directory, but an agent there is a run
 * nobody asked for: #1003 started `/merge-pull-request` in the home directory
 * with `--permission-mode auto`, with trust granted to the folder it asked for
 * and not the one it got, and only Claude's own trust dialog stopped it.
 */
export class AgentCwdMissingError extends AgentStartRefusedError {
  readonly reason: StartBlockedReason;

  constructor(readonly cwd: string) {
    super(`The folder this agent starts in no longer exists: ${cwd}`);
    this.name = 'AgentCwdMissingError';
    this.reason = startBlockedReasonForCwd(cwd);
  }
}

/** Refuse an agent's start whose folder is gone. Every agent spawn passes here (`performSpawn`). */
export function assertAgentCwdExists(cwd: string): void {
  if (!fs.existsSync(cwd)) throw new AgentCwdMissingError(cwd);
}

/**
 * An agent's command is too long for its shell, so it was not started.
 *
 * Measured on a 40,000 character task under PowerShell: the shell reports "The
 * filename or extension is too long" and the card shows a working agent for
 * about four minutes, through the absence sweep and a retry of the same command,
 * before it reads "The agent never reported that it started".
 */
export class AgentCommandTooLongError extends AgentStartRefusedError {
  readonly reason: StartBlockedReason = 'prompt-too-long';

  constructor() {
    super('This task\'s prompt is too long for this agent to start with.');
    this.name = 'AgentCommandTooLongError';
  }
}
