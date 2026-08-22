import { app } from 'electron';
import { initialize as aptabaseInit, trackEvent as aptabaseTrack } from '@aptabase/electron/main';

const APTABASE_APP_KEY = 'A-US-7825295071';

let enabled = false;

/** The anonymous client id (see setAnalyticsClientId). Attached only to the
 *  `app_launch` event, not merged into every event - see getAnalyticsClientId. */
let analyticsClientId: string | undefined;

/**
 * Record the anonymous client id, resolved once at startup (see
 * analytics/client-id.ts). Read it back with getAnalyticsClientId and attach
 * it explicitly to app_launch, the one authoritative per-launch install
 * signal, so unique installs can be rolled up ourselves as
 * COUNT(DISTINCT clientId) over that event. Aptabase's own identity model
 * rotates daily and cannot do this; it is deliberately NOT merged into every
 * event, to avoid inflating high-cardinality string-prop volume on events
 * (like app_heartbeat) where it adds no install-counting value.
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
  aptabaseTrack(eventName, props ?? {}).catch(() => {
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
 * Aptabase truncates a string property at 180 characters server-side (appending
 * "..."), so anything longer is silently lost. Cap locally at the same length so
 * what we send is what lands.
 */
export const MAX_ANALYTICS_STRING_LENGTH = 180;

/**
 * Reduce a React componentStack to a PII-free trail of component names,
 * innermost first (e.g. "BrowserPane < WindowContent < App").
 *
 * The raw stack is NOT sent. A production frame reads
 * `at BrowserPane (file:///C:/Users/dev/.../index-abc.js:1:2)`, so it carries the
 * user's home directory in a URL form that sanitizeErrorMessage only partly
 * catches. Keeping just the identifier after `at` / `in` is PII-free by
 * construction rather than by pattern-matching.
 *
 * KNOW THIS BEFORE RELYING ON THE OUTPUT: React derives frame names from
 * `fn.name`, and the production renderer bundle is minified with name mangling,
 * so a packaged build yields mangled names ("t < Yn < Ao") rather than readable
 * ones. Since telemetry is gated on `app.isPackaged`, that is the ONLY build this
 * ever runs in. The value is still real (mangled names are stable within a build,
 * so distinct trails mean distinct code paths, and a matching build's sourcemap
 * resolves them) but it is not human-readable on arrival. `boundary` and `panel`
 * are the fields that read directly, because a string literal and a prop both
 * survive minification. Making this readable would need name preservation turned
 * on for the renderer build, which is a bundle-size tradeoff, not a free switch.
 */
export function summarizeComponentStack(
  stack: string | null | undefined,
  maxFrames = 6
): string {
  if (!stack) return '';
  const names: string[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*(?:at|in)\s+([A-Za-z0-9_$.]+)/.exec(line);
    if (!match) continue;
    names.push(match[1]);
    if (names.length >= maxFrames) break;
  }
  return names.join(' < ').slice(0, MAX_ANALYTICS_STRING_LENGTH);
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
  return aptabaseTrack(eventName, props ?? {}).catch(() => {});
}
