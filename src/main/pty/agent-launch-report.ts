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
import { trackEvent } from '../analytics/analytics';
import { reportHandledError } from '../analytics/error-reporting';
import { isReported, markReported, pathFreeCopy } from '../analytics/handled-report';
import { isShuttingDown } from '../shutdown-state';
import { isAbortError } from '../../shared/abort-utils';
import { AgentUserSetupError, isUserConfigurationError, type UserSetupFailure } from '../../shared/user-configuration-error';
import { shellProgramName } from '../../shared/shell-quote';
import type { LaunchStartPath } from '../../shared/types';
import { cliIdentitySinceDetection, type CliIdentitySinceDetection } from '../agent/shared/cli-identity';
import type { AgentProcessPresence } from './host/agent-process-presence';
import { classifyLaunchOutput, type LaunchOutputClass } from './launch-output-class';
import { AGENT_READY_CEILING_MS } from './lifecycle/agent-output-tracker';
import { parseWslShellSpec } from './process-tag/task-process-tag';
import { AgentStartRefusedError } from './spawn/agent-start-refused';
import type { ManagedSession } from './session-registry';

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
  /** The CLI ran and named its own startup failure. */
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

/** Starts with a digit, one token, no slash, backslash or space, so a path or a banner fails it. */
const CLI_VERSION = /^v?\d[0-9A-Za-z._+-]{0,47}$/;

/**
 * The CLI's version as a tag, or `unknown`. Detection keeps what the CLI printed,
 * and some parsers only trim it, so a banner or a path can sit in that string.
 */
export function launchVersionTag(version: string | null | undefined): string {
  const firstToken = version?.trim().split(/\s+/)[0] ?? '';
  return CLI_VERSION.test(firstToken) ? firstToken : 'unknown';
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
    agent_cli_version: launchVersionTag(session.agentCliVersion),
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
    agent_cli_version: launchVersionTag(input.agentCliVersion),
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
  return tags;
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
 * The event carries the error's name, errno and frames under a fixed message,
 * never the error's text (`fixedMessageCopyOf`).
 *
 * Called from catch blocks that go on to rethrow or notify, so it never throws:
 * a report must not replace the failure it reports.
 */
export function reportPreflightFailure(failure: PreflightFailure): void {
  try {
    const { cause, error, agent, agentCliVersion, startPath, alreadyCounted } = failure;
    if (isAbortError(error)) return;
    if (isReported(error)) return;
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
  const sendOnceRead = (outputClass: LaunchOutputClass): LaunchOutputClass | Promise<LaunchOutputClass> => {
    if (!agentProcess) return send(outputClass);
    return agentProcess.then(
      (presence) => send(outputClass, { agent_process: presence }),
      () => send(outputClass, { agent_process: 'unknown' }),
    );
  };
  if (!readOutput) {
    session.launchOutputRead = Promise.resolve(sendOnceRead('not_read'));
    return;
  }
  session.launchOutputRead = readOutput().then(
    (rawScrollback) => sendOnceRead(classifySessionOutput(session, rawScrollback)),
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

/** Forget what this run reported. Tests only. */
export function resetLaunchReports(): void {
  reported.clear();
}
