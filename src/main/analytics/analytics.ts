import { app } from 'electron';
import { initialize as aptabaseInit, trackEvent as aptabaseTrack } from '@aptabase/electron/main';

/**
 * The production app key. `KANGENTIC_APTABASE_APP_KEY` overrides it so a local
 * run can point the whole event stream at a throwaway sink instead of the
 * production project: the SDK picks its host from the key's middle segment,
 * and an `A-DEV-<digits>` key routes to http://localhost:3000. That is the
 * verification rig for anything in the quit path or the once-per-run events
 * (scripts/aptabase-sink.mjs; docs/analytics.md, "Local verification"). An
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
 * Initialize anonymous analytics. Must be called BEFORE app.whenReady().
 * The SDK registers protocol schemes synchronously during this call.
 */
export function initAnalytics(): void {
  if (!shouldEnable()) return;
  enabled = true;

  // Fire-and-forget: the SDK internally queues any trackEvent calls
  // made before initialization completes, then flushes them once ready.
  aptabaseInit(resolveAppKey()).catch((error) => {
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
