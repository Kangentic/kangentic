/**
 * Reads a CLI's final output for a failure that is the user's own setup, for the
 * adapters' `identifyUserSetupFailure`. What this names stays out of Sentry and
 * gets no retry, so a wrong match hides a real bug. It therefore reads only whole
 * lines at the end of the output. A shell echoes the line it is typed, and that
 * line can hold a prompt quoting any of these sentences, and they appear all over
 * this repo for an agent working here to print. A pattern anchored on both ends
 * cannot match inside either.
 *
 * A failure no pattern names stays a report, because it may be a Kangentic bug.
 * Each adapter lists only its CLI's own measured sentences, and leaves out any
 * file Kangentic writes: a CLI refusing one of those is ours.
 */

import { readableTerminalText } from '../../../shared/ansi-strip';
import type { UserSetupMatch } from '../../../shared/user-configuration-error';

/** How much of the ring's tail to read: the failure is the CLI's last word. */
const TAIL_CHARACTERS = 20_000;
/** The lines that count. A shell's prompt and a blank line can follow the failure. */
const FINAL_LINES = 12;

/** The last lines of the output, newest first, with escapes and blank lines gone. */
export function finalLinesOf(finalOutput: string): string[] {
  return readableTerminalText(finalOutput.slice(-TAIL_CHARACTERS))
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-FINAL_LINES)
    .reverse();
}

/** Each pattern is anchored at both ends, so it can only match a whole line. */
export function identifyLoginFailure(finalOutput: string, sentences: readonly RegExp[]): UserSetupMatch | null {
  const line = finalLinesOf(finalOutput).find((candidate) => sentences.some((sentence) => sentence.test(candidate)));
  return line === undefined ? null : { failure: 'login_required', line };
}
