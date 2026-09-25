import { init as sentryInit, captureException } from '@sentry/electron/renderer';
import { filterBreadcrumb } from '../shared/sentry-breadcrumbs';

/**
 * Renderer half of Sentry error reporting. The renderer SDK has NO network
 * path of its own: every event it captures is forwarded to the main process
 * over the SDK's internal IPC and leaves through main's transport, so the
 * documented invariant that all telemetry egress happens in the main process
 * holds with this initialized (docs/analytics.md).
 *
 * Init is gated on `analytics.errorReportingEnabled`, a synchronous boot value
 * preload reads from additionalArguments that mirrors main's single decision
 * (KANGENTIC_TELEMETRY / KANGENTIC_ERROR_REPORTING / packaged, plus a DSN
 * actually being configured) - so the renderer can never initialize when main
 * did not. Everything else is inherited from the main process, per the SDK
 * docs, except `beforeBreadcrumb`. Main receives renderer crumbs through the
 * SDK's scope forwarding and adds them with `scope.addBreadcrumb`
 * (@sentry/electron/esm/main/ipc.js, handleScope), which never calls main's
 * hook. So the renderer runs the shared policy itself, before it forwards.
 */
export function initRendererErrorReporting(): void {
  if (!window.electronAPI?.analytics?.errorReportingEnabled) return;
  try {
    sentryInit({ beforeBreadcrumb: filterBreadcrumb });
  } catch (error) {
    console.error('[ANALYTICS] Failed to initialize renderer error reporting:', error);
  }
}

/**
 * Report an error a React error boundary caught. Boundary-caught errors never
 * reach the SDK's global handlers (React swallows them), so the boundaries
 * hand them over explicitly. captureException is a safe no-op when the SDK
 * did not initialize, so call sites need no gate of their own. The existing
 * trackRendererError IPC funnel stays alongside this: Aptabase keeps the
 * coarse app_error pulse, Sentry gets the real stack.
 */
export function reportBoundaryError(error: unknown): void {
  try {
    captureException(error);
  } catch {
    // Error reporting must never cascade into the boundary's own render path.
  }
}
