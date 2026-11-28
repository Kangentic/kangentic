import fs from 'node:fs';
import type { StartBlockedReason } from '../../../shared/types';
import type { BatchShimGiveUp, BatchShimGiveUpDetail, BatchShimPs1Refusal, BatchShimShape } from '../../agent/shared/npm-shim-target';

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

/** What both `prompt-too-long` refusals say, since the card reason is the same. */
const PROMPT_TOO_LONG_MESSAGE = 'This task\'s prompt is too long for this agent to start with.';

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
    super(PROMPT_TOO_LONG_MESSAGE);
    this.name = 'AgentCommandTooLongError';
  }
}

/**
 * A launch past cmd's typed budget whose head is a `.cmd` shim this cannot
 * read past, so it was not started. Any shell: PowerShell and Git Bash hand a
 * `.cmd` head to cmd too.
 *
 * Past that budget the launch has to start what the shim starts (through
 * `launch.cmd` under cmd, directly under the other shells), since the shim's
 * own `%*` line fails past its limit with no error. A shim that cannot be
 * resolved is refused here, before the PTY, with the same card reason as a
 * command too long for its shell, so the card never shows a working agent
 * (Sentry DESKTOP-3Q, DESKTOP-3R).
 *
 * Reportable on purpose, unlike `AgentCommandTooLongError`: a shim this cannot
 * resolve is a gap in the launcher, not the user's prompt, and `shimGaveUp`
 * (the `batch_shim` tag) says which shape to support next. For a shim that did
 * not parse, `shimShape` (the `batch_shim_shape` tag) says what its program line
 * looked like, read from its text and never the text itself (Sentry DESKTOP-3Y).
 * For a `.ps1` target, `shimPs1` (the `batch_shim_ps1` tag) says which of its
 * refusals it was (DESKTOP-3Y again, on 0.64.0).
 */
export class AgentBatchShimUnresolvedError extends AgentStartRefusedError {
  readonly reason: StartBlockedReason = 'prompt-too-long';
  readonly shimGaveUp: BatchShimGiveUp;
  readonly shimShape?: BatchShimShape;
  readonly shimPs1?: BatchShimPs1Refusal;

  constructor(detail: BatchShimGiveUpDetail) {
    super(PROMPT_TOO_LONG_MESSAGE);
    this.name = 'AgentBatchShimUnresolvedError';
    this.shimGaveUp = detail.gaveUp;
    if (detail.shape) this.shimShape = detail.shape;
    if (detail.ps1) this.shimPs1 = detail.ps1;
  }
}
