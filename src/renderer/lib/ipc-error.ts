/**
 * Electron decorates a rejected `ipcRenderer.invoke` before the renderer sees
 * it, so `err.message` arrives as:
 *
 *   Error invoking remote method 'task:move': BranchCheckoutBlockedError: Cannot switch branches in ...
 *
 * Toasting that verbatim shows the user a channel name and a TypeScript class
 * name in front of the sentence written for them. This strips the decoration and
 * returns the message the main process actually authored.
 */

/** `Error invoking remote method '<channel>': ` */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/;

/**
 * A leading `SomeError: `, including a bare `Error: `. Only stripped when the
 * name ends in `Error`, so a legitimate message that happens to contain a colon,
 * such as a drive letter or `fatal: ...` from git, is left alone.
 */
const ERROR_CLASS_PREFIX = /^(?:[A-Z][A-Za-z0-9_$]*)?Error:\s*/;

/**
 * The user-facing text of a failed IPC call. Falls back to a generic string for
 * a non-Error rejection so callers never interpolate `undefined`.
 */
export function describeIpcError(error: unknown, fallback = 'Unknown error'): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  const withoutChannel = error.message.replace(REMOTE_METHOD_PREFIX, '');
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
export function asSentence(reason: string | null | undefined, fallback = 'No reason was given.'): string {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) return fallback;
  const capitalized = capitalizeFirstWord(trimmed);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
