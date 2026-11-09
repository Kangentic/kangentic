/**
 * Cut a failed CI step's log down to what an agent needs to fix it.
 *
 * GitHub Actions and Azure Pipelines both mark an error with a `##[error]`
 * logging command (Actions inherited the syntax from Pipelines), and both end a
 * failed step with runner cleanup after the last one. So the useful part of a
 * failed log is the run of lines ending at its LAST `##[error]` line: the
 * compiler or test output just above it, never the cleanup below it. A log with
 * no error marker is kept whole up to the cap.
 *
 * Each connector passes its own platform's line-prefix strip (GitHub's
 * `job<TAB>step<TAB>` columns, then the timestamp both runners print), so this
 * module never sees a platform string beyond the shared `##[...]` commands and
 * the runner timestamp.
 */

import { stripAnsiControlCodes } from '../../../shared/ansi-strip';

/** Prefixed to a tail that had to drop lines from its start to fit the cap. */
export const EARLIER_LINES_CUT = '[earlier lines cut]';

const ERROR_COMMAND = '##[error]';
/** Grouping commands carry no content an agent can act on. */
const GROUP_COMMAND = /^##\[(?:group|endgroup)\]/;
/**
 * How much of a raw log is split into lines at all. A tail is a few thousand
 * characters, and a whole job log can reach tens of MB, so only this window
 * ending at the last error line is processed.
 */
const RAW_LOG_WINDOW_CHARS = 1_000_000;

/**
 * One runner log line without its byte-order mark and leading ISO timestamp.
 * Actions and Pipelines both print `<timestamp> <text>`.
 */
export function stripLogTimestamp(line: string): string {
  return line.replace(/^\uFEFF/, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '');
}

/**
 * The part of `raw` worth splitting: everything when it is small, else the
 * last `RAW_LOG_WINDOW_CHARS` before the end of the last error line (or of the
 * log), starting on a whole line.
 */
function lastErrorWindow(raw: string): string {
  if (raw.length <= RAW_LOG_WINDOW_CHARS) return raw;
  const errorAt = raw.lastIndexOf(ERROR_COMMAND);
  const lineBreak = errorAt === -1 ? -1 : raw.indexOf('\n', errorAt);
  const end = errorAt === -1 || lineBreak === -1 ? raw.length : lineBreak;
  const start = end - RAW_LOG_WINDOW_CHARS;
  if (start <= 0) return raw.slice(0, end);
  const firstBreak = raw.indexOf('\n', start);
  return raw.slice(firstBreak === -1 || firstBreak >= end ? start : firstBreak + 1, end);
}

/**
 * A raw log's tail for the agent: split, each line's platform prefix removed
 * by `stripPrefix`, then cut by {@link tailToLastError}.
 */
export function tailRawLog(raw: string, stripPrefix: (line: string) => string, maxChars: number): string {
  return tailToLastError(lastErrorWindow(raw).split(/\r?\n/).map(stripPrefix), maxChars);
}

/**
 * The tail of `lines` that ends at the last `##[error]` line, at most
 * `maxChars` long, cut on a line boundary and ANSI free. Returns an empty
 * string for an empty log.
 */
export function tailToLastError(lines: readonly string[], maxChars: number): string {
  const kept = lines
    .map((line) => stripAnsiControlCodes(line).replace(/\s+$/, ''))
    .filter((line) => !GROUP_COMMAND.test(line));
  let end = kept.length;
  for (let index = kept.length - 1; index >= 0; index--) {
    if (kept[index].includes(ERROR_COMMAND)) {
      end = index + 1;
      break;
    }
  }
  const relevant = kept.slice(0, end);
  while (relevant.length > 0 && relevant[relevant.length - 1] === '') relevant.pop();

  const tail: string[] = [];
  let length = 0;
  for (let index = relevant.length - 1; index >= 0; index--) {
    const added = relevant[index].length + (tail.length > 0 ? 1 : 0);
    if (length + added > maxChars) break;
    tail.unshift(relevant[index]);
    length += added;
  }
  if (tail.length === relevant.length) return tail.join('\n');
  // Make room for the marker, dropping more lines from the start if needed.
  const marker = EARLIER_LINES_CUT.length + 1;
  while (tail.length > 0 && length + marker > maxChars) {
    length -= tail[0].length + (tail.length > 1 ? 1 : 0);
    tail.shift();
  }
  if (tail.length === 0) {
    // Not even the last line fits beside the marker: keep that line's start,
    // where an error line names its file and message.
    const room = maxChars - marker;
    if (room <= 0) return '';
    return [EARLIER_LINES_CUT, relevant[relevant.length - 1].slice(0, room)].join('\n');
  }
  return [EARLIER_LINES_CUT, ...tail].join('\n');
}
