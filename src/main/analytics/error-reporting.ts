import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { isUserConfigurationError } from '../../shared/user-configuration-error';
import { BENIGN_RENDERER_ERRORS } from '../../shared/benign-renderer-errors';

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
 *
 * User-configuration errors are the one class deliberately excluded. A missing
 * agent CLI (AgentCliNotFoundError) is the user's environment, not a defect we
 * can ship a fix for, so it is un-actionable as an issue: it is surfaced in the
 * app instead, and its Aptabase counter still fires so the volume view ("how
 * often are users hitting this") survives. The check lives HERE rather than at
 * each catch site because such an error must skip only the Sentry half, whereas
 * the neighbouring isAbortError guards must skip the analytics counter too.
 * Every current and future call site inherits the exclusion.
 */
export function reportHandledError(error: unknown, tags: Record<string, string> = {}): void {
  if (!active) return;
  if (isUserConfigurationError(error)) return;
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
 * SCRUBBING is deliberately Sentry's job, not ours: the SDK's default
 * normalizePathsIntegration rewrites stack-frame paths and URLs relative to
 * the app root (so the user's home directory never reaches Sentry for app
 * code), sendDefaultPii stays false, and Sentry's server-side data scrubbing
 * is on by default. Any further scrubbing rule belongs in the Sentry UI
 * (Advanced Data Scrubbing), not in a custom beforeSend here.
 *
 * FILTERING is a separate concern and does live here, in `ignoreErrors`:
 * deciding that a whole class of event is un-actionable and should never become
 * an issue is a product judgement about our own code, not a data-privacy rule.
 * See the annotated entries below.
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
      // Noise filtering, which is a different concern from the scrubbing above:
      // these are real events we deliberately do not want as issues, not data
      // we need removed from events we do keep.
      ignoreErrors: [
        // The known-benign Windows `npm start` TTY write artifacts that
        // index.ts's isSuppressibleUncaughtError filters for Aptabase. Sentry's
        // own global handlers would otherwise report them as crashes.
        'write EAGAIN',
        'write EPIPE',
        // The SDK's own childProcessIntegration captures every utility-process
        // exit as `'Utility' process exited with '<reason>'`, tagged only with
        // the process TYPE - it attaches serviceName/name/exitCode to a
        // breadcrumb AFTER the capture, so the event can never say WHICH
        // process died and no beforeSend can recover it. Electron's own
        // utility processes (network, audio, storage) are un-actionable for us,
        // and our two (kangentic-embeddings, kangentic-line-count) now report
        // themselves from their own exit handlers, where the service name,
        // exit code, and crash count are all known. Scoped to 'Utility'
        // deliberately: the same SDK integration reports renderer crashes as
        // `'renderer' process exited with ...` through the same code path, and
        // those must keep reporting. The breadcrumb survives this filter, so an
        // Electron-internal utility crash still shows as context on later events.
        /'Utility' process exited with/,
        // Renderer errors that are known-benign and outside our control. Shared
        // with the monaco error funnel (monacoConfig.ts) and the UI-test
        // collector (tests/ui/helpers.ts) so one registry drives all three.
        // Renderer events reach this filter: the SDK re-captures them through
        // main's client (@sentry/electron/main/ipc.js captureEventFromRenderer),
        // so main's event processors run on them.
        ...BENIGN_RENDERER_ERRORS,
      ],
    });
    active = true;
  } catch (error) {
    console.error('[ANALYTICS] Failed to initialize error reporting:', error);
    active = false;
  }
}
