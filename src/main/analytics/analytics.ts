import { app, net } from 'electron';
import { initialize as aptabaseInit, trackEvent as aptabaseTrack } from '@aptabase/electron/main';

/**
 * The production app key. `KANGENTIC_APTABASE_APP_KEY` overrides it so a local
 * run can point the whole event stream at a throwaway sink instead of the
 * production project: the SDK picks its host from the key's middle segment,
 * and an `A-DEV-<digits>` key routes to http://localhost:3000. That is the
 * verification rig for anything in the quit path or the once-per-run events
 * (scripts/aptabase-sink.mjs; docs/telemetry/usage-analytics.md, "Local verification"). An
 * env var rather than a source edit, so the rig never needs a change that
 * could be committed by accident.
 */
const DEFAULT_APTABASE_APP_KEY = 'A-US-7825295071';

function resolveAppKey(): string {
  const override = process.env.KANGENTIC_APTABASE_APP_KEY?.trim();
  return override ? override : DEFAULT_APTABASE_APP_KEY;
}

let enabled = false;

/** The anonymous client id (see setAnalyticsClientId). Attached explicitly to
 *  the three install-counting events, not merged into every event - see
 *  getAnalyticsClientId. */
let analyticsClientId: string | undefined;

/**
 * Record the anonymous client id, resolved once at startup (see
 * analytics/client-id.ts). Read it back with getAnalyticsClientId and attach
 * it explicitly to the events that count installs: app_launch, the one
 * authoritative per-launch install signal (unique installs roll up as
 * COUNT(DISTINCT clientId) over it), and the two lifetime-once events,
 * feature_first_use and onboarding_milestone, where it turns "N first uses"
 * into "N installs reached this step" at negligible cost because each fires
 * at most once per install for all time. Aptabase's own identity model
 * rotates daily and cannot do this. It is deliberately NOT merged into every
 * event, to avoid inflating high-cardinality string-prop volume on events
 * (like app_heartbeat or the daily feature_used) where it adds no
 * install-counting value.
 */
export function setAnalyticsClientId(clientId: string): void {
  analyticsClientId = clientId;
}

/** Read back the anonymous client id set by setAnalyticsClientId. */
export function getAnalyticsClientId(): string | undefined {
  return analyticsClientId;
}

/**
 * Determine whether an app_heartbeat should be emitted. Skips pure-idle
 * heartbeats (no active sessions) to keep the dominant event under the
 * Aptabase free-tier event budget and to make measured duration reflect
 * active work rather than app-open-idle time.
 */
export function shouldEmitHeartbeat(counts: { active: number }): boolean {
  return counts.active > 0;
}

/**
 * Period of the app_heartbeat interval: 55 minutes, deliberately INSIDE the
 * SDK's session window rather than at it. @aptabase/electron starts a new
 * session id when the gap since the previous event exceeds 3600 whole seconds
 * (`Math.floor(gapMs / 1000) > 3600`), so an interval of exactly 60 minutes
 * sits on that boundary and a timer that fires one second late would open a
 * fresh dashboard session on every heartbeat. The lateness that matters on
 * this main process is a stall (sync git, SQLite, a migration), not timer
 * jitter, so the margin is sized in minutes, not seconds.
 *
 * Widened from 30 minutes on purpose and never to be shortened for "better
 * usage data": the heartbeat SAMPLES session counts that session_spawn and
 * session_exit already record exactly, so its one job is drift correction
 * after a lost exit event, which needs no finer resolution. At 30 minutes it
 * was 35% of all event volume. Run duration comes from app_launch's
 * previous-run properties (run-uptime.ts), not from here.
 */
export const HEARTBEAT_INTERVAL_MS = 55 * 60_000;

/**
 * Determine whether analytics should be enabled.
 *
 * - KANGENTIC_TELEMETRY=0 or false  --> always off (opt-out)
 * - KANGENTIC_TELEMETRY=1 or true   --> always on (force-enable in dev)
 * - unset                           --> on in packaged builds only (dev is off)
 */
function shouldEnable(): boolean {
  const telemetryEnv = process.env.KANGENTIC_TELEMETRY;
  if (telemetryEnv === '0' || telemetryEnv === 'false') return false;
  if (telemetryEnv === '1' || telemetryEnv === 'true') return true;
  return app.isPackaged;
}

/**
 * The host the SDK posts to, by the middle segment of the app key. A key with
 * another segment sends nothing to any of these. Self-hosted (`SH`) is absent
 * because the SDK needs a host option for it and this app passes none. The
 * unit test holds this table to the SDK's own.
 */
const APTABASE_HOST_BY_REGION: Readonly<Record<string, string>> = {
  US: 'us.aptabase.com',
  EU: 'eu.aptabase.com',
  DEV: 'localhost:3000',
};

/** The `host:port` of a string or `{ url }` request, or null for any other
 *  shape. Sentry's transport and electron-updater name a request by `hostname`,
 *  and neither is ever Aptabase. Never throws: every `net.request` in main
 *  comes through here. */
function requestHost(options: Parameters<typeof net.request>[0]): string | null {
  const url = typeof options === 'string' ? options : options.url;
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Give every response from the Aptabase host an `error` listener (DESKTOP-26).
 *
 * @aptabase/electron 0.3.1 listens for `error` and `abort` on the request and
 * attaches nothing to the response. When a request fails after its headers,
 * Electron runs `this._response.destroy(error)` and then `this._die(error)`.
 * IncomingMessage is a Readable, so that destroy throws with no listener, and
 * a dropped analytics POST reaches `uncaughtException` and reads as a fatal.
 *
 * The listener is empty because the failure is already handled. `_die` goes on
 * to fire the request's `error`, which the SDK logs and resolves on.
 *
 * Scoped to one host on purpose. Every other caller of `net.request` gets its
 * request back untouched, so a real response failure elsewhere stays loud.
 * tests/unit/aptabase-response-guard.test.ts fails once the SDK adds its own
 * listener, which is the signal to delete this.
 *
 * @internal Exported for testing.
 */
export function guardAptabaseResponses(netModule: Pick<typeof net, 'request'>, host: string): void {
  const originalRequest = netModule.request;
  netModule.request = function requestWithResponseGuard(this: unknown, ...requestArguments) {
    const request = originalRequest.apply(this, requestArguments);
    if (requestHost(requestArguments[0]) === host) {
      request.once('response', (response) => {
        response.on('error', () => {});
      });
    }
    return request;
  };
}

let responseGuardInstalled = false;

/**
 * Initialize anonymous analytics. Must be called BEFORE app.whenReady().
 * The SDK registers protocol schemes synchronously during this call.
 */
export function initAnalytics(): void {
  if (!shouldEnable()) return;
  enabled = true;

  // Before the SDK can send anything, and before initErrorReporting, so Sentry's
  // own net.request wrapper goes on the outside and sees the same request. The
  // SDK reads net.request at each call, so this assignment reaches it.
  const appKey = resolveAppKey();
  const aptabaseHost = APTABASE_HOST_BY_REGION[appKey.split('-')[1]];
  if (aptabaseHost && !responseGuardInstalled) {
    guardAptabaseResponses(net, aptabaseHost);
    responseGuardInstalled = true;
  }

  // Fire-and-forget: the SDK internally queues any trackEvent calls
  // made before initialization completes, then flushes them once ready.
  aptabaseInit(appKey).catch((error) => {
    console.error('[ANALYTICS] Failed to initialize analytics:', error);
    enabled = false;
  });
}

/**
 * Track an anonymous event. No-op if analytics is disabled.
 * Events sent before the SDK finishes initializing are queued
 * internally by the SDK and flushed once ready.
 */
export function trackEvent(eventName: string, props?: Record<string, string | number | boolean>): void {
  if (!enabled) return;
  aptabaseTrack(eventName, props ?? {}).catch(() => {
    // Silently ignore tracking failures -- analytics should never disrupt the app
  });
}

/**
 * Strip file paths from error messages to avoid leaking PII (usernames in paths).
 * Truncates to MAX_ANALYTICS_STRING_LENGTH (180), matching Aptabase's
 * server-side cap so what we send is what lands (a 200-char local cap
 * previously let messages 180-200 chars long be silently cut server-side).
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[A-Z]:\\[^\s:;,)]+/gi, '<path>')       // Windows paths: C:\Users\...
    .replace(/\/(?:home|Users|tmp|var|etc|root|opt)\/[^\s:;,)]+/g, '<path>') // Unix paths
    .slice(0, MAX_ANALYTICS_STRING_LENGTH);
}

/**
 * Aptabase truncates a string property at 180 characters server-side (appending
 * "..."), so anything longer is silently lost. Cap locally at the same length so
 * what we send is what lands.
 */
export const MAX_ANALYTICS_STRING_LENGTH = 180;
