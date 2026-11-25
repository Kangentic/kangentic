/**
 * The shared parts of every handled-error report main sends: the path-free copy,
 * the dedupe mark, the one predicate that says which failures are not defects, and
 * the latched reporter each dispatcher chokepoint uses.
 *
 * An error's message is never sent. In this codebase it holds paths, branch names,
 * task and workflow titles, org and repo names and search queries, so every report
 * goes out as `Handled <source> failure: <ErrorName>` with the original frames.
 * Grouping is Sentry's default (source-mapped in-app frames), except for an
 * environment failure (an errno or a SQLite code), which groups on
 * `['handled-env', name, code]` so one cause on many call paths is one issue.
 *
 * This module imports only `reportHandledError` from `error-reporting.ts`, so a unit
 * test that mocks that one export can load any reporter built on it. The pty host,
 * retrieval, dictation and spawn workers never import it: they relay a fixed code to
 * main, which reports (`.claude/rules/error-reporting.md`).
 */

import { reportHandledError, type ErrorReportContexts } from './error-reporting';
import { isShuttingDown } from '../shutdown-state';
import { isAbortError } from '../../shared/abort-utils';
import { isUserConfigurationError } from '../../shared/user-configuration-error';
import { errorCodeOf, errorNameOf, framesOf, isRuntimeDefect, pathFreeCopy } from '../../shared/handled-error-copy';
import type { PasteFailureFacts, PasteOutputBucket, PasteSubmitError } from '../pty/paste-engine';

export { errorCodeOf, errorNameOf, pathFreeCopy } from '../../shared/handled-error-copy';

/**
 * True for a failure that is ours or the machine's: a runtime defect (`TypeError`,
 * `RangeError`, `ReferenceError`) or one that carries an errno or a SQLite code.
 *
 * For a catch whose common failure is another program's own outcome carried as a plain
 * `Error`: an agent CLI that exited, timed out, was not signed in or hit its rate limit, an
 * adapter's reader that found nothing it could use. A reporter cannot tell that from a defect
 * by class, and filing it would open an issue for a user's sign-in. Such a site reports only
 * what passes this.
 */
export function isDefectOrEnvironmentFailure(error: unknown): boolean {
  return isRuntimeDefect(error) || errorCodeOf(error) !== undefined;
}

/** The most distinct keys one chokepoint reports in a run. */
export const DEFAULT_CHOKEPOINT_KEY_CAP = 25;

/**
 * Error classes thrown by design: refusals meant for the caller, the user's own
 * environment, and failures a caller already handles. Matched by `name`, which each
 * class sets explicitly (the main bundle is minified, so a class that leaves `name`
 * unset reads as `Error`). `handled-report.test.ts` constructs each one and pins it.
 * Matching by name keeps this module's import graph free of every subsystem it names.
 */
export const EXPECTED_FAILURE_NAMES: ReadonlySet<string> = new Set([
  // Refusals
  'WorkflowRequestError',
  'StaleWorkflowRevisionError',
  'CommandTerminalStartError',
  'AgentCwdMissingError',
  'AgentCommandTooLongError',
  // Automation outcomes the adapter classified
  'AutomationRetryableError',
  'AutomationPermanentError',
  'AutomationTimeoutError',
  // The tracker and PR clients
  'GhUnavailableError',
  'GhTransientError',
  'AzUnavailableError',
  'AzTransientError',
  'AsanaError',
  'LinearError',
  'TrelloError',
  // Atlassian, kangentic.com or the network did not answer a Jira sign-in renewal
  'JiraRefreshUnavailableError',
  'PRResolverUnavailableError',
  'PRResolverTransientError',
  // The SSH link and remote git
  'HostUnreachableError',
  // A request the host never answered: its wait ran out behind a dropped link, or the link stopped
  'HostRequestUnansweredError',
  'UnsupportedOnHostError',
  'RemoteGitUnavailableError',
  'HostTransferError',
  // A mobile relay dial that never opened: the network or the relay, which the client cannot tell apart
  'RelayDialError',
  // Workers that are down
  'RetrievalUnavailableError',
  'HostUnavailableError',
  'PtyHostTimeoutError',
  'PtyHostExitedError',
  'ModelLoadError',
  'ModelDownloadError',
  // A model file the host or the network did not serve: a timeout, or a 408, 429 or 5xx answer
  'ModelDownloadUnavailableError',
  // The Browser pane driver
  'GuestBusyError',
  'KeyboardFocusNotInGuestError',
  'NavigationRefusedByPageError',
  // An abort that is not a DOMException (Node's `AbortError` from `fs`, `fetch`)
  'AbortError',
]);

/** Network and stream errnos: the user's connection or a peer that went away. */
export const NETWORK_ERRNOS: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'ENETRESET',
  'ESHUTDOWN',
  'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

const reportedErrors = new WeakSet<object>();

/**
 * Errors whose report was handed to Sentry: sent now, or a latched repeat of a
 * key that was sent earlier this run. A subset of `reportedErrors`, which also
 * holds errors marked while error reporting was off or a send was skipped. A
 * failure toast says the issue was reported only for these (`ipc-handler-report.ts`).
 */
const sentErrors = new WeakSet<object>();

/** True when `error`, or the error it wraps (`cause`, one level), is in `marks`. */
function inSetOrCause(marks: WeakSet<object>, error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if (marks.has(error)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== null && typeof cause === 'object' && marks.has(cause);
}

function markSent(error: unknown): void {
  if (error !== null && typeof error === 'object') sentErrors.add(error);
}

/**
 * True when `error`, or the error it wraps (`cause`, one level), had its report
 * handed to Sentry in this run, by this send or by an earlier send of the same
 * failure key.
 */
export function wasSentToErrorReporting(error: unknown): boolean {
  return inSetOrCause(sentErrors, error);
}

/**
 * Mark `error` (the ORIGINAL, never the copy a reporter sends) as reported, so a
 * chokepoint further up the stack skips it. Every reporter calls this. Both
 * `reportedErrors` and `sentErrors` hold originals, because a rethrown original
 * is what a later chokepoint sees, never the copy that went out.
 */
export function markReported(error: unknown): void {
  if (error !== null && typeof error === 'object') reportedErrors.add(error);
}

/**
 * True when `error`, or the error it wraps (`cause`, one level), was marked. A
 * wrapper (`wrapWorktreeSetupError`) is rethrown past a reporter that marked the
 * cause it was handed, so the wrapper alone would look unreported.
 */
export function isReported(error: unknown): boolean {
  return inSetOrCause(reportedErrors, error);
}

/** The syscall of a Node system error (`open`, `rename`), else undefined. */
export function syscallOf(error: unknown): string | undefined {
  const syscall = (error as { syscall?: unknown } | null | undefined)?.syscall;
  return typeof syscall === 'string' && /^[a-z_]{1,32}$/.test(syscall) ? syscall : undefined;
}

/** A short lowercase word, so nothing but a fixed cause can ride the tag. */
const GIT_CAUSE = /^[a-z_]{1,40}$/;

/**
 * What a failed git command refused on (`GitCommandError.gitCause`), on the
 * error or one level down its `cause`, where a wrapper such as
 * `wrapWorktreeSetupError` leaves it. Read by shape, so this module imports no
 * git code. git's own text never leaves: Sentry DESKTOP-4A was a `git:diffFiles`
 * failure that could not say why.
 */
export function gitCauseOf(error: unknown): string | undefined {
  const wrapped = (error as { cause?: unknown } | null | undefined)?.cause;
  for (const candidate of [error, wrapped]) {
    const gitCause = (candidate as { gitCause?: unknown } | null | undefined)?.gitCause;
    if (typeof gitCause === 'string' && GIT_CAUSE.test(gitCause)) return gitCause;
  }
  return undefined;
}

/**
 * An Azure DevOps server code, or `none`. The shape of `AZ_SERVER_CODE_PATTERN`
 * in `boards/adapters/azure-devops/client.ts`, anchored and without its global
 * flag, kept here so this module imports no board code.
 */
const AZ_SERVER_CODE = /^(?:(?:TF|VS)\d{5,6}|none)$/;

/**
 * The Azure DevOps server code that refused an az import call (`azServerCode`,
 * set by the import classifier in `azure-devops/client.ts`), or `none` when az's
 * answer carried no code, on the error or one level down its `cause`. Only the
 * code leaves: az's stderr quotes the user's query and project. Sentry DESKTOP-47
 * came back with a refusal it could not name.
 */
export function azServerCodeOf(error: unknown): string | undefined {
  const wrapped = (error as { cause?: unknown } | null | undefined)?.cause;
  for (const candidate of [error, wrapped]) {
    const azServerCode = (candidate as { azServerCode?: unknown } | null | undefined)?.azServerCode;
    if (typeof azServerCode === 'string' && AZ_SERVER_CODE.test(azServerCode)) return azServerCode;
  }
  return undefined;
}

/** `error`, then the error it wraps (`cause`, one level), where a wrapper leaves the detail. */
function errorAndCause(error: unknown): unknown[] {
  const wrapped = (error as { cause?: unknown } | null | undefined)?.cause;
  return wrapped === undefined || wrapped === null ? [error] : [error, wrapped];
}

/** A signal name (`SIGKILL`), so nothing else can ride the tag. */
const SIGNAL_NAME = /^SIG[A-Z0-9]{2,10}$/;

/**
 * How a child process ended, read by shape from the error or the one it wraps:
 * `spawnWithAbort`'s `exitCode`, `signal` and `timedOut`
 * (`src/main/git/spawn-with-abort.ts`), and Node's `execFile` rejection, whose
 * `code` is the exit code as a number. Node always sets `killed` beside it, which
 * is what tells that `code` from another class's numeric one (a `DOMException`'s).
 * A failed git, gh, az, CLI or script call throws a plain `Error` whose text is
 * withheld, so without these a report could not tell an exit from a kill from a
 * timeout (Sentry DESKTOP-3D). Only an integer, a signal name and a boolean leave.
 */
export function processExitTagsOf(error: unknown): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const candidate of errorAndCause(error)) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const fields = candidate as { exitCode?: unknown; code?: unknown; signal?: unknown; timedOut?: unknown };
    const nodeExitCode = 'killed' in candidate ? fields.code : undefined;
    const exitCode = typeof fields.exitCode === 'number' ? fields.exitCode : nodeExitCode;
    if (tags.exit_code === undefined && typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) {
      tags.exit_code = String(exitCode);
    }
    if (tags.exit_signal === undefined && typeof fields.signal === 'string' && SIGNAL_NAME.test(fields.signal)) {
      tags.exit_signal = fields.signal;
    }
    if (tags.timed_out === undefined && typeof fields.timedOut === 'boolean') {
      tags.timed_out = String(fields.timedOut);
    }
  }
  return tags;
}

/**
 * What a wrapper wraps: the class name and the errno of its `cause`, one level.
 * A wrapper reads `Error` and carries no code of its own, so a report of one said
 * nothing about the `SqliteError` or `ENOSPC` underneath.
 */
export function causeTagsOf(error: unknown): Record<string, string> {
  const wrapped = (error as { cause?: unknown } | null | undefined)?.cause;
  if (wrapped === undefined || wrapped === null) return {};
  const tags: Record<string, string> = { cause_name: errorNameOf(wrapped) };
  const causeCode = errorCodeOf(wrapped);
  if (causeCode) tags.cause_errno = causeCode;
  return tags;
}

/**
 * The codes and facts a `PasteSubmitError` carries (`pty/paste-engine.ts`). The
 * import is type-only, so this module loads no pty code, and each record must
 * name every member of the engine's union: a code, reason or bucket the engine
 * adds fails the typecheck here instead of dropping its tag.
 */
const PASTE_CODE_MEMBERS: Record<PasteSubmitError['code'], true> = {
  aborted: true,
  timeout: true,
  'no-submission-evidence': true,
  held: true,
};
const PASTE_REASON_MEMBERS: Record<PasteFailureFacts['reason'], true> = { 'paste-mode-off': true, 'no-signal': true };
const PASTE_OUTPUT_BUCKET_MEMBERS: Record<PasteOutputBucket, true> = { '0': true, '1-9': true, '10-49': true, '50+': true };
const PASTE_CODES: ReadonlySet<string> = new Set(Object.keys(PASTE_CODE_MEMBERS));
const PASTE_REASONS: ReadonlySet<string> = new Set(Object.keys(PASTE_REASON_MEMBERS));
const PASTE_OUTPUT_BUCKETS: ReadonlySet<string> = new Set(Object.keys(PASTE_OUTPUT_BUCKET_MEMBERS));
const PASTE_FLAG_TAGS = [
  ['firstWindowTakesData', 'paste_first_window_data'],
  ['retried', 'paste_retried'],
  ['pasteModeOff', 'paste_mode_off'],
  ['settleOutput', 'paste_settle_output'],
] as const satisfies ReadonlyArray<readonly [keyof PasteFailureFacts, string]>;
const PASTE_BUCKET_TAGS = [
  ['firstWindowBytes', 'paste_first_bytes'],
  ['retryWindowBytes', 'paste_retry_bytes'],
] as const satisfies ReadonlyArray<readonly [keyof PasteFailureFacts, string]>;

/**
 * What a paste that failed saw (`PasteSubmitError.code` and `.facts`), as tags,
 * on the error or one level down its `cause`. Read by shape, and only values in
 * the fixed sets above leave: byte counts go as buckets, never text. Sentry
 * DESKTOP-52 was a paste with no sign of a submit that could not say which case
 * it was.
 */
export function pasteFactsOf(error: unknown): Record<string, string> {
  const wrapped = (error as { cause?: unknown } | null | undefined)?.cause;
  for (const candidate of [error, wrapped]) {
    if (!(candidate instanceof Error) || candidate.name !== 'PasteSubmitError') continue;
    const code = (candidate as { code?: unknown }).code;
    if (typeof code !== 'string' || !PASTE_CODES.has(code)) continue;
    const tags: Record<string, string> = { paste_code: code };
    const facts = (candidate as { facts?: unknown }).facts;
    if (facts === null || typeof facts !== 'object') return tags;
    const record = facts as Record<string, unknown>;
    if (typeof record.reason === 'string' && PASTE_REASONS.has(record.reason)) tags.paste_reason = record.reason;
    for (const [field, tag] of PASTE_FLAG_TAGS) {
      if (typeof record[field] === 'boolean') tags[tag] = String(record[field]);
    }
    for (const [field, tag] of PASTE_BUCKET_TAGS) {
      const bucket = record[field];
      if (typeof bucket === 'string' && PASTE_OUTPUT_BUCKETS.has(bucket)) tags[tag] = bucket;
    }
    return tags;
  }
  return {};
}

/**
 * True for the user's connection, not our code: a network errno, a stream torn down
 * by its peer, or `fetch failed` (Node's `TypeError`) whose cause is one of those.
 */
export function isNetworkFailure(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code && (NETWORK_ERRNOS.has(code) || code.startsWith('ERR_STREAM_'))) return true;
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as { cause?: unknown }).cause;
    return cause === undefined || isNetworkFailure(cause);
  }
  return false;
}

/**
 * True when `error` is not a defect worth an issue: the app is quitting, the work
 * was aborted, the user's configuration or environment refused it, a refusal meant
 * for the caller, or the network. Every chokepoint asks this before it reports.
 */
export function isExpectedFailure(error: unknown): boolean {
  if (isShuttingDown()) return true;
  if (isExpectedOwnClass(error)) return true;
  // A wrapper is judged by what it wraps, one level: `wrapWorktreeSetupError`
  // wraps a dirty tree (`GitUserStateError`) in a plain Error with `cause`.
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  return cause !== undefined && cause !== error && isExpectedOwnClass(cause);
}

function isExpectedOwnClass(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (isUserConfigurationError(error)) return true;
  if (error instanceof Error && EXPECTED_FAILURE_NAMES.has(error.name)) return true;
  return isNetworkFailure(error);
}

/**
 * True for an environment failure: an errno (`ENOSPC`, `EACCES`), libuv's Windows
 * `UNKNOWN`, or a SQLite code. It groups on `['handled-env', name, code]`, never
 * on the call path.
 */
export function isEnvironmentFailure(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code !== undefined && (/^E[A-Z0-9]{2,}$/.test(code) || code === 'UNKNOWN' || code.startsWith('SQLITE_'));
}

/** The fingerprint for `error`: environment failures group by name and code, the rest by stack. */
export function fingerprintOf(error: unknown): string[] | undefined {
  if (!isEnvironmentFailure(error)) return undefined;
  return ['handled-env', errorNameOf(error), errorCodeOf(error) ?? 'none'];
}

/** The first frame of the error's stack, for a latch key only (never sent). */
export function firstFrameOf(error: unknown): string {
  const frames = framesOf(error instanceof Error ? error.stack : undefined);
  const firstLine = frames.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? '';
}

/**
 * Send one handled failure from `source`, path-free, with the tags every report
 * carries (`source`, `error_name`, and `errno`, `syscall`, `git_cause`,
 * `az_server_code` and the `paste_*` facts when the error has them) plus the
 * caller's own short enums.
 * A failed child process adds `exit_code`, `exit_signal` and `timed_out`, and a
 * wrapper adds `cause_name` and `cause_errno`; a caller's own tag of the same
 * name wins, and none of them is in a latch key or a fingerprint.
 * Marks the original reported, and sent when Sentry took the report. Returns
 * whether it did.
 * Does not latch and does not filter: a caller that wants either uses
 * `createChokepointReporter`.
 */
export function sendHandledFailure(
  source: string,
  error: unknown,
  tags: Record<string, string> = {},
  contexts: ErrorReportContexts = {},
  fingerprint: string[] | undefined = fingerprintOf(error),
): boolean {
  const allTags: Record<string, string> = {
    ...processExitTagsOf(error),
    ...causeTagsOf(error),
    ...tags,
    source,
    error_name: errorNameOf(error),
  };
  const code = errorCodeOf(error);
  if (code) allTags.errno = code;
  const syscall = syscallOf(error);
  if (syscall) allTags.syscall = syscall;
  const gitCause = gitCauseOf(error);
  if (gitCause) allTags.git_cause = gitCause;
  const azServerCode = azServerCodeOf(error);
  if (azServerCode) allTags.az_server_code = azServerCode;
  Object.assign(allTags, pasteFactsOf(error));
  markReported(error);
  const sent = reportHandledError(pathFreeCopy(source, error), allTags, contexts, fingerprint);
  if (sent) markSent(error);
  return sent;
}

/** How long a dispatched call ran before it failed. */
export type RanForBucket = '<1s' | '1-5s' | '5-30s' | '30s+';

/**
 * Bucket the time a dispatched call (an IPC handler, an MCP tool) ran before it
 * failed, for the `ran_for` tag. It tells a throw on entry from a call that hung
 * until something timed it out, which the error's name alone never does.
 */
export function ranForBucket(elapsedMs: number): RanForBucket {
  if (elapsedMs < 1_000) return '<1s';
  if (elapsedMs < 5_000) return '1-5s';
  if (elapsedMs < 30_000) return '5-30s';
  return '30s+';
}

export interface ChokepointReportOptions {
  /** Short enums only (`channel`, `tool`, `verb`, `stage`). Never a title, path or message. */
  tags?: Record<string, string>;
  /**
   * Short enums that describe this one occurrence and are left out of the latch
   * key: a timing bucket (`ran_for`), which path asked (`caller`). In `tags`,
   * one defect that fails fast once and slow once would be two keys and two
   * reports. The first occurrence's values are the ones sent.
   */
  detailTags?: Record<string, string>;
  /**
   * Tags sent with the report but left out of the latch key: an id that joins
   * this event to another system's record (`relay_dial_id`). A per-occurrence
   * value in `tags` would make every occurrence a new key, so one defect would
   * report again on each one and spend the cap.
   */
  correlationTags?: Record<string, string>;
  contexts?: ErrorReportContexts;
  /**
   * Only for a source whose frames cannot split an issue (a preload callback,
   * whose error crossed the context bridge and kept only the preload's own
   * frames). Defaults to the environment fingerprint, or Sentry's stack
   * grouping for a code defect. Never an IPC channel.
   */
  fingerprint?: string[];
}

export interface ChokepointReporter {
  /** Report `error` once per key per run. Returns true when it sent a report. */
  report(error: unknown, options?: ChokepointReportOptions): boolean;
  /** Test-only: forget the latch. */
  reset(): void;
}

export interface ChokepointReporterOptions {
  /** The most distinct keys reported in a run. */
  cap?: number;
  /**
   * Which errors this chokepoint reports at all, after `isExpectedFailure` and
   * `isReported` have skipped theirs. Defaults to every error.
   */
  shouldReport?: (error: unknown) => boolean;
}

/**
 * A latched reporter for one dispatcher chokepoint (`source`). It skips expected
 * failures and errors already reported, reports each key once per run, and stops
 * after `cap` keys, so a repeating throw cannot flood the project.
 */
export function createChokepointReporter(source: string, options: ChokepointReporterOptions = {}): ChokepointReporter {
  const cap = options.cap ?? DEFAULT_CHOKEPOINT_KEY_CAP;
  const reportedKeys = new Set<string>();
  // The keys whose first report Sentry took, so a latched repeat of one can
  // still say it was reported.
  const sentKeys = new Set<string>();
  return {
    report(error, reportOptions = {}) {
      try {
        if (isExpectedFailure(error) || isReported(error)) return false;
        if (options.shouldReport && !options.shouldReport(error)) return false;
        const tags = reportOptions.tags ?? {};
        const pasteFacts = pasteFactsOf(error);
        const key = [
          Object.entries(tags).map(([tagKey, value]) => `${tagKey}=${value}`).join(','),
          errorNameOf(error),
          errorCodeOf(error) ?? '',
          // Every git failure throws from one line, so the cause is what tells two apart.
          gitCauseOf(error) ?? '',
          // Every az import failure throws from one line too.
          azServerCodeOf(error) ?? '',
          // Every paste failure is one error class; its code and reason tell the cases apart.
          `${pasteFacts.paste_code ?? ''},${pasteFacts.paste_reason ?? ''}`,
          firstFrameOf(error),
        ].join('|');
        if (reportedKeys.has(key)) {
          markReported(error);
          if (sentKeys.has(key)) markSent(error);
          return false;
        }
        if (reportedKeys.size >= cap) return false;
        reportedKeys.add(key);
        const sent = sendHandledFailure(
          source,
          error,
          { ...reportOptions.correlationTags, ...reportOptions.detailTags, ...tags },
          reportOptions.contexts,
          reportOptions.fingerprint ?? fingerprintOf(error),
        );
        if (sent) sentKeys.add(key);
        return true;
      } catch {
        // report-ok: this is the reporter; a failed send must never break the path that called it.
        return false;
      }
    },
    reset() {
      reportedKeys.clear();
      sentKeys.clear();
    },
  };
}
