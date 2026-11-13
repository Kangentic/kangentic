import { init as sentryInit, captureException } from '@sentry/electron/renderer';
import { filterBreadcrumb } from '../shared/sentry-breadcrumbs';
import { SENTRY_DATA_COLLECTION } from '../shared/sentry-data-collection';
import { diagnosticContextOf, errorNameOf, pathFreeCopy } from '../shared/handled-error-copy';
import { IPC_REJECTION_PREFIX_PATTERN } from '../shared/ipc-rejection';

/**
 * Renderer half of Sentry error reporting. The renderer SDK has NO network
 * path of its own: every event it captures is forwarded to the main process
 * over the SDK's internal IPC and leaves through main's transport, so the
 * documented invariant that all telemetry egress happens in the main process
 * holds with this initialized (docs/telemetry/error-reporting.md).
 *
 * Init is gated on `analytics.errorReportingEnabled`, a synchronous boot value
 * preload reads from additionalArguments that mirrors main's single decision
 * (KANGENTIC_TELEMETRY / KANGENTIC_ERROR_REPORTING / packaged, plus a DSN
 * actually being configured) - so the renderer can never initialize when main
 * did not. Everything else is inherited from the main process, per the SDK
 * docs, except two options this process applies before it forwards anything.
 * `beforeBreadcrumb`: main receives renderer crumbs through the SDK's scope
 * forwarding and adds them with `scope.addBreadcrumb`
 * (@sentry/electron/esm/main/ipc.js, handleScope), which never calls main's
 * hook, so the renderer runs the shared policy itself. And `dataCollection`:
 * the browser client reads its own copy, `userInfo` included, which decides
 * whether Sentry infers the sender's IP address.
 */
export function initRendererErrorReporting(): void {
  if (!window.electronAPI?.analytics?.errorReportingEnabled) return;
  try {
    sentryInit({ beforeBreadcrumb: filterBreadcrumb, dataCollection: SENTRY_DATA_COLLECTION });
  } catch (error) {
    console.error('[ANALYTICS] Failed to initialize renderer error reporting:', error);
  }
}

/** Named context blocks for a handled report, the same shape main's reportHandledError takes. */
export type RendererErrorContexts = Record<string, Record<string, unknown>>;

/**
 * What a boundary says about itself: `boundary` (`root`, `panel` or `diff`) and,
 * for a panel, its English `panel` name. Short enums, never content.
 */
export type BoundaryReportTags = { boundary: 'root' | 'panel' | 'diff'; panel?: string };

/** A boundary that can describe itself to `reportCaughtRenderError`. */
interface ReportingBoundary {
  boundaryReportTags(): BoundaryReportTags;
}

function isReportingBoundary(value: unknown): value is ReportingBoundary {
  return typeof (value as Partial<ReportingBoundary> | null | undefined)?.boundaryReportTags === 'function';
}

/** The longest component stack kept, in characters. */
const MAX_COMPONENT_STACK_CHARACTERS = 4000;

/**
 * Report an error an error boundary caught, from the root's `onCaughtError`
 * (`index.tsx`), the one place React hands over every boundary's catch along with
 * the boundary itself. Boundary-caught errors never reach the SDK's global
 * handlers (React swallows them).
 *
 * The event is a path-free copy (`Handled render failure: <Name>` with the
 * original frames), tagged with the boundary and panel, with the component stack
 * in `contexts`. Grouping is Sentry's default, on the frames.
 *
 * Passing `onCaughtError` replaces React's own `console.error` of the error, so
 * the caller logs it.
 */
export function reportCaughtRenderError(
  error: unknown,
  errorInfo: { componentStack?: string; errorBoundary?: unknown },
): void {
  try {
    const boundaryTags = isReportingBoundary(errorInfo.errorBoundary)
      ? errorInfo.errorBoundary.boundaryReportTags()
      : { boundary: 'unknown' };
    const tags: Record<string, string> = { ...boundaryTags, source: 'react_boundary', error_name: errorNameOf(error) };
    const contexts: RendererErrorContexts = { ...diagnosticContextOf(error) };
    if (errorInfo.componentStack) {
      contexts.react = { componentStack: errorInfo.componentStack.slice(0, MAX_COMPONENT_STACK_CHARACTERS) };
    }
    captureException(pathFreeCopy('render', error), { tags, contexts });
  } catch {
    // Error reporting must never cascade into the boundary's own render path.
  }
}

/** The most distinct `area:op:name` keys the renderer reports in a run. */
const MAX_RENDERER_FAILURE_KEYS = 25;

// Pattern A (hmr-patterns.md): the once-per-key latch survives a Fast Refresh,
// or every dev save would re-arm each failure.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const reportedRendererFailures: Set<string> = import.meta.hot?.data?.reportedRendererFailures ?? new Set<string>();
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => { data.reportedRendererFailures = reportedRendererFailures; });
}

/** True for a rejection the renderer should not report itself. */
function isRendererExpectedFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  // A rejected IPC call: main's wrap saw it, and reported it if it was a defect.
  if (IPC_REJECTION_PREFIX_PATTERN.test(error.message)) return true;
  // The renderer's own network: offline, a server down.
  if (error instanceof TypeError && /^(Failed to fetch|NetworkError|Load failed)/.test(error.message)) return true;
  return false;
}

/**
 * Report a failure the renderer caught and recovered from: a board that did not
 * load, a card that did not open, a terminal replay that failed. `area` and `op`
 * are short fixed words (`board`, `load`), never a title or a path; they are tags
 * and the fingerprint (`['renderer', area, op, <ErrorName>]`), since the renderer's
 * areas are a small known set. The event is a path-free copy. `contexts` hold
 * fixed facts only.
 *
 * Skipped: aborts, the renderer's own network, and any rejected IPC call, because
 * main's wrap reported that one with main's stack. Each `area:op:name` reports
 * once per run, at most 25 of them. Never throws.
 */
export function reportRendererFailure(
  area: string,
  op: string,
  error: unknown,
  contexts: RendererErrorContexts = {},
): boolean {
  try {
    if (isRendererExpectedFailure(error)) return false;
    const name = errorNameOf(error);
    const key = `${area}:${op}:${name}`;
    if (reportedRendererFailures.has(key) || reportedRendererFailures.size >= MAX_RENDERER_FAILURE_KEYS) return false;
    reportedRendererFailures.add(key);
    reportHandledRendererError(
      pathFreeCopy(`${area}_${op}`, error),
      { source: 'renderer', area, op, error_name: name },
      { ...diagnosticContextOf(error), ...contexts },
      ['renderer', area, op, name],
    );
    return true;
  } catch {
    return false;
  }
}

/** Test-only: forget what this run reported. */
export function resetRendererFailureReports(): void {
  reportedRendererFailures.clear();
}

/**
 * Report an error the renderer CAUGHT and recovered from, with tags for
 * grouping and contexts for diagnosis. The renderer counterpart of main's
 * reportHandledError (src/main/analytics/error-reporting.ts): tags hold short
 * enum-like values and never content, and the diagnosis goes in `contexts`,
 * which Sentry shows as named blocks and never groups on. captureException
 * marks the event handled. Like reportBoundaryError it is a safe no-op when
 * the SDK did not initialize, and it never throws, because its callers sit in
 * catch blocks of their own.
 */
export function reportHandledRendererError(
  error: unknown,
  tags: Record<string, string>,
  contexts: RendererErrorContexts,
  fingerprint?: string[],
): void {
  try {
    captureException(error, fingerprint ? { tags, contexts, fingerprint } : { tags, contexts });
  } catch {
    // Error reporting must never cascade into the failing path itself.
  }
}
