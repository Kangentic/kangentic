import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';

/**
 * Sentry DSN for the Kangentic desktop project (kangentic.sentry.io, project
 * `desktop`). A DSN is a public routing identifier by design (like
 * APTABASE_APP_KEY in analytics.ts), not a secret. An empty string would make
 * initErrorReporting() a no-op and keep the renderer flag off, so the wiring
 * ships inert if this is ever cleared.
 */
const SENTRY_DSN =
  'https://6368bfbd74782d122cb321b26799bddd@o4511808143556608.ingest.us.sentry.io/4511996066660352';

let active = false;

/**
 * Decide whether Sentry error reporting should be enabled, as a pure function
 * of the two env switches and the packaged state.
 *
 * The contract (docs/analytics.md):
 * - KANGENTIC_TELEMETRY=0/false is the superset kill switch: it disables ALL
 *   telemetry egress, Aptabase and Sentry both. Users who set it were promised
 *   "disables analytics entirely" before Sentry existed; that promise holds.
 * - KANGENTIC_ERROR_REPORTING=0/false disables Sentry alone (Aptabase unaffected).
 * - KANGENTIC_ERROR_REPORTING=1/true force-enables Sentry (e.g. in dev), unless
 *   the superset kill switch is set.
 * - Unset inherits the analytics default: KANGENTIC_TELEMETRY=1/true forces on,
 *   otherwise on in packaged builds only.
 */
export function resolveErrorReportingEnabled(
  telemetryValue: string | undefined,
  errorReportingValue: string | undefined,
  isPackaged: boolean
): boolean {
  if (telemetryValue === '0' || telemetryValue === 'false') return false;
  if (errorReportingValue === '0' || errorReportingValue === 'false') return false;
  if (errorReportingValue === '1' || errorReportingValue === 'true') return true;
  if (telemetryValue === '1' || telemetryValue === 'true') return true;
  return isPackaged;
}

/**
 * Whether Sentry actually initialized this run. Read by createWindow to pass
 * the --kangentic-error-reporting flag to the renderer, which gates the
 * renderer-side Sentry.init() on the same single decision made here.
 */
export function isErrorReportingActive(): boolean {
  return active;
}

/**
 * Attach the anonymous, non-reversible install id (the same clientId
 * analytics attaches to app_launch - see analytics/client-id.ts) as the
 * Sentry user id. This is what makes the per-issue "Users" count real
 * (how many installs an issue affects), with no new data class: the id is
 * already disclosed in docs/analytics.md and contains no personal data.
 */
export function setErrorReportingUser(clientId: string): void {
  if (!active) return;
  try {
    Sentry.setUser({ id: clientId });
  } catch {
    // Never disrupt startup for telemetry
  }
}

/**
 * Forward a HANDLED error to Sentry with its real stack. The SDK's global
 * handlers only see UNCAUGHT errors, so the deliberate catch sites that today
 * emit only a sanitized app_error count (updater structural failures, PTY
 * spawn failures, the silent agent-spawn catches) would stay invisible as
 * diagnosable issues - exactly the "hidden issue" class error reporting
 * exists for. Tags are for grouping/filtering; never put content in them.
 */
export function reportHandledError(error: unknown, tags: Record<string, string> = {}): void {
  if (!active) return;
  try {
    Sentry.withScope((scope) => {
      for (const [tagKey, tagValue] of Object.entries(tags)) scope.setTag(tagKey, tagValue);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  } catch {
    // Error reporting must never cascade into the failing path itself
  }
}

/**
 * Initialize Sentry error reporting. Must be called BEFORE app.whenReady(),
 * next to initAnalytics() (the SDK wires its renderer IPC/protocol transport
 * during init).
 *
 * Scrubbing is deliberately Sentry's job, not ours: the SDK's default
 * normalizePathsIntegration rewrites stack-frame paths and URLs relative to
 * the app root (so the user's home directory never reaches Sentry for app
 * code), sendDefaultPii stays false, and Sentry's server-side data scrubbing
 * is on by default. Any further rule belongs in the Sentry UI (Advanced Data
 * Scrubbing), not in a custom beforeSend here.
 *
 * Errors only: release-health session tracking (the MainProcessSession
 * integration, on by default) is filtered out, and tracing/replay are never
 * enabled. Aptabase's app_error stays as the coarse error-rate pulse on the
 * product dashboard; Sentry is the diagnostic tool.
 */
export function initErrorReporting(): void {
  if (!SENTRY_DSN) return;
  if (
    !resolveErrorReportingEnabled(
      process.env.KANGENTIC_TELEMETRY,
      process.env.KANGENTIC_ERROR_REPORTING,
      app.isPackaged
    )
  ) {
    return;
  }

  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      sendDefaultPii: false,
      integrations: (defaultIntegrations) =>
        defaultIntegrations.filter(
          (integration) => integration.name !== 'MainProcessSession'
        ),
      // The known-benign Windows `npm start` TTY write artifacts that
      // index.ts's isSuppressibleUncaughtError filters for Aptabase. Sentry's
      // own global handlers would otherwise report them as crashes.
      ignoreErrors: ['write EAGAIN', 'write EPIPE'],
    });
    active = true;
  } catch (error) {
    console.error('[ANALYTICS] Failed to initialize error reporting:', error);
    active = false;
  }
}
