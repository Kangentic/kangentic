import { isBenignRendererError } from '../shared/benign-renderer-errors';
import type { RendererErrorContexts } from './error-reporting';

/**
 * The handler monacoConfig.ts installs on monaco's error funnel
 * (errorHandler.unexpectedErrorHandler). Kept free of monaco and Sentry
 * imports so unit tests and the Playwright helpers can load it; the installer
 * injects both the real default handler and the reporter.
 *
 * Monaco routes every error it CATCHES through that funnel, and its default
 * handler rethrows the error from its own `setTimeout(..., 0)`
 * (vs/base/common/errors.js). Sentry DESKTOP-19 ("Illegal value for
 * lineNumber") is thrown in the original editor's scroll listener
 * (viewModelImpl.js, `viewLayout.onDidScroll`), and `Emitter._deliver`
 * (event.js) calls this funnel synchronously, while the editor is still in the
 * state that threw. This funnel reports it as a handled error with the live
 * diff state and the call-site stack, and does not attempt a fix. How to read
 * those reports: .claude/skills/sentry/SKILL.md, the `mechanism` bullet.
 *
 * What a user loses was read from monaco 0.56.0's source, not measured. The
 * throw aborts the rest of that listener, not one call. The scroll position is
 * already committed, but for that tick the tokenizer's visible-lines hint, the
 * viewport-start invalidation, the original pane's view scroll event, and the
 * original editor's public onDidScrollChange are all skipped. The diff editor's
 * own `_originalScrollTop` observable (diffEditorViewZones.js) is one of those
 * listeners, so it stays stale until the original editor scrolls again. Most
 * likely nothing visible, or a one-tick stale paint. Reporting instead of
 * rethrowing changes none of this, because monaco had already caught the error.
 */

/** Prefix of the console line logged for a handled report. tests/ui/helpers.ts collects it. */
export const MONACO_HANDLED_ERROR_LOG_TAG = '[MONACO]';

const LINE_NUMBER_ERROR_MESSAGE = 'Illegal value for lineNumber';

/** Deep enough to reach the task entry point under monaco's event and observable chains. */
const CALL_SITE_STACK_LIMIT = 200;

/**
 * At most one report per this window. An editor stuck in the throwing state
 * throws on every scroll tick, and the first report of a burst is the
 * diagnostic one. The rest are counted into the next report rather than each
 * paying for a stack capture, the snapshot reads, and a Sentry event.
 */
export const HANDLED_REPORT_INTERVAL_MS = 30_000;

/**
 * One diff viewer's state at the moment of a throw, in flat primitives only.
 * Sentry normalizes contexts three levels deep, so a nested object would
 * arrive as "[Object]".
 */
export type DiffViewerSnapshot = Record<string, string | number | boolean | null>;

/** Returns the viewer's snapshot, or null while it has no live editor (binary file, markdown preview). */
export type DiffViewerSnapshotReader = () => DiffViewerSnapshot | null;

export type ReportHandledError = (
  error: unknown,
  tags: Record<string, string>,
  contexts: RendererErrorContexts,
) => void;

// hmr-safe: one reader per mounted DiffViewer. A Set, not a single ref, because two task
// windows can both show Changes. No Pattern A preservation is needed. Editing
// this module re-executes DiffViewer.tsx (a refresh boundary that imports it),
// Fast Refresh re-runs its registration effect into the new Set, and
// monacoConfig.ts re-installs the handler against the new module. That last
// step holds only while monacoConfig.ts stays non-accepting, so a funnel edit
// reaches it on the way to the ChangesPanel.tsx boundary. If it ever
// self-accepts, the installed handler keeps the old Set and dev snapshots go
// empty.
const snapshotReaders = new Set<DiffViewerSnapshotReader>();

/** Register a mounted DiffViewer's snapshot reader. Returns the unregister. */
export function registerDiffViewerSnapshotReader(reader: DiffViewerSnapshotReader): () => void {
  snapshotReaders.add(reader);
  return () => {
    snapshotReaders.delete(reader);
  };
}

/**
 * True for DESKTOP-19's error as monaco hands it to the funnel: the raw
 * BugIndicatingError, before the default handler appends a stack to its
 * message. BugIndicatingError does not set `name`, so the message is the only
 * stable discriminator.
 */
export function isMonacoLineNumberError(error: unknown): error is Error {
  return error instanceof Error && error.message === LINE_NUMBER_ERROR_MESSAGE;
}

/**
 * Keep only what follows a location's last path separator, minus a dev-server
 * query string (`?v=...`). Cutting at the separator rather than at whitespace
 * is what keeps a home directory with a space in its name from leaking a
 * fragment of that name.
 */
function lastPathSegment(location: string): string {
  const lastSeparator = Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\'));
  const basename = lastSeparator === -1 ? location : location.slice(lastSeparator + 1);
  return basename.replace(/\?[^:]*/, '');
}

/**
 * V8's eval location, `eval at <fn> (<origin>), <position>`, where the origin
 * can itself be an eval location. Matched explicitly rather than by the
 * innermost parenthesized group, because a directory name can hold parens
 * too (`Program Files (x86)`).
 */
const EVAL_LOCATION = /^eval at (.+?) \((.*)\), ([^()]*)$/;

function toLocationBasename(location: string): string {
  const evalLocation = EVAL_LOCATION.exec(location);
  if (evalLocation) {
    return `eval at ${evalLocation[1]} (${toLocationBasename(evalLocation[2])}), ${lastPathSegment(evalLocation[3])}`;
  }
  return lastPathSegment(location);
}

/**
 * One frame, `fn (location)` or a bare `location`. The location is the LAST
 * parenthesized group, found by matching from the end, because an eval
 * frame's location nests a second group inside it.
 */
function reduceFrameLocation(frame: string): string {
  if (frame.endsWith(')')) {
    let depth = 0;
    for (let index = frame.length - 1; index >= 0; index--) {
      if (frame[index] === ')') {
        depth++;
      } else if (frame[index] === '(') {
        depth--;
        if (depth === 0) {
          return `${frame.slice(0, index)}(${toLocationBasename(frame.slice(index + 1, -1))})`;
        }
      }
    }
  }
  return toLocationBasename(frame);
}

function toCallSiteFrame(frame: string): string {
  const reduced = reduceFrameLocation(frame);
  // The privacy guarantee does not rest on the parsing above. A frame that
  // still holds a path separator (an unbalanced paren in a directory name, a
  // frame shape V8 adds later) is cut to its last segment, losing the
  // function name rather than leaking a directory.
  return /[\\/]/.test(reduced) ? lastPathSegment(frame) : reduced;
}

/**
 * Reduce a V8 stack to its frame lines, each with its location cut to the file
 * basename. A production location is a file:// URL under the user's home
 * directory, and the SDK's path normalization covers exception frames but not
 * `contexts`, so the directory never leaves the machine.
 */
export function toCallSiteFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;
    frames.push(toCallSiteFrame(trimmed.slice(3)));
  }
  return frames;
}

/**
 * The stack of whoever called the funnel, which runs inside the throw's own
 * call stack. V8 keeps 50 frames when an error is constructed (Sentry sets
 * Error.stackTraceLimit to 50), so the original error lost its outer frames:
 * the timer, frame callback, or app call that started the scroll. Capturing
 * here with a higher limit recovers them.
 */
export function captureCallSiteFrames(): string[] {
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = CALL_SITE_STACK_LIMIT;
    return toCallSiteFrames(new Error().stack);
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDiffViewerSnapshots(): DiffViewerSnapshot[] {
  const snapshots: DiffViewerSnapshot[] = [];
  for (const reader of snapshotReaders) {
    try {
      const snapshot = reader();
      if (snapshot !== null) snapshots.push(snapshot);
    } catch (readError) {
      snapshots.push({ snapshot_error: messageOf(readError) });
    }
  }
  return snapshots;
}

function hideUnchangedRegionsTag(snapshots: DiffViewerSnapshot[]): string {
  if (snapshots.some((snapshot) => snapshot.hide_unchanged_regions === true)) return 'true';
  if (snapshots.some((snapshot) => snapshot.hide_unchanged_regions === false)) return 'false';
  return 'unknown';
}

interface MonacoErrorFunnelOptions {
  /** monaco's own default handler, which rethrows on a timer. */
  defaultHandler: (error: unknown) => void;
  reportHandled: ReportHandledError;
}

/**
 * Build the funnel handler. A known-benign error is swallowed, DESKTOP-19's
 * error is reported as handled and not rethrown, and every other error goes to
 * monaco's default unchanged, so no genuine error is masked.
 */
export function createMonacoUnexpectedErrorHandler({
  defaultHandler,
  reportHandled,
}: MonacoErrorFunnelOptions): (error: unknown) => void {
  // Re-entrancy guard: a snapshot read that makes monaco funnel another
  // lineNumber error sends that one down the default path instead of recursing.
  let reporting = false;
  // Rate limit (HANDLED_REPORT_INTERVAL_MS). The window starts at a successful
  // report, so a failed one never silences the next.
  let lastReportedAt: number | null = null;
  let suppressedSinceLastReport = 0;
  return (error: unknown) => {
    if (isBenignRendererError(error)) return;
    if (!isMonacoLineNumberError(error) || reporting) {
      defaultHandler(error);
      return;
    }
    // A negative elapsed time means the wall clock stepped back. Treat it as an
    // expired window, or a backward step would mute reports for its full size.
    const elapsedSinceReport = lastReportedAt === null ? null : Date.now() - lastReportedAt;
    if (elapsedSinceReport !== null && elapsedSinceReport >= 0 && elapsedSinceReport < HANDLED_REPORT_INTERVAL_MS) {
      // Still handled, never rethrown. The window's first report covers it.
      suppressedSinceLastReport++;
      return;
    }
    reporting = true;
    let reported = false;
    try {
      // First, before anything else deepens the stack.
      const frames = captureCallSiteFrames();
      const snapshots = readDiffViewerSnapshots();
      const contexts: RendererErrorContexts = {
        call_site: { frames },
        // How many throws the rate limit absorbed since the previous report.
        funnel: { suppressed_since_last_report: suppressedSinceLastReport },
      };
      snapshots.forEach((snapshot, index) => {
        contexts[`diff_viewer_${index + 1}`] = snapshot;
      });
      reportHandled(
        error,
        {
          source: 'monaco_line_number',
          hide_unchanged_regions: hideUnchangedRegionsTag(snapshots),
          diff_viewers_live: String(snapshots.length),
        },
        contexts,
      );
      reported = true;
      lastReportedAt = Date.now();
      suppressedSinceLastReport = 0;
      // The contexts ride along so a dev session (where Sentry is usually off)
      // still sees the diagnosis.
      console.error(MONACO_HANDLED_ERROR_LOG_TAG, `${LINE_NUMBER_ERROR_MESSAGE}, reported as handled`, error, contexts);
    } catch {
      // This runs inside monaco's own catch block, so a throw here would escape
      // into the scroll that fired it. Hand an unreported error to the default
      // instead, so it is never lost. A reported one stays handled: the default
      // would rethrow it and Sentry would count the incident twice.
      if (!reported) defaultHandler(error);
    } finally {
      reporting = false;
    }
  };
}
