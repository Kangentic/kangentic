/**
 * Electron decorates a rejected `ipcRenderer.invoke` before the renderer sees
 * it, so `err.message` arrives as:
 *
 *   Error invoking remote method 'task:move': BranchCheckoutBlockedError: Cannot switch branches in ...
 *
 * Toasting that verbatim shows the user a channel name and a TypeScript class
 * name in front of the sentence written for them. This strips the decoration and
 * returns the message the main process actually authored.
 *
 * Only the two fallbacks are this module's own words, so only they translate.
 * The reasons main writes arrive in English and stay as written.
 */
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { hasReportedFailureMarker, withoutReportedFailureMarker } from '../../shared/reported-failure-marker';

/** `Error invoking remote method '<channel>': ` */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/;

/**
 * What a class name looks like: it ends in `Error`, and a bare `Error` counts.
 * Both patterns below are built from it, so they cannot disagree about a name.
 */
const ERROR_CLASS = '(?:[A-Z][A-Za-z0-9_$]*)?Error';

/**
 * A leading `SomeError: `, including a bare `Error: `. Only stripped when the
 * name ends in `Error`, so a legitimate message that happens to contain a colon,
 * such as a drive letter or `fatal: ...` from git, is left alone.
 */
const ERROR_CLASS_PREFIX = new RegExp(`^${ERROR_CLASS}:\\s*`);

/**
 * The class name in front of the message, once the channel prefix is gone. It
 * asks for the space Electron writes after the colon, which stripping does not:
 * a caller acts on this name, so it has to be a class and not text shaped like one.
 */
const ERROR_CLASS_NAME = new RegExp(`^(${ERROR_CLASS}):\\s`);

/**
 * The rejection's text with the channel prefix and main's reported marker gone,
 * or null when there is none to read.
 */
function messageWithoutChannel(error: unknown): string | null {
  if (!(error instanceof Error) || !error.message) return null;
  return withoutReportedFailureMarker(error.message.replace(REMOTE_METHOD_PREFIX, ''));
}

/**
 * A caught error's own text, exactly as it arrived but without main's reported
 * marker, or `String(error)` for a non-Error. For a site that shows or matches the
 * raw text of a rejected call rather than `describeIpcError`'s cleaned reason.
 */
export function rejectionMessage(error: unknown): string {
  return error instanceof Error ? withoutReportedFailureMarker(error.message) : String(error);
}

/**
 * True when main reported this rejected call's failure to Sentry in this run: its
 * IPC handler wrap marks the rejection (`REPORTED_FAILURE_MARKER`). False for a
 * refusal, an expected failure, a capped key, error reporting off, and any
 * rejection that is not an Error.
 */
export function ipcErrorWasReported(error: unknown): boolean {
  return error instanceof Error && hasReportedFailureMarker(error.message);
}

/**
 * The body and reported flag of a failure toast for a rejected IPC call. Spread it
 * into `addToast` so the toast draws its "reported" line whenever main sent the
 * report: `addToast({ title, ...ipcFailureToastFields(error), variant: 'error' })`.
 * `reasonFallback` is `describeIpcError`'s fallback and `sentenceFallback` is
 * `asSentence`'s, so the body reads exactly as
 * `asSentence(describeIpcError(error, reasonFallback), sentenceFallback)`.
 */
export function ipcFailureToastFields(
  error: unknown,
  reasonFallback?: string,
  sentenceFallback?: string,
): { message: string; reported: boolean } {
  return {
    message: asSentence(describeIpcError(error, reasonFallback), sentenceFallback),
    reported: ipcErrorWasReported(error),
  };
}

/**
 * The class main threw, as Electron leaves it in the rejection, or null when the
 * rejection names none. For a caller that acts on WHAT failed and not on its
 * wording: Add Source opens Connect for a `SignInRefusedError`, whatever line the
 * provider wrote. A message that only looks like a class (`fatal: ...`) is not one.
 */
export function ipcErrorClassName(error: unknown): string | null {
  const withoutChannel = messageWithoutChannel(error);
  if (withoutChannel === null) return null;
  return ERROR_CLASS_NAME.exec(withoutChannel)?.[1] ?? null;
}

/**
 * The user-facing text of a failed IPC call. Falls back to a generic string for
 * a non-Error rejection so callers never interpolate `undefined`.
 */
export function describeIpcError(error: unknown, fallback = i18n._(msg`Unknown error`)): string {
  const withoutChannel = messageWithoutChannel(error);
  if (withoutChannel === null) return fallback;
  const withoutClass = withoutChannel.replace(ERROR_CLASS_PREFIX, '');
  return withoutClass.trim() || fallback;
}

/** A leading word of lowercase letters only, so `fatal:` is capitalized and `kangentic.json` is not. */
const LOWERCASE_FIRST_WORD = /^[a-z]+(?=[\s,:;]|$)/;

/**
 * Error text in sentence case, and otherwise exactly as written: a leading
 * lowercase word gets its capital, and a path, a file name or a word already
 * capitalized stays as it is. No stop is added, so the text still matches the
 * error a search would find.
 */
export function capitalizeFirstWord(text: string): string {
  return text.replace(LOWERCASE_FIRST_WORD, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

/**
 * A reason as a toast body: one sentence that starts with a capital and ends in
 * a stop. Error text arrives in every shape (git's `fatal: ...`, a message with
 * no period, one that already ends in `?`), and a toast body reads as a
 * sentence whichever it was. An empty reason gives `fallback`.
 */
export function asSentence(reason: string | null | undefined, fallback = i18n._(msg`No reason was given.`)): string {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) return fallback;
  const capitalized = capitalizeFirstWord(trimmed);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
