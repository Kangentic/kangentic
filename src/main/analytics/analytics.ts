import { app } from 'electron';
import { initialize as aptabaseInit, trackEvent as aptabaseTrack } from '@aptabase/electron/main';

const APTABASE_APP_KEY = 'A-US-7825295071';

let enabled = false;

/** Properties merged into every subsequent tracked event. Currently just the
 *  anonymous client id (see setAnalyticsClientId) - a plain object is fine
 *  since it is only ever populated once, at startup. */
const sharedProps: Record<string, string | number | boolean> = {};

/**
 * Attach the anonymous client id to every subsequent tracked event. Called
 * once at startup (see analytics/client-id.ts) so events can be rolled up
 * into a unique-installs count ourselves. Aptabase's own identity model
 * rotates daily and cannot do this.
 */
export function setAnalyticsClientId(clientId: string): void {
  sharedProps.clientId = clientId;
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
  aptabaseInit(APTABASE_APP_KEY).catch((error) => {
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
  aptabaseTrack(eventName, { ...sharedProps, ...props }).catch(() => {
    // Silently ignore tracking failures -- analytics should never disrupt the app
  });
}

/**
 * Strip file paths from error messages to avoid leaking PII (usernames in paths).
 * Truncates to 200 chars.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[A-Z]:\\[^\s:;,)]+/gi, '<path>')       // Windows paths: C:\Users\...
    .replace(/\/(?:home|Users|tmp|var|etc|root|opt)\/[^\s:;,)]+/g, '<path>') // Unix paths
    .slice(0, 200);
}

/**
 * Track an event and return its delivery promise. Use this when the caller
 * needs to await delivery (e.g. during shutdown) rather than fire-and-forget.
 */
export function trackEventAsync(
  eventName: string,
  props?: Record<string, string | number | boolean>
): Promise<void> {
  if (!enabled) return Promise.resolve();
  return aptabaseTrack(eventName, { ...sharedProps, ...props }).catch(() => {});
}
