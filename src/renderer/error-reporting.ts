import { init as sentryInit, captureException } from '@sentry/electron/renderer';

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
 * did not. Options stay empty per the SDK docs: renderer config is inherited
 * from the main process.
 */
export function initRendererErrorReporting(): void {
  if (!window.electronAPI?.analytics?.errorReportingEnabled) return;
  try {
    sentryInit();
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
