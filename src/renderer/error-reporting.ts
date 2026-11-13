import { init as sentryInit, captureException } from '@sentry/electron/renderer';
import { filterBreadcrumb } from '../shared/sentry-breadcrumbs';
import { SENTRY_DATA_COLLECTION } from '../shared/sentry-data-collection';
import { diagnosticContextOf, errorNameOf, pathFreeCopy } from '../shared/handled-error-copy';
import { setRendererFailureSink } from './utils/renderer-failure';

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
    // `reportRendererFailure` (utils/renderer-failure.ts) sends through this
    // module only once the SDK is up; its callers import no SDK themselves.
    setRendererFailureSink(reportHandledRendererError);
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
