/**
 * The copy of an error that a handled report sends, shared by main
 * (`src/main/analytics/handled-report.ts`) and the renderer
 * (`src/renderer/error-reporting.ts`), so both send the same shape.
 *
 * An error's message is never sent. In this codebase it holds paths, branch
 * names, task and workflow titles, org and repo names, and search queries. The
 * copy is `Handled <source> failure: <Name>`, keeps the name, and keeps the
 * original frames. A `TypeError`, `RangeError` or `ReferenceError` message is the
 * runtime's own sentence, so it may go in `contexts`, paths removed and cut to 200
 * characters. Never a `SyntaxError`'s: `JSON.parse` quotes its input.
 */

import { redactPaths } from './sentry-breadcrumbs';

/** A class name: `TypeError`, `HttpError`. A slug or a sentence cannot pass. */
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
/** An errno or code constant: `ENOENT`, `SQLITE_BUSY`, `ERR_STREAM_DESTROYED`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The longest built-in error message kept in `contexts`. */
export const MAX_DIAGNOSTIC_MESSAGE_CHARACTERS = 200;

/** Built-in classes whose message is a fixed sentence the runtime wrote, never user data. */
const DIAGNOSTIC_MESSAGE_NAMES: ReadonlySet<string> = new Set(['TypeError', 'RangeError', 'ReferenceError']);

/** Named context blocks, the shape both processes' reporters take. */
export type HandledErrorContexts = Record<string, Record<string, unknown>>;

/** The error's `name` when it is a class name, else `Error`; `NonError` for a thrown non-Error. */
export function errorNameOf(error: unknown): string {
  if (!(error instanceof Error)) return 'NonError';
  return ERROR_NAME.test(error.name) ? error.name : 'Error';
}

/** The error's `code` when it is a constant (`ENOENT`, `SQLITE_BUSY`), else undefined. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/** True for a runtime error whose message may go in `contexts`. */
export function hasDiagnosticMessage(error: unknown): boolean {
  return error instanceof Error && DIAGNOSTIC_MESSAGE_NAMES.has(error.name);
}

/** The original stack's frames, from the first `at` line, or '' when it has none. */
export function framesOf(stack: string | undefined): string {
  if (typeof stack !== 'string') return '';
  const firstFrame = stack.search(/\n\s+at /);
  return firstFrame === -1 ? '' : stack.slice(firstFrame);
}

/**
 * A copy of `error` that carries no user content: `Handled <source> failure: <Name>`,
 * the same `name`, and the original frames. The frames are cut at the first `at`
 * line, so a multi-line message (a path on its second line) never rides along in
 * the stack's header.
 */
export function pathFreeCopy(source: string, error: unknown): Error {
  const name = errorNameOf(error);
  const copy = new Error(`Handled ${source} failure: ${name}`);
  copy.name = name;
  const frames = framesOf(error instanceof Error ? error.stack : undefined);
  copy.stack = `${name}: ${copy.message}${frames || framesOf(copy.stack)}`;
  return copy;
}

/** The runtime's own message for a built-in error, as a context, or nothing. */
export function diagnosticContextOf(error: unknown): HandledErrorContexts {
  if (!(error instanceof Error) || !hasDiagnosticMessage(error)) return {};
  return { error_detail: { message: redactPaths(error.message).slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARACTERS) } };
}
