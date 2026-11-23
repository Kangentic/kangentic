/**
 * Tells Sentry, and the local log, about an agent launch that failed. Every
 * launch failure comes through `reportLaunchFailure`, whatever stage it died at.
 *
 * Most of these throw nothing: a typed command that never ran leaves a shell at
 * its prompt, and a person who gives up leaves no error at all. Every agent on
 * the board depends on this step, so a report has to carry enough to fix a
 * launch without asking anyone for logs.
 *
 * An event carries fixed values and never command text, scrollback or a path: a
 * command holds the task's prompt, and scrollback can hold secrets. The last
 * output is classified here into a fixed list and only the class leaves. A git
 * error holds a branch named after a task, so a preflight report sends a fixed
 * message and a cause rather than the error's text.
 *
 * Grouping: Sentry groups by error type and in-app frames, so each stage has its
 * own error name and a fingerprint of stage and cause, and each cause opens its
 * own issue whichever call path reported it. `pty_spawn` is the exception. Its
 * issues predate this file and are grouped on the lines in `recordSpawnFailure`,
 * which claim the report here and keep sending from those lines.
 *
 * Main-only: the pty host never imports Sentry (`pty-host-out-of-process.md`).
 */

import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import { trackEvent } from '../analytics/analytics';
import { reportHandledError } from '../analytics/error-reporting';
import { isReported, markReported, pathFreeCopy } from '../analytics/handled-report';
import { isShuttingDown } from '../shutdown-state';
import { isAbortError } from '../../shared/abort-utils';
import { AgentUserSetupError, isUserConfigurationError, type UserSetupFailure } from '../../shared/user-configuration-error';
import { shellProgramName } from '../../shared/shell-quote';
import type { LaunchStartPath, OpeningPromptDelivery, SessionIdCreationOutcome, SessionIdLoginEvidence, SessionIdStoreEvidence } from '../../shared/types';
import {
  SESSION_ID_CAPTURE_SOURCES,
  SESSION_ID_CAPTURE_WINDOW_MS,
  type SessionIdCaptureOutcome,
  type SessionIdCaptureSource,
} from './lifecycle/session-id-manager';
import { cliIdentitySinceDetection, type CliIdentitySinceDetection } from '../agent/shared/cli-identity';
import { cliVersionTag } from '../agent/shared/cli-version-tag';
import { WorktreeSetupScriptError } from '../git/worktree-errors';
import type { AgentProcessPresence } from './host/agent-process-presence';
import { classifyLaunchOutput, otherFromOf, type LaunchOutputClass } from './launch-output-class';
import { AGENT_READY_CEILING_MS } from './lifecycle/agent-output-tracker';
import { parseWslShellSpec } from './process-tag/task-process-tag';
import { AgentBatchShimUnresolvedError, AgentCommandTooLongError, AgentStartRefusedError } from './spawn/agent-start-refused';
import type { ManagedSession } from './session-registry';
import { HOST_UNREACHABLE_ERROR_NAME } from '../remote/link/host-unreachable-error';

// Re-exported for the callers that also read this file's report functions. A
// module that must not reach `electron` imports `launch-output-class.ts` itself.
export { classifyLaunchOutput, lineTooLongSentence, type LaunchOutputClass } from './launch-output-class';

/** Where a launch died. */
export type LaunchStage =
  /** A step before any PTY: a worktree, a checkout, a session folder, an adapter. */
  | 'preflight'
  /** The shell did not spawn. */
  | 'pty_spawn'
  /** The shell exited on its own with no sign the agent ran. */
  | 'shell_exit'
  /** The sweep or the timer found no agent and no sign it ever ran. */
  | 'never_started'
  /**
   * The CLI ran and named its own startup failure, or ran under a minute, exited
   * on its own and left no conversation (`no_conversation`, from the session-id
   * report: `exitedWithNoConversation`).
   */
  | 'agent_exited'
  /** A person stopped a launch that had shown nothing for `LAUNCH_ABANDON_MS`. */
  | 'abandoned'
  /** A renderer's terminal port was not delivered. */
  | 'pty_port';

/** Each stage's error name, which is what titles its Sentry issues. */
const LAUNCH_ERROR_NAMES: Readonly<Record<Exclude<LaunchStage, 'pty_spawn'>, string>> = {
  preflight: 'AgentLaunchPreflightError',
  shell_exit: 'AgentLaunchShellExitError',
  never_started: 'AgentLaunchNeverStartedError',
  agent_exited: 'AgentLaunchAgentExitedError',
  abandoned: 'AgentLaunchAbandonedError',
  pty_port: 'PtyPortDeliveryError',
};

/** How a session ended, for a launch a person gave up on. */
export type LaunchEndedBy = 'pause' | 'kill' | 'quit';

/**
 * How long a launch may show nothing before a person ending it counts as giving
 * up. The launch overlay's own ceiling: a cold Claude Code reaches its alt screen
 * in about 3 s, so sooner than this is a quick Stop, and a Stop after it comes
 * from someone watching a terminal that did nothing.
 */
export const LAUNCH_ABANDON_MS = AGENT_READY_CEILING_MS;

const REPORTED_SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'fish', 'nu', 'pwsh', 'powershell', 'sh', 'dash', 'ksh', 'cmd']);

/** The shell's name from a fixed list, so a configured path or a distro's name cannot reach an event. */
export function shellLabelOf(shell: string): string {
  const program = shellProgramName(shell);
  return REPORTED_SHELLS.has(program) ? program : 'other';
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function agentTag(agentName: string | null | undefined): string {
  if (!agentName) return 'none';
  return AGENT_ID.test(agentName) ? agentName : 'other';
}

const SECONDS_BUCKETS: ReadonlyArray<{ below: number; label: string }> = [
  { below: 1, label: '<1' },
  { below: 5, label: '1-5' },
  { below: 15, label: '5-15' },
  { below: 30, label: '15-30' },
  { below: 60, label: '30-60' },
  { below: 300, label: '60-300' },
];

function secondsBucket(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return SECONDS_BUCKETS.find((bucket) => seconds < bucket.below)?.label ?? '>300';
}

function launcherTag(session: ManagedSession): string {
  if (!session.launcherPath) return 'none';
  try {
    return fs.existsSync(session.launcherPath) ? 'present' : 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * Whether the command's head, the CLI path the builder was handed, exists now.
 * `no_such_file` names either that path or one the CLI runs, and this tells
 * them apart. `unknown` when there is no path to check: none was recorded, a
 * bare name the shell looks up on its PATH, or a WSL shell, whose paths live in
 * the distro.
 *
 * Off Windows the builder runs the very path detection probed:
 * `resolveShimLaunch` changes nothing there, and detection keeps `which`'s
 * answer without resolving links. What can differ is the moment. One shape this
 * tag would show: a head that links to a versioned install whose target was
 * removed after detection ran. `existsSync` follows the link, so a dangling one
 * reads `missing`. Sentry DESKTOP-2H (zsh, `no_such_file`, seconds after
 * detection) could not say which file was missing; this tag is what will.
 */
function commandHeadTag(session: ManagedSession): string {
  const cliPath = checkableCliPathOf(session);
  if (!cliPath) return 'unknown';
  try {
    return fs.existsSync(cliPath) ? 'present' : 'missing';
  } catch {
    return 'missing';
  }
}

/** The command head as a path this process can check, or null: none recorded, a bare name, or a WSL shell's. */
function checkableCliPathOf(session: ManagedSession): string | null {
  const cliPath = session.agentCliPath;
  if (!cliPath || !path.isAbsolute(cliPath) || parseWslShellSpec(session.shell) !== null) return null;
  return cliPath;
}

/**
 * Whether the command head still resolves to the file detection found
 * (`cli-identity.ts`): `changed` is a CLI replaced, repointed or removed under a
 * running app since detection, which the macOS install behind DESKTOP-2E and
 * DESKTOP-2H fits. `unknown` where detection recorded nothing for this path.
 */
function commandHeadSinceDetectionTag(session: ManagedSession): CliIdentitySinceDetection {
  const cliPath = checkableCliPathOf(session);
  return cliPath ? cliIdentitySinceDetection(cliPath) : 'unknown';
}

/**
 * Whether the shell printed, and on which side of the typed line. A plain yes
 * would nearly always read yes, since the shell echoes the line it is typed.
 */
function shellPrintedTag(session: ManagedSession): string {
  if (typeof session.agentOutputAt === 'number') return 'after_launch';
  return typeof session.firstOutputAt === 'number' ? 'before_launch' : 'none';
}

/** The attempt a session is: a retry is the second, and there is no third. */
function attemptOf(startPath: LaunchStartPath | undefined): string {
  return startPath === 'retry' ? '2' : '1';
}

/** The fixed values a report carries, each a tag on the event. */
export type LaunchTags = Readonly<Record<string, string>>;

/**
 * What the resume check read before a resume, for a resume that fails anyway:
 * Sentry DESKTOP-2M was a `conversation_missing` after the check answered
 * `unknown`, and could not say why. Every value is a fixed word, never a path.
 */
function resumeEvidenceTagsOf(session: ManagedSession): Record<string, string> {
  const evidence = session.resuming === true ? session.resumeEvidence : null;
  if (!evidence) return {};
  return {
    resume_turns: evidence.turns,
    resume_agent_report: evidence.agentReport,
    resume_transcript: evidence.transcript,
    resume_cwd: evidence.cwd,
    ...(evidence.account ? { resume_account: evidence.account } : {}),
  };
}

/** A session's facts at this moment. Synchronous, so they survive the kill that follows. */
export function launchTagsOf(session: ManagedSession, now: number = Date.now()): LaunchTags {
  const startedAtMs = Date.parse(session.startedAt);
  const firstOutputAt = session.firstOutputAt;
  return {
    ...resumeEvidenceTagsOf(session),
    agent: agentTag(session.agentName),
    agent_cli_version: cliVersionTag(session.agentCliVersion),
    start_path: session.startPath ?? 'board',
    shell: shellLabelOf(session.shell),
    attempt: attemptOf(session.startPath),
    launcher: launcherTag(session),
    command_head: commandHeadTag(session),
    command_head_since_detection: commandHeadSinceDetectionTag(session),
    shell_printed: shellPrintedTag(session),
    first_output_s: typeof firstOutputAt === 'number' ? secondsBucket(firstOutputAt - startedAtMs) : 'none',
    session_age_s: secondsBucket(now - startedAtMs),
    typed_line_bytes: String(session.typedLineBytes ?? 0),
    overlay_ceiling: typeof session.readyCeilingAt === 'number' ? 'tripped' : 'no',
  };
}

/** The tags for a launch that failed before it had a session. */
export function preflightTagsOf(input: {
  agent?: string | null;
  agentCliVersion?: string | null;
  startPath: LaunchStartPath;
}): LaunchTags {
  return {
    agent: agentTag(input.agent),
    agent_cli_version: cliVersionTag(input.agentCliVersion),
    start_path: input.startPath,
    attempt: attemptOf(input.startPath),
  };
}

/**
 * True when anything shows the agent ran: its start hook, its first frame, an end
 * signal, any other hook, or a session id it gave itself. The retry reads this,
 * so a run that left any of it is never started a second time.
 */
export function hasAgentRunEvidence(session: ManagedSession): boolean {
  return typeof session.agentStartObservedAt === 'number'
    || typeof session.altScreenEnteredAt === 'number'
    || typeof session.agentEndSignaledAt === 'number'
    || typeof session.agentHookObservedAt === 'number'
    || typeof session.agentIdReportedAt === 'number';
}

/**
 * True for a session that never showed its agent started. Only an adapter that
 * reports a start can say so (`AgentParser.reportsAgentStart`): for any other,
 * silence proves nothing.
 */
export function launchNeverStarted(session: ManagedSession): boolean {
  return session.reportsAgentStart === true && !hasAgentRunEvidence(session);
}

/**
 * Classify a session's output the one way both readers do: the launch report,
 * and the agent-absence sweep's check for a launch whose output already names
 * its cause (`SessionManager.checkPendingLaunchOutput`). A resuming launch asks
 * its adapter about the conversation it resumed.
 */
export function classifySessionOutput(session: ManagedSession, rawScrollback: string): LaunchOutputClass {
  return classifyLaunchOutput(rawScrollback, session.agentParser, session.resuming ? session.agentSessionId : null);
}

/** True for a class that names a cause, which is evidence for any adapter. */
export function isIdentifiedFailureClass(outputClass: LaunchOutputClass): boolean {
  return outputClass !== 'other' && outputClass !== 'not_read' && outputClass !== 'unreadable';
}

/** True for a cause identified as the user's own setup, which gets no retry and no event. */
export function isUserSetupFailureClass(outputClass: LaunchOutputClass): outputClass is UserSetupFailure {
  return outputClass === 'login_required' || outputClass === 'bad_configuration';
}

/**
 * True for a cause a second launch of the same line cannot change. The shell's
 * own classes (`exec_format`, `killed`, `crashed`, `launcher_unreadable`) keep
 * their retry: the file under the command can change between two launches, as
 * a CLI update replaces it, and the CLI identity tag exists because it does.
 */
export function isLaunchRetryPointless(outputClass: LaunchOutputClass): boolean {
  return isUserSetupFailureClass(outputClass) || outputClass === 'line_too_long';
}

const reported = new Set<string>();

/** What `reportLaunchFailure` takes. */
export interface LaunchFailure {
  stage: LaunchStage;
  /** A fixed value naming the cause. It opens the issue, and is never text from outside. */
  cause: string;
  tags: LaunchTags;
  /** Short session id for the local line. Absent when the launch had no session. */
  sessionLabel?: string;
  /**
   * The error that failed the launch. Its name and frames are sent, never its
   * message: an error's text here held branch names, task titles and URLs, and
   * `redactPaths` removed only the paths. The message sent is the built one.
   */
  error?: Error;
  /** The error's message is the caller's own fixed sentence, so it may go as written. */
  messageIsFixed?: boolean;
}

function builtError(stage: LaunchStage, cause: string): Error {
  const error = new Error(`Agent launch failed: ${stage} (${cause})`);
  if (stage !== 'pty_spawn') error.name = LAUNCH_ERROR_NAMES[stage];
  return error;
}

/**
 * The built error, fixed name and message, carrying the original's frames. The
 * original's class goes as the `error_type` tag (`errorShapeTags`), so the issue
 * title stays the stage's whatever threw.
 */
function fixedMessageCopyOf(error: Error, stage: LaunchStage, cause: string): Error {
  const copy = builtError(stage, cause);
  const original = pathFreeCopy('agent_launch', error);
  const newline = original.stack?.indexOf('\n') ?? -1;
  const frames = newline === -1 ? '' : original.stack?.slice(newline) ?? '';
  if (frames) copy.stack = `${copy.name}: ${copy.message}${frames}`;
  return copy;
}

/** A step of a launch that went as it should, in the trail a failure's event carries. */
export type LaunchStep = 'spawned' | 'first_output' | 'typed_line_ran' | 'agent_ran' | 'exited';

/**
 * One line of a launch's trail. `[AGENT-LAUNCH]` is a breadcrumb tag, so these
 * reach an event as the steps before it, and they hold fixed values only.
 */
export function logLaunchStep(session: ManagedSession, step: LaunchStep): void {
  // breadcrumb-ok: a session id, a fixed step, and an agent and shell from fixed lists.
  console.log(`[AGENT-LAUNCH] session=${session.id.slice(0, 8)} step=${step} agent=${agentTag(session.agentName)} shell=${shellLabelOf(session.shell)}`);
}

function logLaunchFailure(failure: LaunchFailure): void {
  const { stage, cause, tags, sessionLabel } = failure;
  const facts = Object.entries(tags).map(([name, value]) => `${name}=${value}`).join(' ');
  // breadcrumb-ok: session ids and the fixed tag values above, no user content.
  console.warn(`[AGENT-LAUNCH] ${sessionLabel ? `session=${sessionLabel} ` : ''}stage=${stage} cause=${cause} ${facts}`);
}

/**
 * One local line, then the tags to send, or null when this class already
 * reported. One event per class per run, so one broken machine cannot use up the
 * org's event quota. A class is its stage, cause, attempt and agent: a retry that
 * also fails has to reach Sentry, or a retry that worked and one that did not
 * would read the same, and one agent's failure must not hide another's.
 *
 * An excluded failure latches apart: a missing CLI must not spend the one event
 * a real failure of the same cause would send.
 *
 * Every report passes here. `reportLaunchFailure` is the usual way in, and
 * `recordSpawnFailure` calls this itself because its issues are grouped on its
 * own lines of code.
 */
export function claimLaunchReport(failure: LaunchFailure): Record<string, string> | null {
  logLaunchFailure(failure);
  const { stage, cause, tags, error } = failure;
  const key = `${stage}:${cause}:${tags.attempt ?? '1'}:${tags.agent ?? 'none'}:${isUserConfigurationError(error) ? 'excluded' : 'reported'}`;
  if (reported.has(key)) return null;
  reported.add(key);
  return {
    source: stage === 'pty_spawn' ? 'pty_spawn' : 'agent_launch',
    stage,
    cause,
    platform: process.platform,
    ...tags,
  };
}

/**
 * Report a launch failure. Whether it reaches Sentry is decided in one place,
 * `reportHandledError`, by the error's type. A user configuration error is passed
 * on as itself, since a copy would lose the type that decides.
 */
export function reportLaunchFailure(failure: LaunchFailure): void {
  const { stage, cause, error, messageIsFixed } = failure;
  // Marked whether or not this class already reported, so a chokepoint further up
  // (the IPC wrap, a caller's own catch) never sends the same failure again.
  if (error) markReported(error);
  const eventTags = claimLaunchReport(failure);
  if (!eventTags) return;
  const sent = !error
    ? builtError(stage, cause)
    : isUserConfigurationError(error) || messageIsFixed === true
      ? error
      : fixedMessageCopyOf(error, stage, cause);
  reportHandledError(sent, eventTags, {}, ['agent-launch', stage, cause]);
}

/** A class name, so a value here cannot carry a message. */
const ERROR_TYPE = /^[A-Za-z_$][\w$]{0,63}$/;
/** An errno, or a number. A code shaped like a branch name is left out. */
const ERROR_CODE = /^(?:[A-Z][A-Z0-9_]{0,63}|-?\d{1,10})$/;

function errorShapeTags(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return {};
  const tags: Record<string, string> = {};
  if (ERROR_TYPE.test(error.name)) tags.error_type = error.name;
  const code = String((error as NodeJS.ErrnoException).code ?? '');
  if (ERROR_CODE.test(code)) tags.errno = code;
  // A fixed value: which folder a refused start lost (a worktree or the project
  // folder), which its redacted path cannot say. Sentry DESKTOP-2P could not.
  if (error instanceof AgentStartRefusedError) tags.start_refused_reason = error.reason;
  // A fixed word: why a `.cmd` shim could not be read past (Sentry DESKTOP-3R
  // could not say which shim its user had).
  if (error instanceof AgentBatchShimUnresolvedError) tags.batch_shim = error.shimGaveUp;
  if (error instanceof WorktreeSetupScriptError) Object.assign(tags, setupScriptTags(error));
  return tags;
}

/** A signal's name. Anything else is left out. */
const SIGNAL_NAME = /^SIG[A-Z0-9]{1,10}$/;

/**
 * How a Post-Worktree Script ended, in fixed values: its exit code, the signal
 * that ended it, and whether the timeout stopped it. Sentry DESKTOP-3D had none
 * of these and could not tell an exit from a kill.
 */
function setupScriptTags(error: WorktreeSetupScriptError): Record<string, string> {
  const tags: Record<string, string> = {};
  if (typeof error.exitCode === 'number' && Number.isInteger(error.exitCode)) tags.script_exit = String(error.exitCode);
  if (error.signal && SIGNAL_NAME.test(error.signal)) tags.script_signal = error.signal;
  if (typeof error.timedOut === 'boolean') tags.timed_out = error.timedOut ? 'yes' : 'no';
  return tags;
}

/**
 * The cause a preflight report goes under. A start refused for a shim this
 * cannot resolve opens an issue of its own whichever path started it, rather
 * than joining that path's generic one and spending its one event per run.
 */
function preflightCauseOf(cause: string, error: unknown): string {
  return error instanceof AgentBatchShimUnresolvedError ? 'batch_shim_unresolved' : cause;
}

/**
 * The refusals of an SSH host's link, matched by name because they cross the pty host's transport.
 * `UnsupportedOnHostError` is a literal because its class lives in the link hub, which main never
 * bundles. Both are also in `EXPECTED_FAILURE_NAMES`.
 */
const REMOTE_LINK_REFUSALS: ReadonlySet<string> = new Set([HOST_UNREACHABLE_ERROR_NAME, 'UnsupportedOnHostError']);

function isRemoteLinkRefusalClass(error: unknown): boolean {
  return error instanceof Error && REMOTE_LINK_REFUSALS.has(error.name);
}

/**
 * True for a remote start the host's link refused, or a wrapper of one (one level
 * of `cause`, as `wrapWorktreeSetupError` wraps): the host has no link here, or the
 * request has no meaning on a host. That is the host's state, not a defect, and
 * the refusal's text has named the host's id. Only these classes: a pty host that
 * timed out or exited during a start is still ours to look at.
 */
export function isRemoteLinkRefusal(error: unknown): boolean {
  if (isRemoteLinkRefusalClass(error)) return true;
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  return cause !== undefined && cause !== error && isRemoteLinkRefusalClass(cause);
}

/** What `reportPreflightFailure` takes. */
export interface PreflightFailure {
  /** A fixed value: the step that failed. */
  cause: string;
  /** Null for a step that failed with a return value rather than a throw. */
  error: unknown;
  agent?: string | null;
  agentCliVersion?: string | null;
  startPath: LaunchStartPath;
  /** The caller counted this `spawn_failed` itself, so an excluded failure is not counted twice. */
  alreadyCounted?: boolean;
}

/**
 * A launch that failed before it had a PTY. The start was taken over rather than
 * failed when the error is an abort, and a user configuration error is the
 * user's to resolve, so neither reaches Sentry. An error already reported (a
 * `spawnAgent` failure its caller catches again after the rethrow) is skipped, so
 * one failure is one event.
 *
 * A prompt too long for its shell (`AgentCommandTooLongError`) is refused by
 * design and its card says so, so it is counted and never sent, on every path
 * that reports here. It returns before `claimLaunchReport`, so it spends no key:
 * a real failure on the same path later in the run still reports (Sentry
 * DESKTOP-3Z spent the run's one OpenCode resume key on one).
 *
 * A remote start its host's link refused (`isRemoteLinkRefusal`, bare or as the
 * `cause` of a wrapper) goes the same way: a local line, a `spawn_failed` count,
 * no event and no key. Sentry DESKTOP-4N was a `HostUnreachableError` sent as
 * `AgentLaunchPreflightError (worktree_other)`, a name that hid what it was. Not
 * every `isExpectedFailure` class: `AgentCwdMissingError` is one, and a start
 * whose folder is gone is reported here on purpose, since the folder can be our
 * own leak (DESKTOP-2P).
 *
 * A start that fails once the quit has begun is the quit, not a failed start:
 * a local line, no event, no `spawn_failed` count and no key. The spawn refuses
 * itself then, and a quit takes a host's links down under starts still running
 * (Sentry DESKTOP-4V: a Command Terminal start an update's install overtook).
 *
 * The event carries the error's name, errno and frames under a fixed message,
 * never the error's text (`fixedMessageCopyOf`).
 *
 * Called from catch blocks that go on to rethrow or notify, so it never throws:
 * a report must not replace the failure it reports.
 */
export function reportPreflightFailure(failure: PreflightFailure): void {
  try {
    const { error, agent, agentCliVersion, startPath, alreadyCounted } = failure;
    const cause = preflightCauseOf(failure.cause, error);
    if (isAbortError(error)) return;
    if (isReported(error)) return;
    if (isShuttingDown()) {
      if (error instanceof Error) markReported(error);
      // breadcrumb-ok: a fixed cause, an agent from a fixed list and a start path.
      console.warn(`[AGENT-LAUNCH] stage=preflight cause=${cause} agent=${agentTag(agent)} start_path=${startPath} shutdown=yes`);
      return;
    }
    if (error instanceof AgentCommandTooLongError) {
      markReported(error);
      if (alreadyCounted !== true) trackEvent('spawn_failed', { agent: agentTag(agent), reason: cause });
      return;
    }
    if (isRemoteLinkRefusal(error)) {
      markReported(error);
      // breadcrumb-ok: a fixed cause, an agent from a fixed list and a start path.
      console.warn(`[AGENT-LAUNCH] stage=preflight cause=${cause} agent=${agentTag(agent)} start_path=${startPath} expected=yes`);
      if (alreadyCounted !== true) trackEvent('spawn_failed', { agent: agentTag(agent), reason: cause });
      return;
    }
    const tags = {
      ...preflightTagsOf({ agent, agentCliVersion, startPath }),
      ...errorShapeTags(error),
    };
    const excluded = isUserConfigurationError(error);
    if (excluded && alreadyCounted !== true) trackEvent('spawn_failed', { agent: tags.agent, reason: cause });
    reportLaunchFailure({
      stage: 'preflight',
      cause,
      tags,
      ...(error instanceof Error ? { error } : {}),
    });
  } catch (reportError) {
    console.warn('[AGENT-LAUNCH] A preflight report failed:', reportError);
  }
}

/** A cause from a class: what stays unknown does not split an issue. */
function causeOf(outputClass: LaunchOutputClass): string {
  return outputClass === 'not_read' || outputClass === 'unreadable' ? 'unknown' : outputClass;
}

/** What `reportSessionLaunchFailure` takes. */
export interface SessionLaunchFailure {
  session: ManagedSession;
  stage: LaunchStage;
  /** Posts the read of the session's ring, or null when the ring is gone. */
  readOutput: (() => Promise<string>) | null;
  /** More fixed values, such as `ended_by` or the exit code. */
  extraTags?: LaunchTags;
  /** Report only when the output names a cause, for an adapter whose silence proves nothing. */
  onlyWhenIdentified?: boolean;
  /**
   * Whether the shell had an agent under it when the launch was ended, sent as
   * `agent_process`. The report waits for it as it waits for the ring's read.
   * Left out, the report has no such tag.
   */
  agentProcess?: Promise<AgentProcessPresence>;
}

/**
 * Report a session's launch failure, once per session (`launchFailureNoted`). The
 * tags are read now and the ring's read is posted now, ahead of whatever kill
 * comes next, so a caller that ends the session right after loses nothing. The
 * event goes when the read answers, and `launchOutputRead` holds what it found
 * for the retry to wait on. A read still out when the quit starts is dropped,
 * since nothing sent then would land.
 *
 * A cause identified as the user's goes through the same path and stops at
 * `reportHandledError`, by its type. Aptabase counts it, for the volume.
 */
export function reportSessionLaunchFailure(failure: SessionLaunchFailure): void {
  const { session, stage, readOutput, extraTags, onlyWhenIdentified, agentProcess } = failure;
  if (session.launchFailureNoted === true) return;
  session.launchFailureNoted = true;
  const tags = { ...launchTagsOf(session), ...extraTags };
  const send = (outputClass: LaunchOutputClass, laterTags: LaunchTags = {}): LaunchOutputClass => {
    if (isShuttingDown()) return outputClass;
    if (onlyWhenIdentified === true && !isIdentifiedFailureClass(outputClass)) return outputClass;
    const userSetupFailure = isUserSetupFailureClass(outputClass) ? outputClass : null;
    if (userSetupFailure) trackEvent('spawn_failed', { agent: tags.agent, reason: userSetupFailure });
    reportLaunchFailure({
      stage,
      cause: causeOf(outputClass),
      tags: { ...tags, ...laterTags, output_class: outputClass },
      sessionLabel: session.id.slice(0, 8),
      ...(userSetupFailure ? { error: new AgentUserSetupError(userSetupFailure) } : {}),
    });
    return outputClass;
  };
  const sendOnceRead = (outputClass: LaunchOutputClass, readTags: LaunchTags = {}): LaunchOutputClass | Promise<LaunchOutputClass> => {
    if (!agentProcess) return send(outputClass, readTags);
    return agentProcess.then(
      (presence) => send(outputClass, { ...readTags, agent_process: presence }),
      () => send(outputClass, { ...readTags, agent_process: 'unknown' }),
    );
  };
  if (!readOutput) {
    session.launchOutputRead = Promise.resolve(sendOnceRead('not_read'));
    return;
  }
  session.launchOutputRead = readOutput().then(
    (rawScrollback) => {
      const outputClass = classifySessionOutput(session, rawScrollback);
      // Output that named no cause says who wrote it, when it can: a shell's
      // refusal of the typed line and an agent that ran and left read the same.
      return sendOnceRead(outputClass, outputClass === 'other' ? { other_from: otherFromOf(rawScrollback) } : {});
    },
    () => sendOnceRead('unreadable'),
  );
}

/** A retry worked. Sent once, so a recovered failure still shows in Sentry. */
export function reportLaunchRecovered(session: ManagedSession): void {
  if (session.retryRecoveryNoted === true) return;
  session.retryRecoveryNoted = true;
  const error = new Error('Agent launch recovered on retry');
  error.name = 'AgentLaunchRecoveredError';
  reportLaunchFailure({
    stage: 'never_started',
    cause: 'recovered',
    tags: { ...launchTagsOf(session), retry: 'recovered' },
    sessionLabel: session.id.slice(0, 8),
    error,
    messageIsFixed: true,
  });
}

/**
 * A renderer that stays open never got its terminal port. Its terminals show
 * history and take no keystroke, and nothing else says so.
 */
export function reportPtyPortFailure(): void {
  reportLaunchFailure({ stage: 'pty_port', cause: 'not_delivered', tags: {} });
}

/** Agents whose session id was never captured this run, and those captured late. */
const neverCapturedSessionIdAgents = new Set<string>();
const lateSessionIdAgents = new Set<string>();

/** What each kind of session-id outcome sends: the latch it spends, its error name and fingerprint head. */
const SESSION_ID_OUTCOME_REPORTS = {
  late: {
    latch: lateSessionIdAgents,
    errorName: 'AgentSessionIdCapturedLateError',
    message: 'Agent session id captured late',
    fingerprintHead: 'agent-session-id-captured-late',
  },
  never: {
    latch: neverCapturedSessionIdAgents,
    errorName: 'AgentSessionIdNotCapturedError',
    message: 'Agent session id not captured',
    fingerprintHead: 'agent-session-id-not-captured',
  },
} as const;

/** The longest a session-id report waits on the agent's own store check. */
const STORE_EVIDENCE_WAIT_MS = 2_000;
/**
 * The longest it waits on the agent's login check, which can run the CLI
 * (`codex login status`, stopped by its adapter at 20 s). Counted from the
 * window, where the check starts, so an outcome minutes later waits on nothing.
 */
const LOGIN_EVIDENCE_WAIT_MS = 25_000;

const STORE_EVIDENCE_ANSWERS: ReadonlySet<SessionIdStoreEvidence> = new Set<SessionIdStoreEvidence>(['present', 'absent']);
const LOGIN_EVIDENCE_ANSWERS: ReadonlySet<SessionIdLoginEvidence> = new Set<SessionIdLoginEvidence>(['signed_in', 'signed_out']);

/**
 * A session past the capture window: its facts at the window, the store and
 * login checks started then, and its row, for the facts read when the outcome
 * is known.
 */
interface PendingSessionIdReport {
  agent: string;
  tags: Record<string, string>;
  storeEvidence: Promise<SessionIdStoreEvidence>;
  /** Asked again when a never-captured session settles: a conversation made after the window is no miss of ours. */
  storeCheck: (() => Promise<SessionIdStoreEvidence>) | null;
  loginEvidence: Promise<SessionIdLoginEvidence>;
  nodeEvidence: Promise<NodeOnPathEvidence>;
  /** Kept past a removal from the registry: the prompt, run and exit times are read off it at the outcome. */
  session: ManagedSession;
}

const pendingSessionIdReports = new Map<string, PendingSessionIdReport>();

/** Whether the moment was recorded, as `yes` or `no`. */
function observedTag(timestamp: number | null | undefined): string {
  return typeof timestamp === 'number' ? 'yes' : 'no';
}

const OPENING_PROMPT_TAGS: ReadonlySet<string> = new Set<OpeningPromptDelivery>(['command_line', 'typed', 'none']);

/** How the opening prompt was delivered, or `unknown`: a value from anywhere else never reaches a tag. */
function openingPromptTag(delivery: unknown): string {
  return typeof delivery === 'string' && OPENING_PROMPT_TAGS.has(delivery) ? delivery : 'unknown';
}

const SESSION_ID_CREATION_TAGS: ReadonlySet<string> = new Set<SessionIdCreationOutcome>(
  ['ok', 'failed', 'timeout', 'no_id', 'aborted', 'not_asked'],
);

/** How the launch got the conversation id before it ran, or `unknown`: a value from anywhere else never reaches a tag. */
function sessionIdCreationTag(outcome: unknown): string {
  return typeof outcome === 'string' && SESSION_ID_CREATION_TAGS.has(outcome) ? outcome : 'unknown';
}

const CAPTURE_SOURCE_TAGS: ReadonlySet<string> = new Set(SESSION_ID_CAPTURE_SOURCES);

/** The path that delivered a late id, or `unknown`: a value from anywhere else never reaches a tag. */
function captureSourceTag(source: unknown): string {
  return typeof source === 'string' && CAPTURE_SOURCE_TAGS.has(source) ? source : 'unknown';
}

/** Whether a bare `node` resolves where the session's hooks would look for it. */
type NodeOnPathEvidence = 'yes' | 'no' | 'unknown';

/** The longest the `node` lookup may take before it reads `unknown`. */
const NODE_EVIDENCE_WAIT_MS = 2_000;

/**
 * Whether a bare `node` resolves on main's PATH, the one a local session's shell
 * starts from. The command hooks Kangentic installs start the event bridge as
 * `node <bridge>` (OpenCode's plugin runs inside OpenCode and needs none), and
 * agy runs a hook whose program is missing silently (measured on 1.5.13), so
 * with no node no hook reaches Kangentic and an agent that makes its id at
 * its first turn gives it only in its output (Sentry DESKTOP-4J: an agy id
 * minutes late, with no SessionStart seen, on an install whose Codex sessions
 * missed their ids too). `unknown` for a session whose hooks run somewhere
 * else, in a WSL distro or on a host, and for a lookup that fails or overruns.
 * A node that only the shell's profile adds (a PowerShell profile running a
 * version manager), or one installed after Kangentic started, reads `no` here
 * and still runs the hooks, so `no` is a hint rather than proof.
 */
function nodeOnPathEvidence(session: ManagedSession): Promise<NodeOnPathEvidence> {
  if (session.hostId || session.cliTarget || parseWslShellSpec(session.shell) !== null) return Promise.resolve('unknown');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'unknown'>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), NODE_EVIDENCE_WAIT_MS);
    timer.unref?.();
  });
  const lookup = which('node', { nothrow: true }).then(
    (found): NodeOnPathEvidence => (found ? 'yes' : 'no'),
    // report-ok: a failed lookup is reported as the fixed value `unknown`.
    (): NodeOnPathEvidence => 'unknown',
  );
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

/** One of the agent's own checks, bounded, and `unknown` for anything but an answer it may give. */
function boundedEvidence<Evidence extends string>(
  check: (() => Promise<Evidence>) | null,
  answers: ReadonlySet<Evidence>,
  waitMs: number,
): Promise<Evidence | 'unknown'> {
  if (!check) return Promise.resolve('unknown');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'unknown'>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), waitMs);
    timer.unref?.();
  });
  const answer = Promise.resolve()
    .then(check)
    .then(
      (evidence): Evidence | 'unknown' => (answers.has(evidence) ? evidence : 'unknown'),
      // report-ok: a failed check is reported as the fixed value `unknown`.
      (): 'unknown' => 'unknown',
    );
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
}

/**
 * No capture path found the agent's own session id within the diagnostic window
 * (`SessionIdManager`). Nothing is reported yet: an id can still arrive, and a
 * report that cannot tell late from never (Sentry DESKTOP-36, DESKTOP-3A) says
 * nothing. Taken now, while the row exists, and sent by
 * `reportSessionIdCaptureOutcome` once the outcome is known. The agent's store
 * check (`sessionId.storeEvidence`) and login check (`sessionId.loginEvidence`)
 * start now too, as close to the miss as can be. An agent that already sent both
 * kinds this run is not held, and neither check runs: neither outcome could send
 * anything.
 */
export function noteSessionIdCaptureWindowPassed(
  session: ManagedSession,
  storeCheck: (() => Promise<SessionIdStoreEvidence>) | null,
  loginCheck: (() => Promise<SessionIdLoginEvidence>) | null = null,
): void {
  const agent = agentTag(session.agentName);
  if (neverCapturedSessionIdAgents.has(agent) && lateSessionIdAgents.has(agent)) return;
  pendingSessionIdReports.set(session.id, {
    agent,
    tags: {
      agent_cli_version: cliVersionTag(session.agentCliVersion),
      start_path: session.startPath ?? 'board',
      shell: shellLabelOf(session.shell),
      opening_prompt: openingPromptTag(session.openingPrompt),
      create_chat: sessionIdCreationTag(session.sessionIdCreation),
      // A line the agent's hooks wrote, never a stand-in the PTY or the engine pushed.
      hook_seen: observedTag(session.agentHookLineAt),
      agent_started: observedTag(session.agentStartObservedAt),
      first_output: observedTag(session.firstOutputAt),
    },
    storeEvidence: boundedEvidence(storeCheck, STORE_EVIDENCE_ANSWERS, STORE_EVIDENCE_WAIT_MS),
    storeCheck,
    loginEvidence: boundedEvidence(loginCheck, LOGIN_EVIDENCE_ANSWERS, LOGIN_EVIDENCE_WAIT_MS),
    nodeEvidence: nodeOnPathEvidence(session),
    session,
  });
}

/**
 * True when a session's missing or late id is the user's own setup and
 * nothing a capture path could fix: its CLI holds no login and no one's prompt
 * reached it. A signed-out CLI can open on its sign-in screen, which draws a
 * frame (so the agent reads as having run) and never makes a conversation.
 * Measured on Codex 0.163.0, and the shape of Sentry DESKTOP-36's recurrence.
 *
 * A never-captured session also needs a store that is not `present`, because
 * a CLI can answer "not logged in" and still work, on a key in its environment
 * or a model provider of its own. That one takes prompts and writes its store,
 * and its miss still reports, with `login` saying what the CLI answered.
 *
 * A late id needs no store fact. The id itself proves the conversation came
 * after the window, where the login check found the CLI signed out, so the
 * delay is the sign-in. And the store is no evidence there: Codex answers
 * `present` whenever a rollout folder for today or yesterday exists, so any
 * earlier run that day says so (Sentry DESKTOP-4C on 0.62.0: a Codex with its
 * prompt on the command line, signed out at the window, whose id came by the
 * hook one to five minutes later). That has a known cost. A CLI that works
 * signed out, sees no prompt and captures its id late goes unreported, since
 * nothing on record tells it apart from a sign-in.
 */
function explainedBySignedOutCli(
  session: ManagedSession,
  outcomeKind: SessionIdCaptureOutcome['kind'],
  login: SessionIdLoginEvidence,
  idStore: SessionIdStoreEvidence,
): boolean {
  if (login !== 'signed_out' || typeof session.promptObservedAt === 'number') return false;
  return outcomeKind === 'late' || idStore !== 'present';
}

/**
 * The store answer a never-captured session is judged on. The window's read is
 * five minutes old by the ceiling, and an agent that makes its conversation at
 * its first turn may have made it since, so the check is asked again. A read
 * that gives no answer falls back to the window's only when that one said
 * `present`: a stale `absent` is never carried over a read that failed, since
 * `absent` is what drops a report.
 */
async function settleTimeStoreEvidence(pending: PendingSessionIdReport): Promise<SessionIdStoreEvidence> {
  if (!pending.storeCheck) return pending.storeEvidence;
  const [atWindow, now] = await Promise.all([
    pending.storeEvidence,
    boundedEvidence(pending.storeCheck, STORE_EVIDENCE_ANSWERS, STORE_EVIDENCE_WAIT_MS),
  ]);
  if (now !== 'unknown') return now;
  return atWindow === 'present' ? 'present' : 'unknown';
}

/**
 * True for a never-captured session that was never used: no opening prompt, none
 * typed, and the agent's store holds no conversation made since its spawn. An
 * agent that makes its conversation at its first turn has none and so no id until
 * someone types, which no capture path could fix (Sentry DESKTOP-36 on 0.62.0: a
 * Command Terminal Codex, signed in, that no one typed into for five minutes). A
 * session where someone typed and the hook was lost has a conversation on disk
 * and reads `present`, so it still reports. The caller has already sent a death
 * at start to the launch report, which asks the same question of the same facts.
 */
function explainedByUntouchedTerminal(session: ManagedSession, outcomeKind: SessionIdCaptureOutcome['kind'], idStore: SessionIdStoreEvidence): boolean {
  return outcomeKind === 'never'
    && session.openingPrompt === 'none'
    && typeof session.promptObservedAt !== 'number'
    && idStore === 'absent';
}

/**
 * How long a late capture waits for the prompt that started it, or for the
 * first output that carried it. An agent that makes its conversation at the
 * first prompt gives the id in its SessionStart hook, and main reads a batch's
 * ids ahead of its events (`onEventsParsed`), so at the capture the prompt of
 * the same turn is not on the row yet, and may sit in the next batch. An id
 * read from the output and the host's `agentOutput` event come from the same
 * chunk, and either can reach main first.
 */
const LATE_EVIDENCE_SETTLE_MS = 2_000;

/**
 * Resolves once what can still land for a late capture has had its chance: the
 * first prompt of a session started with none, and the first output of a
 * session whose id the output gave.
 */
function lateEvidenceSettled(session: ManagedSession, capturedBy: SessionIdCaptureSource): Promise<void> {
  const promptPending = session.openingPrompt === 'none' && typeof session.promptObservedAt !== 'number';
  const outputPending = capturedBy === 'output' && typeof session.agentOutputAt !== 'number';
  if (!promptPending && !outputPending) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, LATE_EVIDENCE_SETTLE_MS);
    timer.unref?.();
  });
}

/**
 * True for a late capture that is on time once it is counted from the prompt:
 * a session started with no opening prompt, whose first real prompt came no
 * more than the capture window before the id, or with it. Such an agent may
 * have no conversation, and so no id, until someone types (Sentry DESKTOP-4C: a
 * Codex terminal whose first prompt came minutes in was counted late against
 * its spawn). An agent with no prompt event of its own never has one on the
 * row, so it is never on time here.
 */
function capturedOnTime(session: ManagedSession, capturedAt: number): boolean {
  if (session.openingPrompt !== 'none' || typeof session.promptObservedAt !== 'number') return false;
  return capturedAt - session.promptObservedAt <= SESSION_ID_CAPTURE_WINDOW_MS;
}

/** From `startedAt` to the capture, as a bucket, or `none` when there is no start. */
function bucketSince(startedAt: number | null | undefined, capturedAt: number): string {
  return typeof startedAt === 'number' ? secondsBucket(Math.max(0, capturedAt - startedAt)) : 'none';
}

/** From the first prompt to the capture, as a bucket, or `none` when no prompt was seen. */
function afterPromptTag(session: ManagedSession, capturedAt: number): string {
  return bucketSince(session.promptObservedAt, capturedAt);
}

/**
 * True for a late capture that is on time once it is counted from the agent's
 * first visible output (`agentOutputAt`, the first text after the shell's
 * handoff): the id came no more than the capture window after that output, or
 * with it. An agent that prints nothing has no id to give, and no capture path
 * is faster than its first line (Sentry DESKTOP-4W: a Cursor print run that was
 * silent for a minute and gave its id with its first stream line). An agent
 * that drew early and gave its id late, output at 4 s and the id at 64 s, is
 * still late. Output that lands more than the settle after the id is not the
 * output that carried it. `AgentOutputTracker` scans to `AGENT_START_CEILING_MS`
 * (two minutes), past the overlay's ready ceiling, so output a minute in is
 * still noted; an agent silent past two minutes has no `agentOutputAt` and
 * reports.
 */
function capturedOnTimeByOutput(session: ManagedSession, capturedAt: number): boolean {
  const outputAt = session.agentOutputAt;
  if (typeof outputAt !== 'number') return false;
  const afterOutputMs = capturedAt - outputAt;
  return afterOutputMs >= -LATE_EVIDENCE_SETTLE_MS && afterOutputMs <= SESSION_ID_CAPTURE_WINDOW_MS;
}

/** From the agent's first visible output to the capture, as a bucket, or `none` when no output was seen. */
function afterOutputTag(session: ManagedSession, capturedAt: number): string {
  return bucketSince(session.agentOutputAt, capturedAt);
}

/**
 * How long the agent ran before its session ended, for a session that never gave
 * an id: an agent that exited seconds after it started had no conversation to
 * capture, and one still running had one the capture missed (Sentry DESKTOP-36
 * could not tell them apart). Counted to the session's end, so it is an upper
 * bound on the agent's own life: a shell outlives the CLI it ran. The end is the
 * PTY's exit, or the removal when that came first. A removal settles the report
 * and then ends the session, and that exit lands before or after this is read,
 * so a removal never counts an exit later than itself. An agent that exited on
 * its own this soon, with nothing to show for it, goes to the launch report
 * instead (`exitedWithNoConversation`).
 */
function agentRanForTag(session: ManagedSession, outcome: Extract<SessionIdCaptureOutcome, { kind: 'never' }>): string {
  if (typeof session.agentRanAt !== 'number') return 'not_run';
  const exitedAt = typeof session.exitedAt === 'number' ? session.exitedAt : null;
  const endedAt = outcome.settledBy === 'removed' ? Math.min(exitedAt ?? outcome.settledAt, outcome.settledAt) : exitedAt;
  if (endedAt !== null) return secondsBucket(Math.max(0, endedAt - session.agentRanAt));
  return session.status === 'running' ? 'running' : 'unknown';
}

/** How soon after it ran an agent that exits on its own counts as having died at start. */
const AGENT_EXITED_AT_START_MS = 60_000;

/**
 * Whether the PTY ended without a person or Kangentic stopping the agent. A
 * `kill()` that keeps the row (the `cleanup_worktree` action, a user's stop)
 * leaves it `exited` with `intentionalExit` set. The agent-absence sweep kills
 * through `kill()` too, but only a shell whose agent had already exited, and
 * `retireAgentlessSession` is the one writer of `overrideExitCode`, always 0.
 * That retirement is the CLI's own end, seen late, so it still counts.
 */
function endedOnItsOwn(session: ManagedSession): boolean {
  return session.intentionalExit !== true || session.overrideExitCode === 0;
}

/**
 * When the agent ended. A PTY that exited on its own ended with it. A shell the
 * agent-absence sweep retired outlived it, and the sweep judges a launch with no
 * sign it ran only at its 120 s start ceiling: Codex 0.171.0 dead 6 s in under
 * PowerShell was killed 116 s after it ran (task #1182). The shell printed its
 * prompt as the agent ended, so its last output is that moment.
 */
function agentEndedAt(session: ManagedSession, exitedAt: number): number {
  const retiredBySweep = session.intentionalExit === true && session.overrideExitCode === 0;
  const lastOutputAt = session.lastOutputAt;
  if (!retiredBySweep || typeof lastOutputAt !== 'number') return exitedAt;
  return Math.min(lastOutputAt, exitedAt);
}

/**
 * True for a never-captured session whose agent ran, ended on its own under a
 * minute later, took no prompt and left no store: settled at the ceiling with
 * its PTY exited, not by a removal or a deliberate kill (`endedOnItsOwn`), since a
 * person who moved the task away 20 s in did not watch it die. Read only from what
 * is known at the outcome, so the latch check ahead of the wait can ask it too.
 * Such a run had no conversation to capture (Sentry DESKTOP-36: a Codex 0.163.0
 * with its prompt on the command line that exited seconds in, on three days), and
 * calling it a missed id buried it beside the real misses. The store is the
 * caller's to check.
 */
function mayHaveExitedWithNoConversation(
  session: ManagedSession,
  outcome: SessionIdCaptureOutcome,
  sessionStatus: string | null,
): boolean {
  if (outcome.kind !== 'never' || outcome.settledBy !== 'ceiling' || sessionStatus !== 'exited') return false;
  if (!endedOnItsOwn(session)) return false;
  if (typeof session.agentRanAt !== 'number' || typeof session.exitedAt !== 'number') return false;
  if (agentEndedAt(session, session.exitedAt) - session.agentRanAt >= AGENT_EXITED_AT_START_MS) return false;
  return typeof session.promptObservedAt !== 'number';
}

/** `mayHaveExitedWithNoConversation`, with the store read: one that is `present` had a conversation. */
function exitedWithNoConversation(
  session: ManagedSession,
  outcome: SessionIdCaptureOutcome,
  sessionStatus: string | null,
  idStore: SessionIdStoreEvidence | 'unknown',
): boolean {
  return idStore !== 'present' && mayHaveExitedWithNoConversation(session, outcome, sessionStatus);
}

/**
 * Report how a session past the capture window ended, once per agent per run
 * for each kind: never captured, which leaves `--resume` starting a fresh
 * conversation without a word, or captured late, which a report at the window
 * would have counted as never. Two issues, so one cannot hide the other. Fixed
 * words only.
 *
 * A late capture that is on time by its first prompt (`capturedOnTime`) or by
 * the agent's first output (`capturedOnTimeByOutput`) sends nothing, and
 * neither does a session a signed-out CLI explains
 * (`explainedBySignedOutCli`, which for a late id ignores the store). The
 * agent's one report of a kind is spent only when one is sent, so either of
 * those, or a quit during the wait, leaves it for a real one.
 *
 * A session whose agent died at start with no conversation
 * (`exitedWithNoConversation`) goes to the launch report as `agent_exited`,
 * cause `no_conversation`, with the same tags, and spends no capture report. It
 * is the session's one launch report (`launchFailureNoted`), so a CLI that
 * already named its startup failure sends nothing here, and the launch report's
 * own key keeps it to one per agent per run.
 */
export function reportSessionIdCaptureOutcome(
  sessionId: string,
  outcome: SessionIdCaptureOutcome,
  sessionStatus: string | null,
): void {
  const pending = pendingSessionIdReports.get(sessionId);
  pendingSessionIdReports.delete(sessionId);
  if (!pending || isShuttingDown()) return;
  const outcomeReport = SESSION_ID_OUTCOME_REPORTS[outcome.kind];
  const session = pending.session;
  // Asked here too, so an agent that already sent this kind waits on nothing,
  // unless the session may still be a death at start, which is not that kind.
  if (outcomeReport.latch.has(pending.agent) && !mayHaveExitedWithNoConversation(session, outcome, sessionStatus)) return;
  const lateEvidence = outcome.kind === 'late' ? lateEvidenceSettled(session, outcome.capturedBy) : Promise.resolve();
  const storeEvidence = outcome.kind === 'never' ? settleTimeStoreEvidence(pending) : pending.storeEvidence;
  void Promise.all([storeEvidence, pending.loginEvidence, pending.nodeEvidence, lateEvidence]).then(([idStore, login, nodeOnPath]) => {
    if (isShuttingDown()) return;
    if (outcome.kind === 'late' && capturedOnTime(session, outcome.capturedAt)) return;
    if (outcome.kind === 'late' && capturedOnTimeByOutput(session, outcome.capturedAt)) {
      // The local log still says so: the agent printed nothing until it gave its id, and no event will.
      const capturedAfterSeconds = Math.round(outcome.capturedAfterMs / 1000);
      console.warn(`[session-manager] ${pending.agent} gave its session ID with its first output for session ${sessionId.slice(0, 8)}, ${capturedAfterSeconds}s after spawn: on time by that output, so nothing is reported.`);
      return;
    }
    if (explainedBySignedOutCli(session, outcome.kind, login, idStore)) {
      // The local log still says so: the user's CLI needs a sign-in, and no event will.
      console.warn(`[session-manager] ${pending.agent} gave no session ID for session ${sessionId.slice(0, 8)}: its CLI holds no login, so nothing is reported.`);
      return;
    }
    const outcomeTags: Record<string, string> = outcome.kind === 'late'
      ? {
        captured_after_s: secondsBucket(outcome.capturedAfterMs),
        after_prompt_s: afterPromptTag(session, outcome.capturedAt),
        after_output_s: afterOutputTag(session, outcome.capturedAt),
        captured_by: captureSourceTag(outcome.capturedBy),
      }
      : { settled_by: outcome.settledBy, session_status: sessionStatus ?? 'removed', agent_ran_for_s: agentRanForTag(session, outcome) };
    const captureTags: Record<string, string> = {
      agent: pending.agent,
      ...pending.tags,
      // Read now, not at the window: a prompt typed after it is the case that
      // tells a conversation that never existed from one the capture missed.
      // And after the wait above, so the prompt of the id's own turn counts.
      prompt_seen: observedTag(session.promptObservedAt),
      ...outcomeTags,
      fs_scan: outcome.filesystemScan,
      id_store: idStore,
      login,
      node_on_path: nodeOnPath,
    };
    if (exitedWithNoConversation(session, outcome, sessionStatus, idStore)) {
      reportExitedWithNoConversation(session, captureTags);
      return;
    }
    if (outcome.kind === 'never' && session.launchFailureNoted === true && idStore !== 'present') {
      // Its launch report already said why it never started (a failure its CLI
      // named, or a shell that never ran it), so there was no id to capture. The
      // sweep can end such a shell long after its agent died: Codex 0.171.0 dead
      // 6 s in under PowerShell was retired at the 120 s start ceiling.
      // breadcrumb-ok: a session id and an agent from a fixed list.
      console.warn(`[AGENT-LAUNCH] session=${sessionId.slice(0, 8)} stage=agent_exited cause=no_conversation agent=${pending.agent} already_reported=yes`);
      return;
    }
    if (explainedByUntouchedTerminal(session, outcome.kind, idStore)) {
      // The local log still says so: nobody used it, and no event will.
      console.warn(`[session-manager] ${pending.agent} gave no session ID for session ${sessionId.slice(0, 8)}: no prompt reached it and it wrote no session, so nothing is reported.`);
      return;
    }
    if (outcomeReport.latch.has(pending.agent)) return;
    outcomeReport.latch.add(pending.agent);
    const error = new Error(`${outcomeReport.message} (${pending.agent})`);
    error.name = outcomeReport.errorName;
    reportHandledError(
      error,
      { source: 'agent_session_id', ...captureTags },
      {},
      [outcomeReport.fingerprintHead, pending.agent],
    );
  });
}

/**
 * Send a death at start as the session's one launch report. A session that
 * already made one (a CLI that named its startup failure) sends nothing more.
 * `claimLaunchReport` keys on the agent and attempt, so both go in the tags.
 */
function reportExitedWithNoConversation(session: ManagedSession, captureTags: Record<string, string>): void {
  const sessionLabel = session.id.slice(0, 8);
  if (session.launchFailureNoted === true) {
    // breadcrumb-ok: a session id, a fixed stage and an agent from a fixed list.
    console.warn(`[AGENT-LAUNCH] session=${sessionLabel} stage=agent_exited cause=no_conversation agent=${captureTags.agent} already_reported=yes`);
    return;
  }
  session.launchFailureNoted = true;
  reportLaunchFailure({
    stage: 'agent_exited',
    cause: 'no_conversation',
    tags: { attempt: attemptOf(session.startPath), ...captureTags },
    sessionLabel,
  });
}

/** Forget what this run reported. Tests only. */
export function resetLaunchReports(): void {
  reported.clear();
  neverCapturedSessionIdAgents.clear();
  lateSessionIdAgents.clear();
  pendingSessionIdReports.clear();
}
