import { initialize as aptabaseInit, trackEvent as aptabaseTrack } from '@aptabase/electron/main';

const APTABASE_APP_KEY = 'A-US-7825295071';

let enabled = false;

/**
 * Determine whether analytics should be enabled.
 *
 * - KANGENTIC_TELEMETRY=0 or false  --> always off (opt-out)
 * - KANGENTIC_TELEMETRY=1 or true   --> always on (force-enable in dev)
 * - unset                           --> on in all builds (dev events tagged isDebug)
 *
 * The SDK tags dev-mode events with isDebug=true so they are
 * filterable in the Aptabase dashboard.
 */
function shouldEnable(): boolean {
  const telemetryEnv = process.env.KANGENTIC_TELEMETRY;
  if (telemetryEnv === '0' || telemetryEnv === 'false') return false;
  if (telemetryEnv === '1' || telemetryEnv === 'true') return true;
  return true;
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
    console.error('Failed to initialize analytics:', error);
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
  aptabaseTrack(eventName, props).catch(() => {
    // Silently ignore tracking failures -- analytics should never disrupt the app
  });
}
