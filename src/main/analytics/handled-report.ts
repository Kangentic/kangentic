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
import { redactPaths } from '../../shared/sentry-breadcrumbs';

/** A class name: `TypeError`, `HttpError`. A slug or a sentence cannot pass. */
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
/** An errno or code constant: `ENOENT`, `SQLITE_BUSY`, `ERR_STREAM_DESTROYED`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The longest built-in error message kept in `contexts`. */
export const MAX_DIAGNOSTIC_MESSAGE_CHARACTERS = 200;
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
  'PRResolverUnavailableError',
  'PRResolverTransientError',
  // The SSH link and remote git
  'HostUnreachableError',
  'UnsupportedOnHostError',
  'RemoteGitUnavailableError',
  'HostTransferError',
  // Workers that are down
  'RetrievalUnavailableError',
  'HostUnavailableError',
  'PtyHostTimeoutError',
  'PtyHostExitedError',
  'ModelLoadError',
  'ModelDownloadError',
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
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

/** Built-in classes whose message is a fixed sentence the runtime wrote, never user data. */
const DIAGNOSTIC_MESSAGE_NAMES: ReadonlySet<string> = new Set(['TypeError', 'RangeError', 'ReferenceError']);

const reportedErrors = new WeakSet<object>();

/**
 * Mark `error` (the ORIGINAL, never the copy a reporter sends) as reported, so a
 * chokepoint further up the stack skips it. Every reporter calls this, because the
 * copies they send mean a set of sent errors could never match a rethrown original.
 */
export function markReported(error: unknown): void {
  if (error !== null && typeof error === 'object') reportedErrors.add(error);
}

export function isReported(error: unknown): boolean {
  return error !== null && typeof error === 'object' && reportedErrors.has(error);
}

/** The error's `name` when it is a class name, else `Error`. */
export function errorNameOf(error: unknown): string {
  if (!(error instanceof Error)) return 'NonError';
  return ERROR_NAME.test(error.name) ? error.name : 'Error';
}

/** The error's `code` when it is a constant (`ENOENT`, `SQLITE_BUSY`), else undefined. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/** The syscall of a Node system error (`open`, `rename`), else undefined. */
export function syscallOf(error: unknown): string | undefined {
  const syscall = (error as { syscall?: unknown } | null | undefined)?.syscall;
  return typeof syscall === 'string' && /^[a-z_]{1,32}$/.test(syscall) ? syscall : undefined;
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
  if (isAbortError(error)) return true;
  if (isUserConfigurationError(error)) return true;
  if (error instanceof Error && EXPECTED_FAILURE_NAMES.has(error.name)) return true;
  return isNetworkFailure(error);
}

/**
 * True for an environment failure: an errno (`ENOSPC`, `EACCES`) or a SQLite code.
 * It groups on `['handled-env', name, code]`, never on the call path.
 */
export function isEnvironmentFailure(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code !== undefined && (/^E[A-Z0-9]{2,}$/.test(code) || code.startsWith('SQLITE_'));
}

/**
 * The interim IPC allowlist: classes whose throw is a defect whatever the message,
 * because the runtime raised them. Plain `Error` is left out until the refusals it
 * still carries are typed (`Refusal`).
 */
export function isAllowlistedDefect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (DIAGNOSTIC_MESSAGE_NAMES.has(error.name)) return true;
  const code = errorCodeOf(error);
  if (error.name === 'SqliteError') return code !== undefined && code.startsWith('SQLITE_');
  return code !== undefined && /^E[A-Z0-9]{2,}$/.test(code) && !isNetworkFailure(error);
}

/** The original stack's frames, from the first `    at ` line, or '' when it has none. */
function framesOf(stack: string | undefined): string {
  if (typeof stack !== 'string') return '';
  const firstFrame = stack.search(/\n\s+at /);
  return firstFrame === -1 ? '' : stack.slice(firstFrame);
}

/**
 * A copy of `error` that carries no user content: `Handled <source> failure: <Name>`,
 * the same `name`, and the original frames. The frames are cut at the first `at`
 * line, so a multi-line message (a path on its second line) never rides along in the
 * stack's header.
 */
export function pathFreeCopy(source: string, error: unknown): Error {
  const name = errorNameOf(error);
  const copy = new Error(`Handled ${source} failure: ${name}`);
  copy.name = name;
  const frames = framesOf(error instanceof Error ? error.stack : undefined);
  copy.stack = `${name}: ${copy.message}${frames || framesOf(copy.stack)}`;
  return copy;
}

/**
 * The runtime's own message for a `TypeError`, `RangeError` or `ReferenceError`,
 * paths removed and cut to 200 characters, as a context. Never a `SyntaxError`'s:
 * `JSON.parse` quotes its input.
 */
export function diagnosticContextOf(error: unknown): ErrorReportContexts {
  if (!(error instanceof Error) || !DIAGNOSTIC_MESSAGE_NAMES.has(error.name)) return {};
  return { error_detail: { message: redactPaths(error.message).slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARACTERS) } };
}

/** The fingerprint for `error`: environment failures group by name and code, the rest by stack. */
export function fingerprintOf(error: unknown): string[] | undefined {
  if (!isEnvironmentFailure(error)) return undefined;
  return ['handled-env', errorNameOf(error), errorCodeOf(error) ?? 'none'];
}

/** The first frame of the error's stack, for a latch key only (never sent). */
function firstFrameOf(error: unknown): string {
  const frames = framesOf(error instanceof Error ? error.stack : undefined);
  const firstLine = frames.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? '';
}

/**
 * Send one handled failure from `source`, path-free, with the tags every report
 * carries (`source`, `error_name`, `errno`, `syscall`) plus the caller's own short
 * enums. Marks the original reported. Does not latch and does not filter: a caller
 * that wants either uses `createChokepointReporter`.
 */
export function sendHandledFailure(
  source: string,
  error: unknown,
  tags: Record<string, string> = {},
  contexts: ErrorReportContexts = {},
  fingerprint: string[] | undefined = fingerprintOf(error),
): void {
  const allTags: Record<string, string> = { ...tags, source, error_name: errorNameOf(error) };
  const code = errorCodeOf(error);
  if (code) allTags.errno = code;
  const syscall = syscallOf(error);
  if (syscall) allTags.syscall = syscall;
  markReported(error);
  reportHandledError(pathFreeCopy(source, error), allTags, { ...diagnosticContextOf(error), ...contexts }, fingerprint);
}

export interface ChokepointReportOptions {
  /** Short enums only (`channel`, `tool`, `verb`, `stage`). Never a title, path or message. */
  tags?: Record<string, string>;
  contexts?: ErrorReportContexts;
  /** Extra latch key parts, never sent. Defaults to the tags. */
  latchKey?: string;
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
  return {
    report(error, reportOptions = {}) {
      try {
        if (isExpectedFailure(error) || isReported(error)) return false;
        if (options.shouldReport && !options.shouldReport(error)) return false;
        const tags = reportOptions.tags ?? {};
        const key = [
          reportOptions.latchKey ?? Object.entries(tags).map(([tagKey, value]) => `${tagKey}=${value}`).join(','),
          errorNameOf(error),
          errorCodeOf(error) ?? '',
          firstFrameOf(error),
        ].join('|');
        if (reportedKeys.has(key)) {
          markReported(error);
          return false;
        }
        if (reportedKeys.size >= cap) return false;
        reportedKeys.add(key);
        sendHandledFailure(source, error, tags, reportOptions.contexts);
        return true;
      } catch {
        // A report must never break the path that called it.
        return false;
      }
    },
    reset() {
      reportedKeys.clear();
    },
  };
}
